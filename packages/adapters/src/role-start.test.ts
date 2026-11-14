import { describe, expect, it, vi } from "vitest";
import { roleStartKey, startRoleFromRecruiterMessage, templateOnlyRequest } from "./role-start.js";

vi.mock("@rakazo/db", () => ({
  withTransactionRetry: (fn: () => unknown) => fn(),
  createThreadMessageInTransaction: vi.fn(async (_tx: unknown, input: { blocks: unknown }) => ({
    id: "msg-role",
    ...input,
  })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

function deps(source: unknown, already: unknown = null) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: { findUnique: vi.fn(async () => already) },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    run: { create: vi.fn(async () => ({ id: "run-1" })) },
  };
  return {
    tx,
    deps: {
      prisma: {
        message: { findMany: vi.fn(async () => (source ? [source] : [])) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
  };
}

const run = { spaceId: "s", userId: "u", threadId: "t-global", sourceMessageId: "m-1" };
const role = { threadId: "t-role", botId: "bot-main", deliveryKey: "k" };

describe("templateOnlyRequest", () => {
  it("keeps a template request in the chat unless it also asks to find people (simulated 2026-11-14)", () => {
    expect(
      templateOnlyRequest(
        "hiring a staff backend engineer, go, payments infra. NY hybrid, base 200-250k, series C fintech. write me a short first outreach email to candidates for it, and keep it as my template for later",
      ),
    ).toBe(true);
    expect(
      templateOnlyRequest(
        "staff backend engineer in NY: find me people and write an outreach template",
      ),
    ).toBe(false);
    expect(templateOnlyRequest("帮我找人：上海的高级后端，顺便写个邮件模板")).toBe(false);
    expect(templateOnlyRequest("Senior data engineer in Seattle, here is the JD")).toBe(false);
  });
});

describe("startRoleFromRecruiterMessage", () => {
  it("copies the recruiter's own words into the role and starts the lead's turn", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "text",
          text: "Open an agent engineer role",
          recruitingContext: { roleTitle: "Kruit" },
        },
      ],
    });
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-main",
          trigger: "user",
          sourceMessageId: "msg-role",
        }),
      }),
    );
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: "Open an agent engineer role" }),
      }),
    );
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("adds the requirements given earlier when the latest message is only a go-ahead", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "Start finding candidates now" }],
    });
    expect(
      await startRoleFromRecruiterMessage(d as never, run, {
        ...role,
        earlier: "Senior nurse, Austin TX, 5+ years ICU",
      }),
    ).toBe(true);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: expect.stringMatching(
            /^Start finding candidates now\n\n.*earlier.*\nSenior nurse, Austin TX, 5\+ years ICU$/s,
          ),
        }),
      }),
    );
  });

  it("starts the role from a JD sent only as a file", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "file",
          name: "jd.docx",
          size: 10,
          mimeType: "application/msword",
          artifactId: "a1",
        },
      ],
    });
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prompt: "jd.docx" }) }),
    );
  });

  it("does not start twice for the same call", async () => {
    const { deps: d, tx } = deps(
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      { id: "msg-role" },
    );
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("uses the recruiter's latest message, skipping teammates' messages", async () => {
    const { deps: d, tx } = deps(null);
    d.prisma.message.findMany = vi.fn(async () => [
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "bot_message_received", text: "x" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "Open role 5" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "Open role 4" }],
      },
    ]) as never;
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prompt: "Open role 5" }) }),
    );
  });

  it("refuses a source the recruiter did not write", async () => {
    for (const source of [
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "bot_message_received", text: "x" }],
      },
      {
        role: "bot",
        botId: "b",
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: "autocontinue:1",
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      null,
    ]) {
      const { deps: d } = deps(source);
      expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(false);
    }
  });
});

describe("roleStartKey", () => {
  const asked = {
    id: "m-recruiter",
    role: "user",
    botId: null,
    clientNonce: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "新岗位 Senior Data Engineer，西雅图，ref 15351" }],
  };
  function prisma(existingName?: string) {
    return {
      message: { findMany: vi.fn(async () => [asked]) },
      chatGroup: {
        findFirst: vi.fn(async () => (existingName ? { name: existingName } : null)),
      },
    };
  }
  const where = { spaceId: "s", userId: "u", threadId: "t-global", fallback: "effect-1" };

  it("opens one role per recruiter message, whichever turn asks again (staging 11-14)", async () => {
    // A follow-up turn opened "Senior Data Engineer — Seattle" beside "Senior Data Engineer
    // Seattle" from the same message, and both teams emailed the same two people.
    const first = await roleStartKey(prisma() as never, {
      ...where,
      title: "Senior Data Engineer Seattle",
    });
    const again = await roleStartKey(prisma("Senior Data Engineer Seattle") as never, {
      ...where,
      title: "Senior Data Engineer — Seattle",
    });
    expect(first).toBe("m-recruiter");
    expect(again).toBe(first);
  });

  it("keeps a second, different role asked for in the same message", async () => {
    const other = await roleStartKey(prisma("Senior Data Engineer Seattle") as never, {
      ...where,
      title: "Product Designer",
    });
    expect(other).not.toBe("m-recruiter");
  });

  it("falls back to the call's own key without a recruiter message", async () => {
    const none = {
      message: { findMany: vi.fn(async () => []) },
      chatGroup: { findFirst: vi.fn(async () => null) },
    };
    expect(await roleStartKey(none as never, { ...where, title: "X" })).toBe("effect-1");
  });
});
