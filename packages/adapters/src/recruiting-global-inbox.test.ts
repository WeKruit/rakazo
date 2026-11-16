import type { Actor, GlobalRecruitingInboxInput } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { getGlobalRecruitingInbox } from "./recruiting-global-inbox.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  detail: vi.fn(),
  thread: vi.fn(),
  group: vi.fn(),
  bindings: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  readGlobalRecruitingInbox: mocks.read,
  createGroupRepos: () => ({ getGroupTarget: mocks.group }),
}));
vi.mock("./recruiting-reads.js", async (original) => ({
  ...(await original<typeof import("./recruiting-reads.js")>()),
  getRecruitingCorrespondence: mocks.detail,
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const email = {
  id: "source:message",
  providerMessageId: "message",
  sourceId: "source",
  sourceName: "Mail",
  campaignId: "campaign",
  eaccount: "mailbox@example.test",
  providerThreadId: "provider-thread",
  savedRead: null,
  sender: "candidate@example.test",
  recipients: ["mailbox@example.test"],
  subject: "Reply",
  body: "Preview",
  snippet: true,
  date: null,
  url: null,
};
const page = () => ({
  roles: [
    { id: "role", threadId: "role-thread", groupId: "group", title: "Role", stage: "outreach" },
  ],
  items: [
    {
      key: "stored-thread-key",
      roleId: "role",
      email: { ...email },
      person: null,
      latestIncomingAt: null,
    },
  ],
  nextCursor: null,
  total: 1,
});
const input: GlobalRecruitingInboxInput = {
  thread: { roleId: "role", key: "stored-thread-key", emailId: "message" },
  limit: 1,
};
const deps = () => ({
  prisma: {
    thread: { findFirst: mocks.thread },
    externalEffect: { findMany: mocks.bindings },
  } as never,
  connectors: { execute: vi.fn() } as never,
  jobs: { enqueue: vi.fn() } as never,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.bindings.mockResolvedValue([]);
  mocks.read.mockResolvedValue(page());
  mocks.thread.mockResolvedValue({ botId: null });
  mocks.group.mockResolvedValue({
    id: "group",
    thread: { id: "role-thread" },
    members: [{ bot: { id: "main" } }],
  });
  mocks.detail.mockResolvedValue({
    emails: [{ ...email, body: "The actual complete body", snippet: false }],
  });
});
it("resolves the exact owned stored message and current role before its targeted body read", async () => {
  const result = await getGlobalRecruitingInbox(deps(), actor, input);
  expect(mocks.thread).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "role-thread",
        userId: "owner",
        spaceId: "space",
        activeRecruitingRoleId: "role",
      },
    }),
  );
  expect(mocks.detail).toHaveBeenCalledWith(
    expect.anything(),
    actor,
    { kind: "group", groupId: "group", threadId: "role-thread", memberBotIds: ["main"] },
    "inbox",
    undefined,
    undefined,
    { message: email },
    expect.objectContaining({ jobs: expect.anything() }),
  );
  expect(result.items[0]!.email.body).toBe("The actual complete body");
});
it.each(["list", "thread", "complete", "missing"])(
  "does no provider/detail read for %s",
  async (kind) => {
    if (kind === "complete")
      mocks.read.mockResolvedValue({
        ...page(),
        items: [{ ...page().items[0], email: { ...email, snippet: false } }],
      });
    if (kind === "missing") mocks.read.mockResolvedValue({ ...page(), items: [] });
    await getGlobalRecruitingInbox(
      deps(),
      actor,
      kind === "list"
        ? { limit: 1 }
        : kind === "thread"
          ? { ...input, thread: { ...input.thread!, emailId: undefined } }
          : input,
    );
    expect(mocks.detail).not.toHaveBeenCalled();
  },
);
it("refuses a role whose active thread changed before the body read", async () => {
  mocks.thread.mockResolvedValue(null);
  await expect(getGlobalRecruitingInbox(deps(), actor, input)).rejects.toThrow();
  expect(mocks.detail).not.toHaveBeenCalled();
});
it("does not publish a body if the role group changes while the provider read is in flight", async () => {
  mocks.group
    .mockResolvedValueOnce({
      id: "group",
      thread: { id: "role-thread" },
      members: [{ bot: { id: "main" } }],
    })
    .mockResolvedValueOnce({ id: "group", thread: { id: "other-thread" }, members: [] });
  await expect(getGlobalRecruitingInbox(deps(), actor, input)).rejects.toThrow();
});
// Gate b2005684, send-at-night: both emails had gone out and showed in the role's inbox, while the
// account Inbox, stored only from earlier reads, was empty.
it("reads the newest mail of a sending role behind the list, at most once in two minutes", async () => {
  mocks.bindings.mockResolvedValue([{ request: { roleId: "role" } }]);
  mocks.detail.mockResolvedValue({ emails: [] });
  const list = { ...page(), roles: [{ ...page().roles[0]!, id: "role-sending" }, ...page().roles] };
  mocks.read.mockResolvedValue(list);
  await getGlobalRecruitingInbox(deps(), { ...actor, userId: "sender" }, { limit: 20 });
  await vi.waitFor(() => expect(mocks.detail).toHaveBeenCalledTimes(1));
  expect(mocks.detail).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ userId: "sender" }),
    expect.objectContaining({ threadId: "role-thread" }),
    "inbox",
    undefined,
    undefined,
    { limit: 50 },
    expect.objectContaining({ connectors: expect.anything() }),
  );
  await getGlobalRecruitingInbox(deps(), { ...actor, userId: "sender" }, { limit: 20 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.detail).toHaveBeenCalledTimes(1);
});
