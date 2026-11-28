import { createThreadMessageInTransaction } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyRecruiterMessageToRole,
  roleAlreadyOpenedHere,
  roleGroupId,
  roleOpenedFromLatestMessage,
  roleStartKey,
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
  };
  return {
    tx,
    deps: {
      prisma: {
        message: { findMany: vi.fn(async () => (source ? [source].flat() : [])) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      },
      events: { notify: vi.fn(async () => undefined) },
    },
  };
}

const run = { spaceId: "s", userId: "u", threadId: "t-global", sourceMessageId: "m-1" };
const role = { threadId: "t-role", botId: "bot-main", deliveryKey: "k" };
const mine = { role: "user", botId: null, clientNonce: null, externalTranscriptFor: null };
const copiedBlocks = () => vi.mocked(createThreadMessageInTransaction).mock.lastCall?.[1].blocks;

describe("copyRecruiterMessageToRole", () => {
  beforeEach(() => vi.mocked(createThreadMessageInTransaction).mockClear());

  it("copies the recruiter's own words into the role and returns the request", async () => {
    const { deps: d } = deps({
      ...mine,
      blocks: [
        {
          kind: "text",
          text: "Open an agent engineer role",
          recruitingContext: { roleTitle: "Kruit" },
        },
      ],
    });
    expect(await copyRecruiterMessageToRole(d as never, run, role)).toMatch(/message above/);
    // The global conversation's chat context does not belong to the new role.
    expect(copiedBlocks()).toEqual([{ kind: "text", text: "Open an agent engineer role" }]);
    expect(d.events.notify).toHaveBeenCalledWith("t-role", 7);
  });

  it("copies the earlier message with the JD when the latest only says to go on (staging 2026-11-26, stop-then-continue)", async () => {
    const { deps: d } = deps([
      { ...mine, id: "m-2", blocks: [{ kind: "text", text: "继续吧" }] },
      { ...mine, id: "m-1", blocks: [{ kind: "text", text: "高级数据工程师，上海，5 年以上" }] },
      { ...mine, id: "m-0", blocks: [{ kind: "text", text: "你好" }] },
    ]);
    await copyRecruiterMessageToRole(d as never, run, { ...role, earlierMessages: 1 });
    expect(copiedBlocks()).toEqual([
      { kind: "text", text: "高级数据工程师，上海，5 年以上" },
      { kind: "text", text: "继续吧" },
    ]);
  });

  it("names the role when the message asks for several at once (simulated 2026-11-16, honest-limits)", async () => {
    const { deps: d } = deps({
      ...mine,
      blocks: [{ kind: "text", text: "那帮我现在建，Java、Android、data engineer 三个" }],
    });
    const request = await copyRecruiterMessageToRole(d as never, run, { ...role, title: "Java" });
    expect(request).toContain("New role: Java.");
    expect(request).toContain("other roles it mentions have their own conversations");
  });

  it("starts the role from a JD sent only as a file", async () => {
    const file = {
      kind: "file",
      name: "jd.docx",
      size: 10,
      mimeType: "application/msword",
      artifactId: "a1",
    };
    const { deps: d } = deps({ ...mine, blocks: [file] });
    // The role's run receives only its request, so the file goes in by its id.
    expect(await copyRecruiterMessageToRole(d as never, run, role)).toContain(
      "Files the recruiter attached: jd.docx (artifact a1).",
    );
    expect(copiedBlocks()).toEqual([file]);
  });

  it("does not copy twice for the same call", async () => {
    const { deps: d } = deps(
      { ...mine, blocks: [{ kind: "text", text: "x" }] },
      { id: "msg-role" },
    );
    expect(await copyRecruiterMessageToRole(d as never, run, role)).toBeDefined();
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
  });

  it("uses the recruiter's latest message, skipping teammates' messages", async () => {
    const { deps: d } = deps([
      { ...mine, blocks: [{ kind: "bot_message_received", text: "x" }] },
      { ...mine, blocks: [{ kind: "text", text: "Open role 5" }] },
      { ...mine, blocks: [{ kind: "text", text: "Open role 4" }] },
    ]);
    await copyRecruiterMessageToRole(d as never, run, role);
    expect(copiedBlocks()).toEqual([{ kind: "text", text: "Open role 5" }]);
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
