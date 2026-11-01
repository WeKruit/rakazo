import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { classifyInstantlyReplyReceipt } from "./instantly-reply.js";
import { indexSavedRecruitingInbox } from "./recruiting-reads.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  getRecruitingWorkspace: vi.fn(),
  readRecruitingNativeCorrespondence: vi.fn(),
  readRecruitingImportedCorrespondence: vi.fn(),
  projectRecruitingInboxMessages: vi.fn(),
  requireMembership: vi.fn(),
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
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
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
