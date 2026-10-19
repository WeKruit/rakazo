import { describe, expect, it, vi } from "vitest";
import {
  commitConsumedRunSecret,
  createRunSecretWriter,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveCompletedSecretLeftover,
  resolveMissingRunSecretAction,
  runSecretKind,
  secretPausedToolResult,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";

it("does not prepare a structured form response as a secret", async () => {
  const put = vi.fn();
  const writer = createRunSecretWriter({ put } as never);
  const prisma = {
    run: { findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }) },
    message: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ blocks: [{ kind: "ask", text: "Code", input: "secret" }] }),
    },
  };
  const commit = vi.fn().mockResolvedValue(false);
  expect(
    await writer.withPrepared!(
      prisma as never,
      {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "ask-1",
        answeredByUserId: "user-1",
        answer: { action: "cancel" },
      },
      commit,
    ),
  ).toBe(false);
  expect(put).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledOnce();
});

describe("runSecretKind", () => {
  it("scopes secrets to a single run", () => {
    expect(runSecretKind("run-1")).toBe("run-secret:run-1");
  });
});

describe("normalizeSecretAskPurpose", () => {
  it("keeps known purposes and defaults unknown ones to otp", () => {
    expect(normalizeSecretAskPurpose("api_key")).toBe("api_key");
    expect(normalizeSecretAskPurpose("password")).toBe("password");
    expect(normalizeSecretAskPurpose("other")).toBe("otp");
    expect(normalizeSecretAskPurpose("otp")).toBe("otp");
    expect(normalizeSecretAskPurpose(undefined)).toBe("otp");
  });
});

describe("secretPausedToolResult", () => {
  it("terminates the agent turn without exposing a value", () => {
    expect(secretPausedToolResult()).toMatchObject({
      terminate: true,
      details: { secret: "paused" },
    });
  });
});

describe("commitConsumedRunSecret", () => {
  it("deletes the stored secret before connector side effects, then persists", async () => {
    const order: string[] = [];
    const result = { ok: true, submitted: true };
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret: async () => {
          order.push("delete");
        },
        afterSecretTaken: async () => {
          order.push("side-effect");
          return result;
        },
        persist: async () => {
          order.push("persist");
          return true;
        },
        onPersistFailed,
      }),
    ).resolves.toBe(result);

    expect(order).toEqual(["delete", "side-effect", "persist"]);
  });

  it("does not keep the secret for a retry after side effects when persist fails", async () => {
    const deleteSecret = vi.fn();
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret,
        afterSecretTaken: async () => ({ ok: true, submitted: true }),
        persist: async () => false,
        onPersistFailed,
      }),
    ).resolves.toBe(onPersistFailed);

    expect(deleteSecret).toHaveBeenCalledOnce();
  });
});

describe("resolveCompletedSecretLeftover", () => {
  it("drops a leftover OTP created before the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:00:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("drop_leftover");
  });

  it("consumes a replacement OTP submitted after the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:01:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("consume_replacement");
  });
});

describe("resolveMissingRunSecretAction", () => {
  it("replays a completed effect instead of asking again after the secret was deleted", () => {
    const result = { ok: true, submitted: true, connected: true };
    expect(resolveMissingRunSecretAction({ status: "completed", result })).toEqual({
      action: "return",
      result,
    });
  });

  it("settles an in-flight attempt instead of re-asking for a consumed OTP", () => {
    expect(resolveMissingRunSecretAction({ status: "executing" })).toEqual({
      action: "settle_attempt",
    });
  });

  it("asks again when the effect is still waiting for input", () => {
    expect(resolveMissingRunSecretAction({ status: "intended" })).toEqual({ action: "ask" });
    expect(resolveMissingRunSecretAction(undefined)).toEqual({ action: "ask" });
  });
});

describe("reconcileManagedConnection", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("marks a pending connection connected when the provider is already ready", async () => {
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          status: "pending",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ connectionReady })),
    };

    await expect(
      reconcileManagedConnection(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
      ),
    ).resolves.toBe("connected");

    expect(connectionReady).toHaveBeenCalled();
    expect(prisma.connection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { status: "connected" },
    });
  });
});

describe("tryCompleteConnectionWithCode", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("forwards the code to a pending managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(prisma.connection.findFirst).toHaveBeenCalledWith({
      where: {
        id: "conn-1",
        spaceId: "workspace-1",
        userId: "user-1",
        status: { in: ["pending", "connected"] },
      },
    });
    expect(complete).toHaveBeenCalledWith({ state: "gmail-state", code: "123456" }, context);
    expect(prisma.connection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { status: "connected" },
    });
  });

  it("does not resubmit a code when the connection is already connected", async () => {
    const complete = vi.fn();
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "connected",
        }),
        update: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(complete).not.toHaveBeenCalled();
    expect(prisma.connection.update).not.toHaveBeenCalled();
  });

  it("returns a connector error instead of throwing", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("invalid code"));
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        update: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "bad",
      ),
    ).resolves.toEqual({ connected: false, error: "Connection could not be completed." });
  });
});
