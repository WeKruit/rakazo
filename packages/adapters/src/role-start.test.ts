import { describe, expect, it, vi } from "vitest";
import {
  roleAlreadyOpenedHere,
  roleGroupId,
  roleOpenedFromLatestMessage,
  roleStartKey,
  startRoleFromRecruiterMessage,
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
        message: { findMany: vi.fn(async () => (source ? [source].flat() : [])) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
  };
}

const run = { spaceId: "s", userId: "u", threadId: "t-global", sourceMessageId: "m-1" };
const role = { threadId: "t-role", botId: "bot-main", deliveryKey: "k" };

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

  it("hands over the earlier message with the JD when the latest only says to go on (staging 2026-11-26, stop-then-continue)", async () => {
    const mine = { role: "user", botId: null, clientNonce: null, externalTranscriptFor: null };
    const { deps: d, tx } = deps([
      { ...mine, id: "m-2", blocks: [{ kind: "text", text: "继续吧" }] },
      { ...mine, id: "m-1", blocks: [{ kind: "text", text: "高级数据工程师，上海，5 年以上" }] },
      { ...mine, id: "m-0", blocks: [{ kind: "text", text: "你好" }] },
    ]);
    expect(
      await startRoleFromRecruiterMessage(d as never, run, { ...role, earlierMessages: 1 }),
    ).toBe(true);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: "高级数据工程师，上海，5 年以上\n继续吧" }),
      }),
    );
  });

  it("names the role when the message asks for several at once (simulated 2026-11-16, honest-limits)", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "所以到底有没有？没有就直接帮我建这三个" }],
    });
    expect(
      await startRoleFromRecruiterMessage(d as never, run, { ...role, title: "Data Engineer" }),
    ).toBe(true);
    const prompt = (
      tx.task.create.mock.calls as unknown as [{ data: { prompt: string } }][]
    )[0]?.[0].data.prompt as string;
    expect(prompt.split("\n")[0]).toContain("Data Engineer");
    expect(prompt).toContain("所以到底有没有？没有就直接帮我建这三个");
  });

  it("names the role when the message lists every role by name (simulated 2026-11-16, push-back)", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "那帮我现在建，Java、Android、data engineer 三个" }],
    });
    await startRoleFromRecruiterMessage(d as never, run, { ...role, title: "Java" });
    const prompt = (
      tx.task.create.mock.calls as unknown as [{ data: { prompt: string } }][]
    )[0]?.[0].data.prompt as string;
    const [first] = prompt.split("\n");
    expect(first).toContain("Java");
    expect(first).not.toContain("Android");
    expect(prompt).toContain("那帮我现在建，Java、Android、data engineer 三个");
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

describe("roleOpenedFromLatestMessage", () => {
  const prisma = {
    message: {
      findMany: vi.fn(async () => [
        {
          id: "m-recruiter",
          role: "user",
          botId: null,
          clientNonce: null,
          externalTranscriptFor: null,
          blocks: [{ kind: "text", text: "新岗位 Senior Data Engineer，first email写好发" }],
        },
      ]),
    },
  };

  it("knows the role start_role opened from this message already has it (staging 11-14)", async () => {
    // A follow-up turn delegated the same message again; two runs made two Send cards.
    const role = { groupId: roleGroupId("m-recruiter"), title: "Senior Data Engineer" };
    expect(await roleOpenedFromLatestMessage(prisma as never, "t-global", role)).toBe(true);
  });

  it("delegates to a role opened from an earlier message", async () => {
    const role = { groupId: roleGroupId("m-earlier"), title: "Senior Data Engineer" };
    expect(await roleOpenedFromLatestMessage(prisma as never, "t-global", role)).toBe(false);
  });
});

describe("roleAlreadyOpenedHere", () => {
  const message = (id: string, text: string) => ({
    id,
    role: "user",
    botId: null,
    clientNonce: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text }],
  });
  const feedback = message("m-feedback", "这三个不合适，下一批按这个改");
  const jd = message("m-jd", "新职位：Senior Data Engineer，上海");
  function prisma(groups: { id: string; name: string }[]) {
    return {
      message: { findMany: vi.fn(async () => [feedback, jd]) },
      chatGroup: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          groups.filter((group) => where.id.in.includes(group.id)),
        ),
      },
    };
  }
  const where = { spaceId: "s", userId: "u", threadId: "t-global" };

  it("finds the role an earlier message opened, so feedback goes to it (simulated 2026-11-20)", async () => {
    // Feedback on round one opened a second, empty "Senior Data Engineer" role, and the
    // turned-down people came back in it.
    const opened = { id: roleGroupId("m-jd"), name: "Senior Data Engineer（上海）" };
    expect(
      await roleAlreadyOpenedHere(prisma([opened]) as never, {
        ...where,
        title: "Senior Data Engineer｜上海",
      }),
    ).toEqual({ groupId: opened.id, title: opened.name });
  });

  it("opens a role with a different title", async () => {
    const opened = { id: roleGroupId("m-jd"), name: "Senior Data Engineer（上海）" };
    expect(
      await roleAlreadyOpenedHere(prisma([opened]) as never, {
        ...where,
        title: "Product Designer",
      }),
    ).toBeUndefined();
  });
});
