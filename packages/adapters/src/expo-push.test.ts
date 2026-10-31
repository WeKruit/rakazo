import { claimConversationNotification, recordDesktopActivity } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePushToken,
  ExpoPushProvider,
  endSessionPushToken,
  expoPushData,
  expoPushErrorMessage,
  loadPushToken,
  MAX_EXPO_PUSH_RESPONSE_BYTES,
  savePushToken,
} from "./expo-push.js";
import { memoryPushTokens } from "./expo-push-fake.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const notifyContext = {
  operationId: "n",
  traceId: "n",
  spaceId: "w",
  userId: "user-1",
  runId: "native-run",
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe("expo push tickets", () => {
  it("reads a single Expo ticket and a ticket array", () => {
    expect(expoPushErrorMessage({ data: { status: "ok", id: "1" } }, 200)).toBeUndefined();
    expect(expoPushErrorMessage({ data: { status: "error", message: "bad token" } }, 200)).toBe(
      "bad token",
    );
    expect(expoPushErrorMessage({ errors: [{ message: "rate limited" }] }, 429)).toBe(
      "rate limited",
    );
    expect(expoPushErrorMessage(undefined, 502)).toBe("expo push failed (502)");
    expect(
      expoPushErrorMessage(
        { data: { status: "error", details: { error: "DeviceNotRegistered" } } },
        200,
      ),
    ).toBe("DeviceNotRegistered");
  });
});

describe("expo push", () => {
  it("removes a registered token", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    await deletePushToken(dataDir, "user-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("moves a device token to the user who saves it last", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[device]", "session-1");
    await savePushToken(dataDir, "user-3", "ExponentPushToken[other]", "session-3");

    await savePushToken(dataDir, "user-2", "ExponentPushToken[device]", "session-2");

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBe("ExponentPushToken[device]");
    await expect(loadPushToken(dataDir, "user-3")).resolves.toBe("ExponentPushToken[other]");
  });

  it("removes a token only with the session that registered it", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");

    await endSessionPushToken(dataDir, "user-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");

    await endSessionPushToken(dataDir, "user-1", "session-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("moves a token to the session that replaces its own", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");

    await endSessionPushToken(dataDir, "user-1", "session-1", "session-2");
    await endSessionPushToken(dataDir, "user-1", "session-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");

    await endSessionPushToken(dataDir, "user-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not call Expo when the user has no token", async () => {
    const dataDir = memoryPushTokens();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      {
        operationId: "n",
        traceId: "n",
        spaceId: "w",
        userId: "missing",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(push.hasPushRecipient("missing")).resolves.toBe(false);
    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        {
          operationId: "n",
          traceId: "n",
          spaceId: "w",
          userId: "missing",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Expo when a token is registered", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      title: string;
      collapseId: string;
      tag: string;
      data: { kind: string; deliveryId: string };
    };
    expect(body.to).toBe("ExponentPushToken[test]");
    expect(body.title).toBe("Need you");
    expect(body).not.toHaveProperty("body");
    expect(JSON.stringify(body)).not.toContain("on screen");
    expect(body.collapseId).toBe("th-1");
    expect(body.tag).toBe("th-1");
    expect(body.data).toEqual({
      kind: "takeover",
      botId: "bot-1",
      threadId: "th-1",
      spaceId: "w",
      deliveryId: expect.any(String),
    });
    expect(body.data.deliveryId.length).toBeGreaterThan(0);

    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-2" },
      notifyContext,
    );
    const secondInit = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    const secondBody = JSON.parse(String(secondInit.body)) as { data: { deliveryId: string } };
    expect(secondBody.data.deliveryId).not.toBe(body.data.deliveryId);
  });

  it("shares the 15-minute conversation limit across workers, kinds and devices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = memoryPushTokens();
    await savePushToken(db, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      kind: "completion" as const,
      title: "Done",
      body: "Results",
      botId: "b",
      threadId: "t",
    };
    const first = new ExpoPushProvider(db);
    const second = new ExpoPushProvider(db);
    const deliveries = await Promise.all([
      first.deliver(message, notifyContext),
      second.deliver({ ...message, kind: "help" }, notifyContext),
    ]);
    expect(deliveries.sort()).toEqual(["delivered", "suppressed"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await claimConversationNotification(db, {
        ...notifyContext,
        threadId: "t",
        channel: "browser",
      }),
    ).toBeNull();
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(await second.deliver(message, notifyContext)).toBe("suppressed");
    vi.advanceTimersByTime(1);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    expect(
      await new ExpoPushProvider(db).deliver(message, { ...notifyContext, runId: "next-run" }),
    ).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("suppresses phone push during account-wide desktop activity without suppressing another account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = memoryPushTokens();
    await savePushToken(db, "user-1", "ExponentPushToken[first]");
    await savePushToken(db, "user-2", "ExponentPushToken[second]");
    await recordDesktopActivity(db, notifyContext);
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(db);
    const message = {
      kind: "completion" as const,
      title: "Done",
      body: "Results",
      botId: "b",
      threadId: "another-thread",
    };
    expect(await push.deliver(message, notifyContext)).toBe("suppressed");
    expect(await push.deliver(message, { ...notifyContext, userId: "user-2" })).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(90_000);
    expect(await push.deliver(message, notifyContext)).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a notification reservation for another account's conversation", async () => {
    const db = memoryPushTokens({
      threads: [{ id: "private", spaceId: "w", userId: "user-2", botId: "b" }],
    });
    await expect(
      claimConversationNotification(db, {
        ...notifyContext,
        threadId: "private",
        channel: "browser",
      }),
    ).rejects.toThrow("Resource not found");
  });

  it("never delivers a browser replay of the same event after the quiet window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = memoryPushTokens();
    const event = await db.$transaction((tx) =>
      tx.event.create({
        data: {
          threadId: "t",
          spaceId: "w",
          botId: "b",
          seq: 0,
          type: "thread.message.created",
          payload: { role: "bot", blocks: [] },
        },
      }),
    );
    const input = {
      ...notifyContext,
      threadId: "t",
      channel: "browser" as const,
      eventId: event.id,
    };
    expect(await claimConversationNotification(db, input)).toEqual(expect.any(String));
    vi.advanceTimersByTime(15 * 60_000);
    expect(await claimConversationNotification(db, input)).toBeNull();
  });

  it("dedupes a phone completion across provider restarts and browser replay beyond the quiet window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = memoryPushTokens({
      runs: [
        {
          id: "native-run",
          threadId: "t",
          spaceId: "w",
          userId: "user-1",
          status: "completed",
          updatedAt: new Date(),
        },
      ],
    });
    const reply = await db.$transaction(async (tx) => {
      const reply = await tx.event.create({
        data: {
          threadId: "t",
          spaceId: "w",
          botId: "b",
          runId: "native-run",
          seq: 1,
          type: "thread.message.created",
          payload: { role: "bot", blocks: [] },
        },
      });
      await tx.event.create({
        data: {
          threadId: "t",
          spaceId: "w",
          botId: "b",
          runId: "native-run",
          seq: 2,
          type: "run.completed",
          payload: {},
        },
      });
      return reply;
    });
    await savePushToken(db, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      kind: "completion" as const,
      title: "Done",
      body: "Private",
      botId: "b",
      threadId: "t",
    };
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("delivered");
    vi.advanceTimersByTime(16 * 60_000);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    expect(
      await claimConversationNotification(db, {
        ...notifyContext,
        threadId: "t",
        channel: "browser",
        eventId: reply.id,
      }),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("gives a second native question in the same run its own durable notification source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = memoryPushTokens({
      runs: [
        {
          id: "native-run",
          threadId: "t",
          spaceId: "w",
          userId: "user-1",
          status: "waiting_input",
          updatedAt: new Date(),
        },
      ],
    });
    const question = async (seq: number) =>
      db.$transaction(async (tx) => {
        await tx.event.create({
          data: {
            threadId: "t",
            spaceId: "w",
            botId: "b",
            runId: "native-run",
            seq,
            type: "thread.message.created",
            payload: {
              role: "bot",
              blocks: [{ kind: "ask", text: "Question", status: "pending" }],
            },
          },
        });
        await tx.event.create({
          data: {
            threadId: "t",
            spaceId: "w",
            botId: "b",
            runId: "native-run",
            seq: seq + 1,
            type: "run.waiting_input",
            payload: {},
          },
        });
      });
    await question(1);
    await savePushToken(db, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      kind: "help" as const,
      title: "Needs an answer",
      body: "Private",
      botId: "b",
      threadId: "t",
    };
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("delivered");
    vi.advanceTimersByTime(16 * 60_000);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    await question(3);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("delivered");
    vi.advanceTimersByTime(16 * 60_000);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch without an owned run and committed native notification source", async () => {
    const db = memoryPushTokens({
      runs: [
        {
          id: "native-run",
          threadId: "t",
          spaceId: "w",
          userId: "user-1",
          status: "completed",
          updatedAt: new Date(),
        },
      ],
    });
    await savePushToken(db, "user-1", "ExponentPushToken[test]");
    await savePushToken(db, "different-owner", "ExponentPushToken[other]");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      kind: "completion" as const,
      title: "Done",
      body: "Private",
      botId: "b",
      threadId: "t",
    };
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    expect(
      await new ExpoPushProvider(db).deliver(message, { ...notifyContext, runId: undefined }),
    ).toBe("suppressed");
    expect(
      await new ExpoPushProvider(db).deliver(message, {
        ...notifyContext,
        userId: "different-owner",
      }),
    ).toBe("suppressed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes a queued reminder by its authoritative native queue episode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const run = {
      id: "native-run",
      threadId: "t",
      spaceId: "w",
      userId: "user-1",
      status: "queued",
      updatedAt: new Date(),
    };
    const db = memoryPushTokens({ runs: [run] });
    await savePushToken(db, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      kind: "help" as const,
      title: "Still queued",
      body: "Private",
      botId: "b",
      threadId: "t",
    };
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("delivered");
    vi.advanceTimersByTime(16 * 60_000);
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("suppressed");
    run.updatedAt = new Date();
    expect(await new ExpoPushProvider(db).deliver(message, notifyContext)).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("puts the space and group on the payload a tap opens", () => {
    expect(
      expoPushData(
        {
          kind: "completion",
          title: "done",
          body: "ok",
          botId: "bot-1",
          threadId: "thread-1",
          groupId: "group-1",
        },
        "space-1",
        "delivery-1",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-1",
      groupId: "group-1",
      deliveryId: "delivery-1",
    });
    expect(
      expoPushData(
        { kind: "completion", title: "done", body: "ok", botId: "bot-1", threadId: "thread-1" },
        "",
        "delivery-2",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      deliveryId: "delivery-2",
    });
  });

  it("does not deliver a token whose session row is gone, and leaves it to be retargeted", async () => {
    const dataDir = memoryPushTokens();
    const token = "ExponentPushToken[test]";
    await savePushToken(dataDir, "user-1", token, "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, async () => null);

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe(token);
    await expect(push.hasPushRecipient("user-1")).resolves.toBe(false);

    await endSessionPushToken(dataDir, "user-1", "session-1", "session-2");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe(token);
    const replaced = new ExpoPushProvider(dataDir, async (sessionId) =>
      sessionId === "session-2" ? new Date(Date.now() + 60_000) : null,
    );
    await expect(replaced.hasPushRecipient("user-1")).resolves.toBe(true);
  });

  it("does not deliver a token whose session expiry has passed", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, async () => new Date(Date.now() - 1_000));

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not send a token another account claimed while the session was looked up", async () => {
    const dataDir = memoryPushTokens();
    const token = "ExponentPushToken[device]";
    await savePushToken(dataDir, "user-1", token, "session-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, async () => {
      waiting = true;
      await gate;
      return new Date(Date.now() + 60_000);
    });

    const delivering = push.deliver(
      { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
      notifyContext,
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    await savePushToken(dataDir, "user-2", token, "session-2");
    release();

    await expect(delivering).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    await expect(loadPushToken(dataDir, "user-2")).resolves.toBe(token);
  });

  it("delivers when the registering session is still live", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, async () => new Date(Date.now() + 60_000));

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not deliver a session-bound token when it cannot check the session", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("keeps the token when the session lookup fails", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir, async () => {
      throw new Error("database unavailable");
    });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("throws when Expo rejects the request", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "boom" }] }, 500)),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("boom");
  });

  it("gives the claim back when Expo fails, so the retry delivers", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "boom" }] }, 500))
      .mockResolvedValue(jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    const message = {
      kind: "completion" as const,
      title: "done",
      body: "ok",
      botId: "b",
      threadId: "t",
    };
    await expect(push.send(message, notifyContext)).rejects.toThrow("boom");
    await push.send(message, notifyContext);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects and cancels a declared oversized response", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait past cancellation when an oversized body cancel hangs", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise(() => undefined);
      },
    });
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
        });
      }),
    );

    const started = Date.now();
    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: abort.signal },
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a streamed response without a content length", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_EXPO_PUSH_RESPONSE_BYTES + 1))),
    );

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
  });

  it("rejects malformed successful responses", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push returned an invalid response.");
  });

  it("passes caller cancellation to the Expo request", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const controller = new AbortController();
    controller.abort(new Error("notification cancelled"));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: controller.signal },
      ),
    ).rejects.toThrow("notification cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when the Expo request never reaches the network", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("offline");
  });

  it("reports DeviceNotRegistered without deleting a stored or replacement token", async () => {
    const dataDir = memoryPushTokens();
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");
        return jsonResponse({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        });
      }),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("DeviceNotRegistered");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });
});
