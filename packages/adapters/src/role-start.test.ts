import { describe, expect, it, vi } from "vitest";
import {
  newRoleElsewhere,
  otherRefNamed,
  startRoleFromRecruiterMessage,
  templateOnlyRequest,
} from "./role-start.js";

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

// send-at-night 11-14: 「新岗位 … ref 0232 … 两个都发」 went to the only saved role, ref 0153.
describe("newRoleElsewhere", () => {
  const text = "新岗位 Senior Data Engineer，Seattle，ref 0232，写首封邮件，两个都发";
  it("names the new role's ref when the target role is another one", () => {
    expect(newRoleElsewhere(text, "Warehouse Manager (Ref 0153)")).toBe("0232");
    expect(newRoleElsewhere("New role: data engineer, ref #0232", "Ops lead")).toBe("0232");
  });
  it("lets work through to the role it names, or when no new role is named", () => {
    expect(newRoleElsewhere(text, "Senior Data Engineer Seattle (ref 0232)")).toBeUndefined();
    expect(newRoleElsewhere("ref 0232 怎么样了", "Warehouse Manager (Ref 0153)")).toBeUndefined();
    expect(newRoleElsewhere("新岗位 数据工程师 西雅图", "Warehouse Manager")).toBeUndefined();
  });
});

describe("otherRefNamed", () => {
  it("is the ref of the latest messages when the target role is another one", () => {
    const texts = [
      "Ada现在就发，别等到明晚",
      "新岗位 Senior Data Engineer Seattle ref 0303，两个都发",
    ];
    expect(otherRefNamed(texts, "Warehouse Manager (Ref 0153)")).toBe("0303");
    expect(otherRefNamed(texts, "Senior Data Engineer Seattle (ref 0303)")).toBeUndefined();
    expect(otherRefNamed(["Ada现在就发"], "Warehouse Manager")).toBeUndefined();
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
