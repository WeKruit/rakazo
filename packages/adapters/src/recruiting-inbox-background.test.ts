import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { classifyInstantlyReplyReceipt } from "./instantly-reply.js";
import {
  deferRecruitingInboxReceipt,
  indexSavedRecruitingInbox,
  projectRecruitingInboxJob,
} from "./recruiting-reads.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  getRecruitingWorkspace: vi.fn(),
  readRecruitingNativeCorrespondence: vi.fn(),
  readRecruitingImportedCorrespondence: vi.fn(),
  projectRecruitingInboxMessages: vi.fn(),
  requireMembership: vi.fn(),
  createRepos: vi.fn(() => ({
    getBot: vi.fn(async () => ({ id: "main", thread: { id: "thread" } })),
  })),
  createGroupRepos: vi.fn(() => ({
    getGroupTarget: vi.fn(async () => ({
      id: "group",
      thread: { id: "thread" },
      members: [{ bot: { id: "main" } }],
    })),
  })),
}));
const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const target = { kind: "bot", botId: "main", threadId: "thread" } as const;
const endpoint = "https://crm.example.test/mcp";
const server = {
  ...actor,
  id: "mail",
  name: "Instantly",
  enabled: true,
  revision: 1,
  endpoint: "https://mcp.instantly.ai/mcp",
  transport: "streamable_http",
  secretId: null,
};
const grant = { ...actor, serverId: "mail", botId: "main", allowAllTools: true, allowedTools: [] };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const email = (n: number) => ({
  id: uuid(n),
  timestamp_created: "2026-10-22T12:00:00.000Z",
  timestamp_email: "2026-10-22T11:59:00.000Z",
  message_id: `<${n}@example.test>`,
  subject: "Saved mail",
  from_address_email: "person@example.test",
  to_address_email_list: "owner@example.test",
  body: { text: `Original ${n}` },
  organization_id: uuid(900),
  eaccount: "owner@example.test",
  ue_type: 2,
  thread_id: `thread-${n}`,
});
const request = (tool: string, args: object) => [
  "__rakazoCatalogTool",
  "direct",
  { route: { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: tool }, args },
];
function fixture() {
  const updates = vi.fn();
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: "role", sourceThreadId: "thread" }]),
    $executeRaw: vi.fn(),
    thread: { findFirst: vi.fn(async (_query: unknown) => ({ id: "thread" })) },
    mcpServer: {
      findMany: vi.fn(async (_query: unknown) => [{ ...server, assignments: [grant] }]),
    },
    botMcpServer: { findMany: vi.fn(async () => [grant]) },
    externalEffect: { findMany: vi.fn(async (_query: unknown) => [] as unknown[]) },
    recruitingInboxIndexProgress: {
      findUnique: vi.fn(async () => ({ nativeCursor: null })),
      update: updates,
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  return {
    prisma,
    updates,
    run: () =>
      indexSavedRecruitingInbox(
        prisma as never,
        actor,
        async () => target,
        async () => {},
        undefined,
        endpoint,
      ),
  };
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Offline indexing must not call a provider");
    }),
  );
  vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({ role: { id: "role" } } as never);
  vi.mocked(db.readRecruitingNativeCorrespondence).mockResolvedValue(null);
  vi.mocked(db.requireMembership).mockResolvedValue(actor as never);
  vi.mocked(db.projectRecruitingInboxMessages).mockImplementation(
    async (_p, _actor, _input, authorize) => {
      await authorize?.();
    },
  );
});
it("normalizes a retained batch with more than 200 emails once and projects bounded chunks", async () => {
  const f = fixture();
  const effects = [0, 1].map((n) => ({
    id: `receipt-${n}`,
    status: "completed",
    updatedAt: new Date(n === 0 ? "2026-10-23T00:00:00Z" : "2026-10-22T00:00:00Z"),
    run: { id: "run", botId: "main", sourceMessageId: null },
    request: request("list_emails", { campaign_id: uuid(1000 + n) }),
  }));
  const results = effects.map((effect, n) => ({
    id: effect.id,
    result: {
      structuredContent: {
        items: Array.from({ length: 125 }, (_, i) => ({
          ...email(n * 125 + i + 1),
          campaign_id: uuid(1000 + n),
        })),
      },
    },
  }));
  f.prisma.externalEffect.findMany.mockImplementation(async (query) =>
    "id" in (query as { where: object }).where ? results : effects,
  );
  await f.run();
  expect(f.prisma.externalEffect.findMany).toHaveBeenCalledTimes(2);
  const chunks = vi
    .mocked(db.projectRecruitingInboxMessages)
    .mock.calls.map(([, , input]) => input.emails);
  expect(chunks.map((chunk) => chunk.length)).toEqual([125, 125]);
  expect(
    vi
      .mocked(db.projectRecruitingInboxMessages)
      .mock.calls.map(([, , input]) => input.observedAt.toISOString()),
  ).toEqual(["2026-10-23T00:00:00.000Z", "2026-10-22T00:00:00.000Z"]);
  expect(new Set(chunks.flat().map((item) => item.id)).size).toBe(250);
  expect(db.readRecruitingNativeCorrespondence).toHaveBeenCalledOnce();
  expect(db.readRecruitingImportedCorrespondence).not.toHaveBeenCalled();
  expect(f.updates).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { nativeCursor: { roleId: "role", done: true } } }),
  );
});
it.each(["sent_recorded", "scheduled"] as const)(
  "replays actual saved native %s with the configured endpoint and exact source grants",
  async (status) => {
    const f = fixture();
    const anchor = email(1);
    const args = {
      reply_to_uuid: anchor.id,
      eaccount: "owner@example.test",
      to: "person@example.test",
      subject: anchor.subject,
      body_text: "Exact saved reply",
      skip_validation: false,
    };
    const outgoing = {
      ...anchor,
      id: uuid(2),
      message_id: "<reply@example.test>",
      ue_type: status === "scheduled" ? 4 : 3,
      from_address_email: args.eaccount,
      to_address_email_list: args.to,
      body: { text: args.body_text },
    };
    const classified = classifyInstantlyReplyReceipt(args, anchor, outgoing);
    expect(classified.status).toBe(status);
    const read = {
      id: "read",
      status: "completed",
      request: request("get_email", { id: anchor.id }),
      result: { structuredContent: anchor },
      updatedAt: new Date("2026-10-23T00:00:00Z"),
      run: { id: "run", sourceMessageId: null },
    };
    vi.mocked(db.readRecruitingNativeCorrespondence).mockResolvedValue({
      roleId: "role",
      bindingEffectId: "binding",
      target: { crmRoleId: uuid(903) },
      crmSource: { endpoint, transport: "streamable_http" },
      partial: false,
      authorizations: [
        { server, botId: "main", tool: "get_email" },
        { server, botId: "main", tool: "reply_to_email" },
      ],
      records: [
        {
          scope: { candidateId: uuid(904) },
          source: server,
          emailRead: read,
          reads: [read],
          args,
          effect: {
            id: "reply",
            status: "completed",
            result: {
              ...classified,
              sourceReadEffectId: read.id,
              providerResult: { structuredContent: outgoing },
            },
            updatedAt: new Date("2026-10-24T00:00:00Z"),
            run: { id: "run", sourceMessageId: null },
          },
        },
      ],
    } as never);
    await f.run();
    expect(db.readRecruitingNativeCorrespondence).toHaveBeenCalledOnce();
    const projected = vi
      .mocked(db.projectRecruitingInboxMessages)
      .mock.calls.map(([, , input]) => input)
      .flatMap((input) =>
        input.emails.map((item) => ({ ...item, checkedAt: input.observedAt.toISOString() })),
      );
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `mail:${anchor.id}`,
          body: anchor.body.text,
          sourceId: "mail",
          checkedAt: "2026-10-23T00:00:00.000Z",
        }),
        expect.objectContaining({
          id: `mail:${outgoing.id}`,
          body: args.body_text,
          sourceId: "mail",
          checkedAt: "2026-10-24T00:00:00.000Z",
        }),
      ]),
    );
    expect(f.prisma.botMcpServer.findMany).toHaveBeenCalled();
    expect(
      f.prisma.mcpServer.findMany.mock.calls.some(([query]) =>
        Boolean((query as never as { where: { userId?: string } }).where.userId === actor.userId),
      ),
    ).toBe(true);
  },
);

it("checkpoints the receipt keyset after bounded projection and resumes without reparsing the prior batch", async () => {
  const f = fixture();
  const abort = new AbortController();
  let checkpoint: unknown = null;
  const effects = Array.from({ length: 21 }, (_, n) => ({
    id: `receipt-${String(n).padStart(2, "0")}`,
    status: "completed",
    updatedAt: new Date(n < 20 ? "2026-10-23T00:00:00Z" : "2026-10-22T00:00:00Z"),
    run: { id: "run", botId: "main", sourceMessageId: null },
    request: request("list_emails", { campaign_id: uuid(1000 + n) }),
  }));
  f.prisma.recruitingInboxIndexProgress.findUnique.mockImplementation(
    async () => ({ nativeCursor: checkpoint }) as never,
  );
  f.updates.mockImplementation(async (query) => {
    checkpoint = query.data.nativeCursor;
    abort.abort();
  });
  f.prisma.externalEffect.findMany.mockImplementation(async (query) => {
    const where = (query as { where: { id?: { in: string[] }; AND?: unknown } }).where;
    if (where.id)
      return effects
        .filter((effect) => where.id!.in.includes(effect.id))
        .map((effect, n) => ({
          id: effect.id,
          result: {
            structuredContent: {
              items:
                n === 0
                  ? [
                      {
                        ...email(1),
                        campaign_id: (effect.request[2] as { args: { campaign_id: string } }).args
                          .campaign_id,
                      },
                    ]
                  : [],
            },
          },
        }));
    return where.AND ? effects.slice(20) : effects;
  });
  await indexSavedRecruitingInbox(
    f.prisma as never,
    actor,
    async () => target,
    async () => {},
    abort.signal,
    endpoint,
  );
  expect(checkpoint).toEqual({
    roleId: "role",
    before: { at: "2026-10-23T00:00:00.000Z", id: "receipt-19" },
  });
  expect(f.prisma.externalEffect.findMany).toHaveBeenCalledTimes(2);
  const firstDate = vi.mocked(db.projectRecruitingInboxMessages).mock.calls[0]![2].observedAt;
  expect(firstDate.toISOString()).toBe("2026-10-23T00:00:00.000Z");
  await f.run();
  expect(f.prisma.externalEffect.findMany).toHaveBeenCalledTimes(4);
  const resumedQuery = f.prisma.externalEffect.findMany.mock.calls[2]![0];
  expect(JSON.stringify(resumedQuery)).toContain("receipt-19");
  expect(f.updates).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { nativeCursor: { roleId: "role", done: true } } }),
  );
  expect(
    vi.mocked(db.projectRecruitingInboxMessages).mock.calls[1]![2].observedAt.toISOString(),
  ).toBe("2026-10-22T00:00:00.000Z");
  expect(fetch).not.toHaveBeenCalled();
});

it("enumerates only active owned current roles and continues to a later eligible source", async () => {
  const f = fixture();
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    expect(text).toContain('t."activeRecruitingRoleId"=r.id');
    expect(text).toContain('t."userId"=?');
    expect(text).toContain('t."spaceId"=?');
    expect(values.slice(0, 4)).toEqual([actor.userId, actor.spaceId, actor.userId, actor.spaceId]);
    expect(text).toContain('g."archivedAt" IS NOT NULL');
    expect(text).toContain("r.id>=");
    return [{ id: "role", sourceThreadId: "later-valid-thread" }];
  });
  f.prisma.$queryRaw = sql as never;
  const resolve = vi.fn(async (thread: string) => {
    expect(thread).toBe("later-valid-thread");
    return target;
  });
  await indexSavedRecruitingInbox(
    f.prisma as never,
    actor,
    resolve,
    async () => {},
    undefined,
    endpoint,
  );
  expect(sql).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalled();
  expect(f.updates).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { nativeCursor: { roleId: "role", done: true } } }),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("queues only resolved native mailbox reads without awaiting the queue or retaining mail contents", async () => {
  let finish!: () => void;
  const enqueue = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const route = {
    connectorId: "mcp",
    resourceId: "mail",
    resourceRevision: 1,
    toolName: "native_instantly_get_email",
  };
  expect(deferRecruitingInboxReceipt({ enqueue } as never, route, "receipt-1")).toBeUndefined();
  expect(enqueue).toHaveBeenCalledWith({
    name: "recruiting_inbox.project",
    payload: { effectId: "receipt-1" },
    replaceKey: "recruiting_inbox.project:receipt-1",
    keepExisting: true,
  });
  deferRecruitingInboxReceipt(
    { enqueue } as never,
    { ...route, connectorId: "other" },
    "receipt-other",
  );
  deferRecruitingInboxReceipt(
    { enqueue } as never,
    { ...route, toolName: "get_campaign" },
    "receipt-campaign",
  );
  expect(enqueue).toHaveBeenCalledTimes(1);
  finish();
  await Promise.resolve();
});

function receiptFixture() {
  const f = fixture();
  const effect = {
    id: "receipt-1",
    status: "completed",
    spaceId: "space",
    request: request("get_email", { id: uuid(1) }),
    updatedAt: new Date("2026-10-23T00:00:00Z"),
    run: {
      id: "run",
      userId: "owner",
      spaceId: "space",
      botId: "main",
      threadId: "thread",
      initialRecruitingRoleRevision: { roleId: "role" },
      thread: {
        id: "thread",
        userId: "owner",
        spaceId: "space",
        groupId: null,
        botId: "main",
        activeRecruitingRoleId: "role",
      },
    },
  };
  const prisma = {
    ...f.prisma,
    externalEffect: Object.assign(f.prisma.externalEffect, {
      findUnique: vi.fn(async () => effect),
    }),
  };
  f.prisma.externalEffect.findMany.mockImplementation(async (query) =>
    "result" in (query as { select: object }).select
      ? [{ id: effect.id, result: { structuredContent: email(1) } }]
      : [{ ...effect, run: { id: "run", botId: "main", sourceMessageId: null } }],
  );
  const events = { append: vi.fn(async (_event: unknown) => ({})) };
  return {
    ...f,
    prisma,
    effect,
    events,
    project: () =>
      projectRecruitingInboxJob(
        { prisma: prisma as never, events: events as never },
        { effectId: effect.id },
      ),
  };
}

it("projects one canonical receipt within its owner/Space/current role without touching the full-pass cursor", async () => {
  const f = receiptFixture();
  await f.project();
  const query = f.prisma.externalEffect.findMany.mock.calls[0]![0] as {
    where: Record<string, unknown>;
  };
  expect(query.where.id).toBe("receipt-1");
  expect(query.where).toMatchObject({
    spaceId: "space",
    run: { userId: "owner", spaceId: "space", threadId: "thread" },
  });
  expect(db.projectRecruitingInboxMessages).toHaveBeenCalledWith(
    f.prisma,
    actor,
    expect.objectContaining({
      roleId: "role",
      observedAt: f.effect.updatedAt,
      emails: [expect.objectContaining({ providerMessageId: uuid(1), body: "Original 1" })],
    }),
    expect.any(Function),
  );
  expect(f.prisma.recruitingInboxIndexProgress.findUnique).not.toHaveBeenCalled();
  expect(f.updates).not.toHaveBeenCalled();
  expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["owner", "space", "role", "status", "source"])(
  "does not project a retired canonical %s scope",
  async (kind) => {
    const f = receiptFixture();
    if (kind === "owner") f.effect.run.thread.userId = "other";
    if (kind === "space") f.effect.run.spaceId = "other-space";
    if (kind === "role") f.effect.run.thread.activeRecruitingRoleId = "other-role";
    if (kind === "status") f.effect.status = "executing";
    if (kind === "source") f.effect.request = request("get_campaign", {});
    await f.project();
    expect(db.projectRecruitingInboxMessages).not.toHaveBeenCalled();
  },
);

it("lets projection failures reach Graphile retry and succeeds when the same canonical receipt is replayed", async () => {
  const f = receiptFixture();
  vi.mocked(db.projectRecruitingInboxMessages).mockRejectedValueOnce(new Error("database busy"));
  await expect(f.project()).rejects.toThrow("database busy");
  await f.project();
  expect(db.projectRecruitingInboxMessages).toHaveBeenCalledTimes(2);
});

it("does not make the tool fail when asynchronous queue publication fails", async () => {
  const enqueue = vi.fn(async () => {
    throw new Error("database busy");
  });
  expect(
    deferRecruitingInboxReceipt(
      { enqueue } as never,
      { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: "get_email" },
      "receipt",
    ),
  ).toBeUndefined();
  await Promise.resolve();
});

it("revalidates membership and exact current source before committing the projection", async () => {
  const f = receiptFixture();
  let reads = 0;
  f.prisma.mcpServer.findMany.mockImplementation(async () =>
    ++reads < 3 ? [{ ...server, assignments: [grant] }] : [],
  );
  await f.project();
  expect(reads).toBe(3);
  expect(db.projectRecruitingInboxMessages).toHaveBeenCalledOnce();
  expect(f.updates).not.toHaveBeenCalled();
});

it("wakes only the current role and that owner's existing global workspace after commit", async () => {
  const f = receiptFixture();
  let committed = false;
  vi.mocked(db.projectRecruitingInboxMessages).mockImplementation(
    async (_prisma, _actor, _input, authorize) => {
      await authorize?.();
      committed = true;
    },
  );
  f.prisma.thread.findFirst.mockImplementation(async (query: unknown) => {
    const where = (query as { where: Record<string, unknown> }).where;
    if (where.groupId) {
      expect(where).toMatchObject({
        userId: "owner",
        spaceId: "space",
        groupId: db.recruitingGlobalGroupId(actor),
        group: { userId: "owner", spaceId: "space", archivedAt: null },
      });
      return { id: "global-thread", group: { members: [{ botId: "global-main" }] } };
    }
    return { id: "thread" };
  });
  const append = vi.fn(async (_event: unknown) => {
    expect(committed).toBe(true);
  });
  await projectRecruitingInboxJob(
    { prisma: f.prisma as never, events: { append } as never },
    { effectId: "receipt-1" },
  );
  expect(append.mock.calls.map(([event]) => (event as { threadId: string }).threadId)).toEqual([
    "thread",
    "global-thread",
  ]);
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      spaceId: "space",
      threadId: "global-thread",
      botId: "global-main",
      type: "recruiting.changed",
      payload: { roleId: "role" },
    }),
  );
  expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
});

it("retries a missed post-commit signal using the same receipt without replacing observed mail", async () => {
  const f = receiptFixture();
  const append = vi
    .fn()
    .mockRejectedValueOnce(new Error("notify busy"))
    .mockResolvedValue(undefined);
  const project = () =>
    projectRecruitingInboxJob(
      { prisma: f.prisma as never, events: { append } as never },
      { effectId: "receipt-1" },
    );
  await expect(project()).rejects.toThrow("notify busy");
  await project();
  expect(db.projectRecruitingInboxMessages).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(db.projectRecruitingInboxMessages).mock.calls.map(([, , input]) => input.observedAt),
  ).toEqual([f.effect.updatedAt, f.effect.updatedAt]);
});

it.each(["endpoint", "revision", "grant", "transport", "disabled"])(
  "rejects a changed canonical mailbox %s",
  async (kind) => {
    const f = receiptFixture();
    const changed = { ...server, assignments: [grant] };
    if (kind === "endpoint") changed.endpoint = "https://other.example.test/mcp";
    if (kind === "revision") changed.revision = 2;
    if (kind === "grant")
      changed.assignments = [{ ...grant, allowAllTools: false, allowedTools: [] }];
    if (kind === "transport") changed.transport = "stdio";
    if (kind === "disabled") changed.enabled = false;
    f.prisma.mcpServer.findMany.mockResolvedValue([changed]);
    await f.project();
    expect(db.projectRecruitingInboxMessages).not.toHaveBeenCalled();
  },
);

function liveFixture() {
  const f = receiptFixture();
  const observation = {
    threadId: "thread",
    roleId: "role",
    sourceId: "mail",
    sourceRevision: 1,
    botId: "main",
    campaignId: uuid(1000),
    observedAt: "2026-10-23T00:00:00.000Z",
    emails: [
      {
        id: `mail:${uuid(1)}`,
        sourceName: "Instantly",
        sourceId: "mail",
        providerMessageId: uuid(1),
        savedRead: null,
        campaignId: uuid(1000),
        eaccount: "owner@example.test",
        sender: "person@example.test",
        recipients: ["owner@example.test"],
        subject: "Live reply",
        body: "Verified live observation",
        snippet: false,
        date: "2026-10-22T12:00:00.000Z",
        url: null,
      },
    ],
  };
  const binding = {
    kind: "instantly_role_campaign",
    status: "completed",
    spaceId: "space",
    request: { roleId: "role", serverId: "mail" },
    result: { campaignId: uuid(1000), eaccount: "owner@example.test" },
    run: { userId: "owner", spaceId: "space", threadId: "thread" },
  };
  Object.assign(f.prisma.thread, { findUnique: vi.fn(async () => f.effect.run.thread) });
  f.prisma.externalEffect.findUnique.mockImplementation(async () => binding as never);
  return {
    ...f,
    observation,
    binding,
    projectLive: () =>
      projectRecruitingInboxJob({ prisma: f.prisma as never, events: f.events as never }, {
        observation,
      } as never),
  };
}
it("projects a server-verified live observation at its GET start without re-reading providers or replaying receipt history", async () => {
  const f = liveFixture();
  await f.projectLive();
  expect(db.projectRecruitingInboxMessages).toHaveBeenCalledWith(
    f.prisma,
    actor,
    expect.objectContaining({
      roleId: "role",
      observedAt: new Date(f.observation.observedAt),
      emails: [expect.objectContaining({ body: "Verified live observation" })],
    }),
    expect.any(Function),
  );
  expect(f.prisma.externalEffect.findMany).not.toHaveBeenCalled();
  expect(f.updates).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["campaign", "mailbox", "owner", "role", "source"])(
  "rejects changed live observation %s before indexing",
  async (kind) => {
    const f = liveFixture();
    if (kind === "campaign") f.binding.result.campaignId = uuid(1001);
    if (kind === "mailbox") f.binding.result.eaccount = "other@example.test";
    if (kind === "owner") f.binding.run.userId = "other";
    if (kind === "role") f.effect.run.thread.activeRecruitingRoleId = "other-role";
    if (kind === "source") f.binding.request.serverId = "other-source";
    await f.projectLive();
    expect(db.projectRecruitingInboxMessages).not.toHaveBeenCalled();
  },
);

it("keeps source observation order when newer and then older live reads finish out of order", async () => {
  const f = liveFixture();
  f.observation.observedAt = "2026-10-24T00:00:00.000Z";
  await f.projectLive();
  f.observation.observedAt = "2026-10-23T00:00:00.000Z";
  await f.projectLive();
  expect(
    vi
      .mocked(db.projectRecruitingInboxMessages)
      .mock.calls.map(([, , input]) => input.observedAt.toISOString()),
  ).toEqual(["2026-10-24T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
});
it("rolls back a live projection when its mailbox binding changes before commit", async () => {
  const f = liveFixture();
  let reads = 0;
  f.prisma.externalEffect.findUnique.mockImplementation(async () =>
    ++reads === 1
      ? (f.binding as never)
      : ({
          ...f.binding,
          result: { ...f.binding.result, eaccount: "other@example.test" },
        } as never),
  );
  let committed = false;
  vi.mocked(db.projectRecruitingInboxMessages).mockImplementation(
    async (_prisma, _actor, _input, authorize) => {
      await authorize?.();
      committed = true;
    },
  );
  await f.projectLive();
  expect(committed).toBe(false);
  expect(f.events.append).not.toHaveBeenCalled();
});

it("a live observation invalidates only the existing global stored view, never its own live reader", async () => {
  const f = liveFixture();
  f.prisma.thread.findFirst.mockImplementation(async (query: unknown) =>
    (query as { where: { groupId?: string } }).where.groupId
      ? { id: "global-thread", group: { members: [{ botId: "global-main" }] } }
      : { id: "thread" },
  );
  await f.projectLive();
  expect(
    f.events.append.mock.calls.map(([event]) => (event as { threadId: string }).threadId),
  ).toEqual(["global-thread"]);
  expect(f.events.append).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }));
  expect(fetch).not.toHaveBeenCalled();
});
