import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  normalizeRecruitingCandidateRow,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import * as recruiting from "./recruiting.js";
import { IsolationError } from "./scope.js";

vi.mock("./messages.js", async (load) => ({
  ...(await load<typeof import("./messages.js")>()),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "human-shortlist-receipt" })),
}));
vi.mock("./events.js", () => ({
  appendEventInTransaction: vi.fn(async (_tx, input) => ({
    id: "recorded-event",
    seq: 2,
    createdAt: new Date(),
    ...input,
  })),
}));
const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const role = {
    id: "role",
    spaceId: "space",
    userId: "owner",
    sourceThreadId: "thread",
    title: "Systems engineer",
    currentRevisionId: "revision",
    revision: 1,
  };
  const candidate = {
    roleId: "role",
    candidateKey: "candidate",
    shortlisted: false,
    revision: 0,
    consideration: null as unknown,
  };
  const tx = {
    $queryRaw: vi.fn(async (_query: unknown) => [] as unknown[]),
    $executeRaw: vi.fn(async (_query: unknown) => 0),
    recruitingCrmWorkspaceAttachment: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }) =>
        typeof where.id === "object" && where.id.not === role.id ? null : role,
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    thread: {
      findFirst: vi.fn(async () => ({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "role",
      })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    recruitingCandidate: {
      findUnique: vi.fn(async () => candidate),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    recruitingCandidatePage: {
      findMany: vi.fn(async (_query: unknown) => [] as { effectId: string }[]),
    },
  };
  const backfill = vi.fn(async (_query: unknown) => 0);
  const prisma = {
    $transaction: vi.fn(async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx)),
    $executeRaw: backfill,
  } as unknown as PrismaClient;
  return { prisma, tx, role, candidate, backfill };
}

function candidateProjectionRows(
  counts: Record<string, unknown>[],
  rows: Record<string, unknown>[] = [],
) {
  const { shortlisted, ...summary } = counts[0]!;
  const totals = { ...summary, shortlistedCount: shortlisted };
  return rows.length
    ? rows.map((row) => ({ ...totals, ...row }))
    : [{ ...totals, candidateKey: null }];
}

describe("candidate listing and shortlist boundaries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reads an empty filtered page with global counts in one candidate projection", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce(
      candidateProjectionRows([
        {
          total: 0n,
          rankAvailable: false,
          tierAvailable: false,
          scoreAvailable: false,
          sourceRows: 500n,
          candidates: 200n,
          identifiedCandidates: 190n,
          unassessed: 180n,
          assessed: 20n,
          shortlisted: 10n,
        },
      ]),
    );
    const page = await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: "role",
      query: "No matching candidate",
      sort: "name",
    });
    expect(page).toMatchObject({
      total: 0,
      items: [],
      nextCursor: null,
      counts: { sourceRows: 500, candidates: 200, identifiedCandidates: 190, shortlisted: 10 },
    });
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    const statement = f.tx.$queryRaw.mock.calls[0]![0] as { sql: string };
    // Match fields come only from the stored occurrence column: no saved-page parse and no
    // correlated external_effects subquery per row, even for legacy NULL rows (prod 500, 24 s).
    expect(statement.sql).not.toContain("match_rows");
    expect(statement.sql).not.toContain("WITH ORDINALITY");
    expect(statement.sql).toContain(`COALESCE(o."matchFields", '{}'::jsonb)`);
    expect(statement.sql).not.toContain("external_effects");
    expect(statement.sql).not.toContain("structuredContent");
    expect(statement.sql).not.toContain("matchBackfill");
    expect(statement.sql).toContain("totals LEFT JOIN candidate_page ON true");
  });
  it("backfills legacy NULL match fields owner-scoped, before the read snapshot", async () => {
    const f = fixture();
    const totals = {
      total: 0n,
      rankAvailable: false,
      tierAvailable: false,
      scoreAvailable: false,
      sourceRows: 0n,
      candidates: 0n,
      identifiedCandidates: 0n,
      unassessed: 0n,
      assessed: 0n,
      shortlistedCount: 0n,
      candidateKey: null,
    };
    f.tx.$queryRaw.mockResolvedValueOnce([totals]);
    await recruiting.listRecruitingCandidates(f.prisma, actor, { roleId: "role" });
    expect(f.backfill).toHaveBeenCalledOnce();
    expect(f.backfill.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
    const update = f.backfill.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(update.sql).toContain('UPDATE "recruiting_candidate_occurrences" o SET "matchFields"');
    expect(update.sql).toContain('o."matchFields" IS NULL');
    expect(update.sql).toContain('r."spaceId" = ? AND r."userId" = ?');
    expect(update.values).toEqual(expect.arrayContaining(["role", actor.spaceId, actor.userId]));
  });
  it.each(["rank", "score"] as const)(
    "authorizes before querying candidate %s data",
    async (sort) => {
      const f = fixture();
      f.tx.recruitingRole.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "foreign",
          sort,
          sourceEffectId: "native-read",
        }),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each([
    "Engineer",
    "Example Candidate",
    "Example\t \nCandidate",
    "示例\t 候选人",
    "50%_Engineer",
    "https://www.linkedin.com/in/example-candidate",
  ])(
    "uses scoped server counts and bounded SQL pagination for %s, with cursors bound to filters",
    async (search) => {
      const f = fixture();
      const row = (key: string) => ({
        roleId: "role",
        candidateKey: key,
        name: key,
        title: null,
        company: null,
        location: null,
        linkedinUrl: null,
        resumeUrl: null,
        evidenceUrls: null,
        issues: [],
        shortlisted: false,
        shortlistedAt: null,
        consideration: null,
        revision: 0,
        discoveryCount: 1,
        profileSourcePageIds: [],
        countIdentified: false,
        firstDiscoveredAt: "2026-10-16T00:00:00.000Z",
        lastDiscoveredAt: "2026-10-16T00:00:00.000Z",
        assessmentVersion: null,
        assessmentRoleRevisionId: null,
        assessmentCreatedAt: null,
        hardGate: null,
        sortValue: key,
      });
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(
          [
            {
              total: 19n,
              rankAvailable: false,
              tierAvailable: false,
              scoreAvailable: false,
              sourceRows: 30n,
              candidates: 20n,
              identifiedCandidates: 4n,
              unassessed: 19n,
              assessed: 1n,
              shortlisted: 2n,
            },
          ],
          [
            {
              ...row("a"),
              consideration: {
                operation: "hold",
                source: {
                  messageId: "deleted-human",
                  threadId: "deleted-bot-thread",
                  seq: 3,
                  createdAt: "2026-10-16T00:00:00.000Z",
                  quote: "Pause consideration of Avery",
                  actor: { userId: actor.userId, spaceId: actor.spaceId },
                },
              },
            },
            row("b"),
          ],
        ),
      );
      const page = await recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        limit: 1,
        sort: "name",
        query: search,
        sourceEffectId: "native-read",
      });
      expect(page.total).toBe(19);
      expect(page.items[0]?.decision).toBe("hold");
      expect(page.items[0]).toMatchObject({
        decisionReason: "Pause consideration of Avery",
        decisionAt: "2026-10-16T00:00:00.000Z",
      });
      expect(page.items[0]).not.toHaveProperty("consideration");
      expect(page).toHaveProperty("sortAvailability", { rank: false, tier: false, score: false });
      const totalsQuery = f.tx.$queryRaw.mock.calls[0]![0] as {
        sql: string;
        values: unknown[];
      };
      expect(totalsQuery.sql).toContain('bool_or("rankValue" IS NOT NULL), false) FROM filtered');
      expect(totalsQuery.sql).toContain('bool_or("tierValue" IS NOT NULL), false) FROM filtered');
      expect(totalsQuery.values).toContain(2);
      expect(page.counts).toEqual({
        sourceRows: 30,
        candidates: 20,
        identifiedCandidates: 4,
        unassessed: 19,
        assessed: 1,
        shortlisted: 2,
      });
      expect(page.items.map((item) => item.candidateKey)).toEqual(["a"]);
      expect(page.items[0]?.shortlisted).toBe(false);
      expect(page.crmTarget).toBeNull();
      expect(page.items[0]?.crm).toBeNull();
      expect(page.items[0]).not.toHaveProperty("countIdentified");
      const query = f.tx.$queryRaw.mock.lastCall?.[0] as unknown as {
        sql: string;
        values: unknown[];
      };
      expect(query.sql).toContain("LIMIT");
      expect(query.values).toContain(2);
      expect(query.sql).not.toContain(search);
      expect(query.values).toContain(search);
      expect(query.sql).toContain('b."name"');
      expect(query.sql).toContain('b."linkedinUrl"');
      for (const [statement] of f.tx.$queryRaw.mock.calls) {
        const sql = statement as { sql: string; values: unknown[] };
        expect(sql.sql).not.toContain(search);
        expect(sql.values).toContain(search);
        expect(sql.sql).toContain('AND page."effectId" = ?');
        expect(sql.sql).toContain('b."sourcePageId" IS NOT NULL');
        expect(sql.values).toContain("native-read");
        expect(sql.sql).not.toContain('page."actionId" =');
      }
      const totals = f.tx.$queryRaw.mock.calls[0]![0] as { sql: string };
      expect(totals.sql).toContain('(SELECT count(*) FROM filtered) AS "total"');
      expect(totals.sql).toContain('AS "shortlistedCount" FROM base');
      const legacyScope = createHash("sha256")
        .update(
          stableJsonValue({
            roleId: "role",
            roleRevisionId: "revision",
            sort: "name",
            sourceProjection: 2,
            query: search,
            assessmentState: null,
            verdict: null,
            shortlisted: null,
            actionId: null,
            sourceEffectId: "native-read",
          }),
        )
        .digest("hex");
      const legacyCursor = Buffer.from(
        JSON.stringify({ version: 1, scope: legacyScope, value: "a", key: "a" }),
      ).toString("base64url");
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          limit: 1,
          sort: "name",
          query: search,
          sourceEffectId: "native-read",
          cursor: legacyCursor,
        }),
      ).rejects.toThrow(recruiting.RecruitingConflictError);
      for (const changed of [
        { query: "Different" },
        { sourceEffectId: "other-read" },
        { sourceEffectId: undefined },
        { actionId: "action" },
      ])
        await expect(
          recruiting.listRecruitingCandidates(f.prisma, actor, {
            roleId: "role",
            limit: 1,
            sort: "name",
            query: search,
            sourceEffectId: "native-read",
            cursor: page.nextCursor!,
            ...changed,
          }),
        ).rejects.toThrow(recruiting.RecruitingConflictError);
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    },
  );
  it("uses original ranks inside an explicitly selected immutable result page", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce(
      candidateProjectionRows(
        [
          {
            total: 0n,
            rankAvailable: false,
            tierAvailable: false,
            scoreAvailable: false,
            sourceRows: 0n,
            candidates: 0n,
            identifiedCandidates: 0n,
            unassessed: 0n,
            assessed: 0n,
            shortlisted: 0n,
          },
        ],
        [],
      ) as never,
    );
    await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: "role",
      sort: "rank",
      sourceEffectId: "selected-result",
    });
    const query = f.tx.$queryRaw.mock.lastCall![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain("CASE WHEN returned.value ? 'updated_rank'");
    expect(query.sql).toContain("WHEN returned.value ? 'overall_rank'");
    expect(query.sql).toContain("WHEN returned.value ? 'rank' THEN returned.value -> 'rank'");
    expect(query.sql).toContain(
      "WHEN returned.value ? 'batch_rank' THEN returned.value -> 'batch_rank'",
    );
    expect(query.sql).toContain("ELSE returned.value -> 'rank_this_batch_only' END");
    expect(query.sql).toContain(
      "(returned.value ? 'rank' OR returned.value ? 'batch_rank' OR returned.value ? 'rank_this_batch_only')",
    );
    expect(query.sql).toContain('page."effectId" = rank_scope."pageId"');
    expect(query.values).toContain("selected-result");
    expect(query.sql).toContain('AND page."effectId" = ?');
    expect(f.tx.recruitingCandidatePage.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { sourceEffectId: "historical-page" },
    { actionId: "historical-action" },
    { sourceEffectId: "historical-page", actionId: "historical-action" },
  ])(
    "uses one explicit observation scope for profile, primary source and matches: %j",
    async (filters) => {
      const f = fixture();
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(
          [
            {
              total: 0n,
              rankAvailable: false,
              tierAvailable: false,
              scoreAvailable: false,
              sourceRows: 3n,
              candidates: 2n,
              identifiedCandidates: 2n,
              unassessed: 2n,
              assessed: 0n,
              shortlisted: 1n,
            },
          ],
          [],
        ) as never,
      );
      const page = await recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        sort: "name",
        ...filters,
      });
      expect(page.counts).toMatchObject({
        sourceRows: 3,
        candidates: 2,
        identifiedCandidates: 2,
        shortlisted: 1,
      });
      for (const [statement] of f.tx.$queryRaw.mock.calls) {
        const query = statement as { sql: string; values: unknown[] };
        const primary = query.sql.slice(
          query.sql.indexOf("SELECT o.*"),
          query.sql.indexOf(") p ON true"),
        );
        const profile = query.sql.slice(
          query.sql.indexOf(") p ON true"),
          query.sql.indexOf(") profile ON true"),
        );
        const matches = query.sql.slice(
          query.sql.indexOf('COALESCE(o."matchFields"'),
          query.sql.indexOf(") match ON true"),
        );
        for (const field of Object.keys(filters)) {
          const column = field === "sourceEffectId" ? "effectId" : "actionId";
          const predicate = `AND page."${column}" = ?`;
          for (const section of [primary, profile, matches]) expect(section).toContain(predicate);
          expect(query.values).toContain(filters[field as keyof typeof filters]);
        }
        expect(query.sql).toContain('b."sourcePageId" IS NOT NULL');
        expect(query.sql).toContain(
          'profile."identifiedLinkedinUrl" IS NOT NULL AS "countIdentified"',
        );
        expect(profile).toContain('AS "identifiedLinkedinUrl"');
      }
    },
  );
  it("binds original-rank comparability to the selected action's saved pages", async () => {
    const f = fixture();
    f.tx.recruitingCandidatePage.findMany.mockResolvedValue([{ effectId: "action-only-page" }]);
    f.tx.$queryRaw.mockResolvedValueOnce(
      candidateProjectionRows(
        [
          {
            total: 0n,
            rankAvailable: false,
            tierAvailable: false,
            scoreAvailable: false,
            sourceRows: 0n,
            candidates: 0n,
            identifiedCandidates: 0n,
            unassessed: 0n,
            assessed: 0n,
            shortlisted: 0n,
          },
        ],
        [],
      ) as never,
    );
    await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: "role",
      actionId: "action",
      sort: "rank",
    });
    expect(f.tx.recruitingCandidatePage.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { roleId: "role", actionId: "action" },
      select: { effectId: true },
      orderBy: [{ observedAt: "desc" }, { effectId: "desc" }],
      take: 1,
    });
    const query = f.tx.$queryRaw.mock.lastCall![0] as { sql: string; values: unknown[] };
    expect(query.values).toContain("action-only-page");
    expect(query.sql).toContain('AND page."actionId" = ?');
    expect(query.sql).not.toContain('AND page."effectId" = ?');
  });
  it.each(["name", "recent", "rank", "tier"] as const)(
    "rejects a pre-source-projection %s cursor before reading a historical view",
    async (sort) => {
      const f = fixture();
      const scope = createHash("sha256")
        .update(
          stableJsonValue({
            roleId: "role",
            roleRevisionId: "revision",
            sort,
            ...(sort === "rank" ? { rankProjection: 2 } : {}),
            query: "",
            assessmentState: null,
            verdict: null,
            shortlisted: null,
            actionId: null,
            sourceEffectId: "historical-page",
          }),
        )
        .digest("hex");
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(
          [
            {
              total: 0n,
              rankAvailable: false,
              tierAvailable: false,
              scoreAvailable: false,
              sourceRows: 0n,
              candidates: 0n,
              identifiedCandidates: 0n,
              unassessed: 0n,
              assessed: 0n,
              shortlisted: 0n,
            },
          ],
          [],
        ) as never,
      );
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          sort,
          sourceEffectId: "historical-page",
          cursor: Buffer.from(
            JSON.stringify({ version: 1, scope, value: "", key: "person" }),
          ).toString("base64url"),
        }),
      ).rejects.toThrow(recruiting.RecruitingConflictError);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["name", undefined, []],
    ["recent", undefined, []],
    ["tier", undefined, []],
    ["rank", "selected-result", []],
    ["rank", undefined, [{ effectId: "first" }, { effectId: "second" }]],
    ["rank", undefined, []],
    ["score", "selected-result", []],
    ["score", undefined, [{ effectId: "first" }, { effectId: "second" }]],
    ["score", undefined, []],
  ] as const)(
    "uses the current %s projection for source %s and pages %j",
    async (sort, sourceEffectId, pages) => {
      const f = fixture();
      f.tx.recruitingCandidatePage.findMany.mockResolvedValue([...pages]);
      const scope = createHash("sha256")
        .update(
          stableJsonValue({
            roleId: "role",
            roleRevisionId: "revision",
            sort,
            ...(sort === "rank" ? { rankProjection: 3 } : {}),
            ...(sort === "score" ? { scoreProjection: 1 } : {}),
            ...(sourceEffectId !== undefined ? { sourceProjection: 2 } : {}),
            query: "",
            assessmentState: null,
            verdict: null,
            shortlisted: null,
            actionId: null,
            sourceEffectId: sourceEffectId ?? null,
          }),
        )
        .digest("hex");
      const cursor = Buffer.from(
        JSON.stringify({ version: 1, scope, value: "1", key: "previous-candidate" }),
      ).toString("base64url");
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(
          [
            {
              total: 0n,
              rankAvailable: false,
              tierAvailable: false,
              scoreAvailable: false,
              sourceRows: 0n,
              candidates: 0n,
              identifiedCandidates: 0n,
              unassessed: 0n,
              assessed: 0n,
              shortlisted: 0n,
            },
          ],
          [],
        ) as never,
      );
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          sort,
          sourceEffectId,
          cursor,
        }),
      ).resolves.toMatchObject({ items: [], nextCursor: null });
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    },
  );
  it.each(["rank", "score"] as const)(
    "rejects pre-native-field %s cursors before they can skip newly recognized values",
    async (sort) => {
      const f = fixture();
      const scope = createHash("sha256")
        .update(
          stableJsonValue({
            roleId: "role",
            roleRevisionId: "revision",
            sort,
            ...(sort === "rank" ? { rankProjection: 2 } : {}),
            sourceProjection: 2,
            query: "",
            assessmentState: null,
            verdict: null,
            shortlisted: null,
            actionId: null,
            sourceEffectId: "selected-result",
          }),
        )
        .digest("hex");
      const cursor = Buffer.from(
        JSON.stringify({ version: 1, scope, value: "", key: "previously-unranked" }),
      ).toString("base64url");
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          sort,
          sourceEffectId: "selected-result",
          cursor,
        }),
      ).rejects.toThrow(recruiting.RecruitingConflictError);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each(["rank", "tier", "score"] as const)(
    "paginates native %s values with unknowns last and isolated single-page rank cursors",
    async (sort) => {
      const f = fixture();
      if (sort !== "tier")
        f.tx.recruitingCandidatePage.findMany.mockResolvedValue([{ effectId: "only-page" }]);
      const row = (key: string, sortValue: string) => ({
        roleId: "role",
        candidateKey: key,
        name: key,
        title: null,
        company: null,
        location: null,
        linkedinUrl: null,
        resumeUrl: null,
        evidenceUrls: null,
        issues: [],
        shortlisted: false,
        shortlistedAt: null,
        consideration: null,
        revision: 0,
        discoveryCount: 1,
        profileSourcePageIds: [],
        firstDiscoveredAt: null,
        lastDiscoveredAt: null,
        assessmentVersion: null,
        assessmentRoleRevisionId: null,
        assessmentCreatedAt: null,
        hardGate: null,
        sortValue,
        matchValue: sortValue ? Number(sortValue) : null,
      });
      const counts = [
        {
          total: 3n,
          rankAvailable: true,
          tierAvailable: true,
          scoreAvailable: true,
          sourceRows: 3n,
          candidates: 3n,
          identifiedCandidates: 0n,
          unassessed: 3n,
          assessed: 0n,
          shortlisted: 0n,
        },
      ];
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(counts, [
          row("a", sort === "score" ? "72.5" : "2"),
          row("b", "10"),
        ]),
      );
      const first = await recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        sort,
        limit: 1,
      });
      expect(first.items[0]?.candidateKey).toBe("a");
      expect(first.sortAvailability).toEqual({ rank: true, tier: true, score: true });
      expect(first.items[0]).not.toHaveProperty("matchValue");
      const firstQuery = f.tx.$queryRaw.mock.lastCall![0] as { sql: string; values: unknown[] };
      expect(firstQuery.sql).toContain(
        `ORDER BY "matchValue" ${sort === "score" ? "DESC" : "ASC"} NULLS LAST, "candidateKey" COLLATE "C" ASC`,
      );
      if (sort !== "tier") {
        expect(firstQuery.sql).toContain("ELSE returned.value -> 'rank_this_batch_only' END");
        expect(firstQuery.values).toContain("only-page");
        expect(firstQuery.sql).not.toContain('p."effectId" =');
        expect(f.tx.recruitingCandidatePage.findMany).toHaveBeenCalledExactlyOnceWith({
          where: { roleId: "role" },
          select: { effectId: true },
          orderBy: [{ observedAt: "desc" }, { effectId: "desc" }],
          take: 1,
        });
        if (sort === "score") {
          // The newest result that carries scores wins over a newer unscored one.
          expect(firstQuery.sql).toContain(
            `AND (scored."matchFields" ? 'match_score' OR scored."matchFields" ? 'score'))`,
          );
          expect(firstQuery.sql).toContain("WHEN source.kind = 'score' THEN");
          const numericScore = firstQuery.sql.slice(
            firstQuery.sql.indexOf("WHEN source.kind = 'score' THEN"),
            firstQuery.sql.indexOf("ELSE CASE match.\"value\" #>> '{}'"),
          );
          // Scores read on 0–100: explicit fractions convert, plain numbers use the result's scale.
          expect(numericScore).toContain("SELECT round(LEAST(100, GREATEST(0, s.v)))");
          expect(numericScore).toContain('* rank_scope."scoreScale"');
          expect(firstQuery.sql).toContain("WHEN max(plain.v) <= 10 THEN 10 ELSE 1 END");
          // Numeric strings ("45") count as provider numbers; "Unknown" does not.
          expect(firstQuery.values).toContain(
            "^[[:space:]]*-?[0-9]{1,30}([.][0-9]{1,30})?[[:space:]]*$",
          );
          expect(firstQuery.sql).toContain(
            'rank_scope."pageId" IS NOT NULL AND page."effectId" = rank_scope."pageId"',
          );
          expect(firstQuery.sql).toContain(
            "CASE WHEN returned.value ? 'match_score' THEN returned.value -> 'match_score'",
          );
          expect(firstQuery.sql).toContain("ELSE returned.value -> 'score' END");
          expect(firstQuery.sql).toContain(
            "(returned.value ? 'match_score' OR returned.value ? 'score') AND",
          );
        }
      } else {
        expect(firstQuery.values).toContain("match_tier");
        expect(firstQuery.sql).toContain('(rank_scope."pageId" IS NOT NULL AND');
        expect(firstQuery.sql).toContain(
          "(returned.value ? 'rank' OR returned.value ? 'batch_rank' OR returned.value ? 'rank_this_batch_only')",
        );
        // Tier sorting still reads the role's domain so rank and score availability stay true.
        expect(f.tx.recruitingCandidatePage.findMany).toHaveBeenCalledOnce();
      }
      expect(firstQuery.sql).toContain(`SELECT match."${sort}PageId"`);
      const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
      for (const value of sort === "score"
        ? ["NaN", "Infinity", "-Infinity", "true", "72 points", "1e3", "1.2.3"]
        : ["-1", "1.5", "NaN", "1e3", "9007199254740992", ...(sort === "tier" ? ["4"] : ["0"])]) {
        const invalid = Buffer.from(JSON.stringify({ ...decoded, value })).toString("base64url");
        await expect(
          recruiting.listRecruitingCandidates(f.prisma, actor, {
            roleId: "role",
            sort,
            cursor: invalid,
          }),
        ).rejects.toThrow(recruiting.RecruitingConflictError);
      }
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
      if (sort === "score")
        for (const sourceEffectId of ["only-page", "other-page"])
          await expect(
            recruiting.listRecruitingCandidates(f.prisma, actor, {
              roleId: "role",
              sort,
              sourceEffectId,
              cursor: first.nextCursor!,
            }),
          ).rejects.toThrow(recruiting.RecruitingConflictError);
      if (sort === "score")
        for (const value of ["0", "-1.25", "72.5"]) {
          f.tx.$queryRaw.mockResolvedValueOnce(candidateProjectionRows(counts, []));
          await expect(
            recruiting.listRecruitingCandidates(f.prisma, actor, {
              roleId: "role",
              sort,
              cursor: Buffer.from(JSON.stringify({ ...decoded, value })).toString("base64url"),
            }),
          ).resolves.toMatchObject({ items: [] });
        }
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(counts, [row("b", ""), row("c", "")]),
      );
      const unknown = await recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        sort,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(unknown.sortAvailability).toEqual({ rank: true, tier: true, score: true });
      const nextQuery = f.tx.$queryRaw.mock.lastCall![0] as { sql: string; values: unknown[] };
      expect(nextQuery.sql).toContain('"matchValue" IS NULL OR');
      expect(nextQuery.sql).toContain("::numeric");
      expect(nextQuery.sql).toContain(`"matchValue" ${sort === "score" ? "<" : ">"} ?::numeric`);
      f.tx.$queryRaw.mockResolvedValueOnce(candidateProjectionRows(counts, [row("c", "")]));
      const last = await recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        sort,
        limit: 1,
        cursor: unknown.nextCursor!,
      });
      expect(last.nextCursor).toBeNull();
      const lastQuery = f.tx.$queryRaw.mock.lastCall![0] as { sql: string; values: unknown[] };
      expect(lastQuery.sql).toContain('"matchValue" IS NULL AND "candidateKey" >');
      f.tx.$queryRaw.mockResolvedValueOnce(candidateProjectionRows(counts));
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          sort,
          limit: 1,
          cursor: Buffer.from(JSON.stringify({ ...decoded, value: "", key: "c" })).toString(
            "base64url",
          ),
        }),
      ).resolves.toMatchObject({
        total: 3,
        items: [],
        nextCursor: null,
        counts: { candidates: 3, sourceRows: 3 },
      });
      await expect(
        recruiting.listRecruitingCandidates(f.prisma, actor, {
          roleId: "role",
          sort: sort === "rank" ? "tier" : "rank",
          cursor: first.nextCursor!,
        }),
      ).rejects.toThrow(recruiting.RecruitingConflictError);
      if (sort !== "tier") {
        // Newest saved result first: it becomes the rank/score domain for the whole role.
        f.tx.recruitingCandidatePage.findMany.mockResolvedValue([{ effectId: "second-page" }]);
        const calls = f.tx.$queryRaw.mock.calls.length;
        await expect(
          recruiting.listRecruitingCandidates(f.prisma, actor, {
            roleId: "role",
            sort,
            cursor: first.nextCursor!,
          }),
        ).rejects.toThrow(recruiting.RecruitingConflictError);
        expect(f.tx.$queryRaw).toHaveBeenCalledTimes(calls);
        f.tx.$queryRaw.mockResolvedValueOnce(candidateProjectionRows(counts, []));
        await recruiting.listRecruitingCandidates(f.prisma, actor, { roleId: "role", sort });
        const multiplePages = f.tx.$queryRaw.mock.lastCall![0] as {
          sql: string;
          values: unknown[];
        };
        expect(multiplePages.sql).not.toContain('CASE WHEN count(*) = 1 THEN min("effectId") END');
        expect(multiplePages.values).toContain("second-page");
        expect(f.tx.recruitingCandidatePage.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            orderBy: [{ observedAt: "desc" }, { effectId: "desc" }],
            take: 1,
          }),
        );
        expect(multiplePages.sql).toContain('(rank_scope."pageId" IS NOT NULL AND');
        expect(multiplePages.sql).toContain(
          "(returned.value ? 'rank' OR returned.value ? 'batch_rank' OR returned.value ? 'rank_this_batch_only')",
        );
        expect(multiplePages.sql).toContain("WHEN returned.value ? 'overall_rank'");
        expect(multiplePages.sql).toContain("THEN returned.value -> 'updated_rank'");
        expect(multiplePages.sql).not.toContain('p."effectId" =');
      }
    },
  );
  it("makes a human shortlist receipt only for a successful candidate CAS change", async () => {
    const f = fixture();
    f.candidate.candidateKey = "internal-candidate-key";
    f.tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "Synthetic Avery",
          linkedinUrl: "https://www.linkedin.com/in/synthetic-avery",
          resumeUrl: null,
          sourcePageId: null,
          profileSourcePageIds: [],
        },
      ]);
    const input = {
      threadId: "thread",
      roleId: "role",
      candidateKey: f.candidate.candidateKey,
      expectedRevision: 0,
      shortlisted: true,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input)).toEqual({
      roleId: "role",
      candidateKey: f.candidate.candidateKey,
      shortlisted: true,
      revision: 1,
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(f.tx, {
      role: "user",
      threadId: "thread",
      clientNonce: 'recruiting-shortlist:["role","revision","internal-candidate-key",0,true]',
      blocks: [
        {
          kind: "text",
          text: "Shortlist Synthetic Avery · https://www.linkedin.com/in/synthetic-avery for Systems engineer (requirements version 1).",
        },
      ],
    });
    expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: f.candidate.candidateKey, revision: 0 },
      data: {
        shortlisted: true,
        shortlistedAt: expect.any(Date),
        revision: 1,
        shortlistMessageId: "human-shortlist-receipt",
      },
    });
    expect(appendEventInTransaction).toHaveBeenCalledExactlyOnceWith(f.tx, {
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      type: "recruiting.changed",
      payload: { roleId: "role" },
    });
    const profileQuery = f.tx.$queryRaw.mock.lastCall![0] as { values: unknown[] };
    expect(profileQuery.values.slice(-2)).toEqual(["role", f.candidate.candidateKey]);
  });
  it("clears shortlistedAt when a candidate leaves the shortlist", async () => {
    const f = fixture();
    Object.assign(f.candidate, { shortlisted: true, revision: 1 });
    f.tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "Synthetic Avery",
          linkedinUrl: null,
          resumeUrl: "r",
          sourcePageId: null,
          profileSourcePageIds: [],
        },
      ]);
    await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      candidateKey: "candidate",
      expectedRevision: 1,
      shortlisted: false,
    });
    expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shortlisted: false, shortlistedAt: null }),
      }),
    );
  });
  it("rejects stale selection and performs no write for a no-op", async () => {
    const f = fixture();
    const input = {
      threadId: "thread",
      roleId: "role",
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: false,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input)).toMatchObject({
      revision: 0,
      shortlisted: false,
    });
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
    expect(appendEventInTransaction).not.toHaveBeenCalled();
    await expect(
      recruiting.setRecruitingCandidateShortlist(f.prisma, actor, {
        ...input,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    f.tx.thread.findFirst.mockResolvedValue({
      ...actor,
      id: "thread",
      botId: "bot",
      activeRecruitingRoleId: "changed-role",
    });
    await expect(
      recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input),
    ).rejects.toThrow(IsolationError);
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
  });
});

function observationFixture(rows: readonly unknown[] | undefined) {
  const f = fixture();
  const now = new Date("2026-10-16T00:00:00.000Z");
  const hash = "a".repeat(64);
  const run = {
    ...actor,
    id: "run",
    threadId: "thread",
    botId: "bot",
    bot: actor,
    status: "completed",
  };
  const human = {
    id: "human",
    threadId: "thread",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Search examples" }],
  };
  const revision = {
    id: "revision",
    roleId: "role",
    revision: 1,
    createdAt: now,
    sourceRefs: [
      {
        id: "human",
        kind: "original_material",
        anchor: { kind: "message", messageId: "human", locator: "text:0" },
        readState: "unread",
        readAt: null,
      },
    ],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
  };
  const action = {
    id: "action",
    taskId: "task",
    roleRevisionId: "revision",
    runId: "run",
    sourceMessageId: "human",
    clientNonce: "action-nonce",
    kind: "create",
    purpose: "calibration",
    candidateOutputSchema: "candidate_output_v1",
    approvalEffectId: "approval",
    deliveryState: "accepted",
    observedProviderState: null,
    requestArtifactId: "request",
    requestArtifactHash: hash,
    contextArtifactId: "context",
    contextArtifactHash: hash,
    recallScope: null,
    receiptArtifactId: null,
    receiptArtifactHash: null,
    outputArtifacts: [],
    cursor: null,
    effectId: null,
    usage: null,
  };
  const task = {
    id: "task",
    roleId: "role",
    mcpServerId: "server",
    serverRevision: 1,
    providerTaskId: "provider-task",
    pendingActionId: "action",
    state: "active",
    createdByRunId: "run",
  };
  const request = [
    "__rakazoCatalogTool",
    "direct",
    {
      route: {
        connectorId: "mcp",
        resourceId: "server",
        resourceRevision: 1,
        toolName: "get_rows",
      },
      args: { task_id: "provider-task" },
    },
  ];
  const rawResult =
    rows === undefined
      ? { content: [{ type: "text", text: "No structured result supplied" }] }
      : { structuredContent: { rows } };
  const effect = {
    ...actor,
    id: "read",
    runId: "run",
    status: "completed",
    request,
    result: rawResult,
    createdAt: now,
    updatedAt: now,
  };
  const artifacts = new Map(
    ["request", "context"].map((id) => [
      id,
      { ...actor, id, hash, botId: "bot", groupId: null, runId: "run", storageKey: id },
    ]),
  );
  const tx = {
    ...f.tx,
    recruitingCrmWorkspaceAttachment: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    recruitingRole: {
      findFirst: vi.fn(async () => ({ ...f.role, title: "Example engineer" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    run: { findFirst: vi.fn(async () => run), findUniqueOrThrow: vi.fn(async () => run) },
    recruitingRoleRevision: { findFirst: vi.fn(async () => revision) },
    recruitingResearchAction: {
      findFirst: vi.fn(async () => action),
      findUniqueOrThrow: vi.fn(async () => action),
      update: vi.fn(async ({ data }) => ({ ...action, ...data })),
    },
    recruitingResearchTask: {
      findUnique: vi.fn(async () => task),
      findUniqueOrThrow: vi.fn(async () => task),
    },
    mcpServer: { findFirst: vi.fn(async () => ({ ...actor, id: "server", revision: 1 })) },
    message: { findMany: vi.fn(async () => [human]), findUnique: vi.fn(async () => human) },
    artifact: {
      findFirst: vi.fn(async ({ where }) => artifacts.get(where.id)),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async ({ where }) => artifacts.get(where.id)),
      create: vi.fn(async ({ data }) => ({ id: "observation-artifact", ...data })),
    },
    externalEffect: { findFirst: vi.fn(async () => effect) },
    event: {
      findMany: vi.fn(async () => [
        {
          id: "binding",
          seq: 1,
          spaceId: actor.spaceId,
          threadId: "thread",
          botId: "bot",
          runId: "run",
          type: "recruiting.read",
          payload: {
            phase: "bound",
            taskId: "task",
            actionId: "action",
            effectId: "read",
            toolName: "get_rows",
          },
          createdAt: now,
        },
      ]),
    },
    recruitingCandidatePage: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => data),
    },
    recruitingCandidate: {
      ...f.tx.recruitingCandidate,
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    recruitingCandidateOccurrence: {
      createMany: vi.fn(async (_input: unknown) => ({ count: rows?.length ?? 0 })),
      findMany: vi.fn(async (_input: unknown) => [
        { rowIndex: 0, candidateKey: "source-row:read:0" },
      ]),
    },
  };
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  const input = {
    runId: "run",
    actionId: "action",
    effectId: "read",
    request,
    rawResult,
    toolName: "get_rows" as const,
    ...(rows === undefined ? {} : { rows }),
    outputArtifact: {
      name: "observation.json",
      mimeType: "application/json",
      size: 1,
      hash,
      storageKey: "observation",
      clientNonce: "recruiting-observation:read",
    },
  };
  return {
    prisma,
    tx,
    input,
    action,
    artifacts,
    now,
    hash,
    effect,
    task,
    run,
    revision,
    role: f.role,
  };
}

function crmFixture(additionalRows: readonly unknown[] = []) {
  const raw = {
    name: "Example",
    linkedin_url: "https://www.linkedin.com/in/example",
    current_title: "Engineer",
    current_company: "Example Company",
    location: "London",
    resume_url: null,
    evidence_urls: [],
  };
  const f = observationFixture([raw, ...additionalRows]);
  Object.assign(f.run, {
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const target = {
    mcpServerId: "crm-server",
    serverRevision: 2,
    organizationId: "10000000-0000-4000-8000-000000000001",
    crmRoleId: "20000000-0000-4000-8000-000000000002",
    crmClientId: "30000000-0000-4000-8000-000000000003",
    clientLabel: "Client",
    roleLabel: "Engineer",
  };
  const bindingInput = {
    operation: "bind" as const,
    roleId: "role",
    expectedRoleRevision: 1,
    expectedBindingEffectId: null,
    crmRoleReadEffectId: "crm-read",
  };
  const binding = {
    id: "binding-effect",
    spaceId: actor.spaceId,
    runId: "run",
    kind: "recruiting_crm_target",
    status: "completed",
    request: bindingInput as unknown,
    result: {
      status: "connected",
      roleId: "role",
      bindingEffectId: "binding-effect",
      target,
    } as unknown,
    createdAt: f.now,
  };
  const crmRead = {
    id: "crm-read",
    spaceId: actor.spaceId,
    runId: "run",
    kind: "mcp__crm__get_crm_role",
    status: "completed",
    request: boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: target.mcpServerId,
        resourceRevision: 2,
        toolName: "get_crm_role",
      },
      { p_org: target.organizationId, p_role: target.crmRoleId },
      "__rakazoCatalogTool",
    ),
    result: {
      structuredContent: {
        data: {
          role_spec_id: target.crmRoleId,
          client_id: target.crmClientId,
          client_label: target.clientLabel,
          role_label: target.roleLabel,
        },
      },
    },
    createdAt: f.now,
  };
  const effects = new Map<string, typeof binding>([
    [binding.id, binding],
    [crmRead.id, crmRead as never],
    [f.effect.id, f.effect as never],
  ]);
  const approvals = new Set([binding.id]);
  const cards = new Set([binding.id]);
  const role = { ...f.role, title: "Native role", crmBindingEffectId: binding.id as string | null };
  const page = {
    effectId: "read",
    effect: f.effect,
    roleId: "role",
    taskId: "task",
    actionId: "action",
    roleRevisionId: "revision",
    artifactId: "observation-artifact",
    artifactHash: f.hash,
    requestCursor: null,
    outputId: null,
    observedAt: f.now,
    rowCount: 1 + additionalRows.length,
  };
  const { candidateKey, ...profile } = normalizeRecruitingCandidateRow(raw, {
    schemaKnown: true,
  });
  const occurrence = {
    pageId: page.effectId,
    rowIndex: 0,
    roleId: "role",
    candidateKey: candidateKey ?? `source-row:${page.effectId}:0`,
    ...profile,
    page,
  };
  const links: Array<{
    effectId: string;
    bindingEffectId: string;
    pageId: string;
    rowIndex: number;
  }> = [];
  const input = {
    roleId: role.id,
    candidateKey: occurrence.candidateKey,
    bindingEffectId: binding.id,
    sourceEffectId: page.effectId,
    rowIndex: 0,
  };
  const trusted = {
    runId: "run",
    threadId: "thread",
    botId: "bot",
    leaseOwner: "worker",
    leaseFence: 1,
  };
  const artifact = {
    ...actor,
    id: page.artifactId,
    hash: f.hash,
    botId: "bot",
    groupId: null,
    runId: "run",
    storageKey: "observation",
    clientNonce: "recruiting-observation:read",
  };
  f.artifacts.set(artifact.id, artifact);
  f.action.outputArtifacts = [{ artifactId: artifact.id, sha256: f.hash }] as never;
  const sourceEvents = [
    {
      id: "read-bound",
      seq: 1,
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "recruiting.read",
      createdAt: f.now,
      payload: {
        phase: "bound",
        taskId: "task",
        actionId: "action",
        effectId: "read",
        toolName: "get_rows",
      },
    },
    {
      id: "read-recorded",
      seq: 2,
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "recruiting.read",
      createdAt: f.now,
      payload: {
        phase: "recorded",
        taskId: "task",
        actionId: "action",
        effectId: "read",
        outputArtifact: { artifactId: artifact.id, sha256: f.hash },
      },
    },
  ];
  const runs = new Map([["run", f.run]]);
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    recruitingCandidate: {
      ...f.tx.recruitingCandidate,
      findUnique: vi.fn(async () => ({
        roleId: role.id,
        candidateKey: occurrence.candidateKey,
        consideration: null,
        shortlisted: false,
        shortlistedAt: null,
        revision: 0,
      })),
    },
    run: {
      findFirst: vi.fn(async ({ where }) => runs.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }) =>
        [...runs.values()].filter((run) => where.id.in.includes(run.id)),
      ),
      findUnique: vi.fn(async ({ where }) => runs.get(where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const run = runs.get(where.id);
        if (!run) throw new IsolationError();
        return run;
      }),
    },
    recruitingCrmWorkspaceAttachment: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }) =>
        typeof where.id === "object" && where.id.not === role.id ? null : role,
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.crmBindingEffectId !== role.crmBindingEffectId ||
          where.revision !== role.revision
        )
          return { count: 0 };
        Object.assign(role, data);
        return { count: 1 };
      }),
    },
    mcpServer: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "crm-server"
          ? { ...actor, id: "crm-server", revision: 2, enabled: true }
          : { ...actor, id: "server", revision: 1, enabled: true },
      ),
    },
    botMcpServer: {
      findFirst: vi.fn(async (_query: { where: { serverId: string } }) => ({
        allowAllTools: false,
        allowedTools: ["get_crm_role", "crm_import_candidate"],
      })),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }) =>
        [...effects.values()]
          .filter(
            (effect) =>
              effect.spaceId === where.spaceId &&
              effect.runId === where.runId &&
              (!where.status || effect.status === where.status),
          )
          .sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
          ),
      ),
      findFirst: vi.fn(async ({ where }) => {
        const effect = effects.get(where.id);
        return effect &&
          (!where.status || effect.status === where.status) &&
          (!where.spaceId || effect.spaceId === where.spaceId) &&
          (!where.runId || effect.runId === where.runId)
          ? effect
          : null;
      }),
      findUnique: vi.fn(async ({ where }) =>
        where.id
          ? (effects.get(where.id) ?? null)
          : ([...effects.values()].find(
              (effect) =>
                (effect as never as { idempotencyKey?: string }).idempotencyKey ===
                where.idempotencyKey,
            ) ?? null),
      ),
      create: vi.fn(async ({ data }) => {
        const effect = { ...data, id: `import-${effects.size}`, createdAt: new Date() };
        effects.set(effect.id, effect);
        return effect;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const effect = effects.get(where.id);
        if (!effect || (where.status && effect.status !== where.status)) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      }),
    },
    message: {
      ...f.tx.message,
      findFirst: vi.fn(async ({ where }) => {
        const id = where.blocks.array_contains[0].approvalEffectId;
        return cards.has(id) ? { id: `approval-card:${id}` } : null;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (!where.id.startsWith("approval-card:")) return await f.tx.message.findUnique();
        const id = where.id.slice("approval-card:".length);
        return {
          id: where.id,
          threadId: "thread",
          runId: "run",
          botId: "bot",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Approve",
              approvalEffectId: id,
              status: "answered",
              answer: "allow",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        } as never;
      }),
    },
    event: {
      findMany: vi.fn(async () => sourceEvents),
      findFirst: vi.fn(async ({ where }) => {
        const id = where.payload.equals;
        const effect = effects.get(id);
        return effect && approvals.has(id)
          ? {
              createdAt: f.now,
              payload: {
                effectId: id,
                messageId: `approval-card:${id}`,
                askIndex: 0,
                answeredByUserId: actor.userId,
                answer: "allow",
                requestHash: createHash("sha256")
                  .update(stableJsonValue(effect.request))
                  .digest("hex"),
              },
            }
          : null;
      }),
    },
    artifact: { ...f.tx.artifact, findUnique: vi.fn(async () => artifact) },
    recruitingCandidatePage: {
      ...f.tx.recruitingCandidatePage,
      findUnique: vi.fn(async ({ where }) => (where.effectId === page.effectId ? page : null)),
    },
    recruitingCandidateOccurrence: {
      ...f.tx.recruitingCandidateOccurrence,
      findUnique: vi.fn(async ({ where }) =>
        where.pageId_rowIndex.pageId === page.effectId && where.pageId_rowIndex.rowIndex === 0
          ? occurrence
          : null,
      ),
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => [occurrence]),
    },
    recruitingCrmImport: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.bindingEffectId_pageId_rowIndex;
        const link = links.find((item) =>
          where.effectId
            ? item.effectId === where.effectId
            : item.bindingEffectId === key.bindingEffectId &&
              item.pageId === key.pageId &&
              item.rowIndex === key.rowIndex,
        );
        return link ? { ...link, effect: effects.get(link.effectId), occurrence } : null;
      }),
      create: vi.fn(async ({ data }) => {
        links.push(data);
        return data;
      }),
      findMany: vi.fn(async () =>
        links.map((link) => ({ ...link, effect: effects.get(link.effectId), occurrence })),
      ),
    },
  };
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  return {
    prisma,
    tx,
    target,
    bindingInput,
    binding,
    effects,
    approvals,
    cards,
    role,
    page,
    occurrence,
    links,
    input,
    trusted,
    run: f.run,
    runs,
  };
}

describe("canonical CRM conversation locators", () => {
  it("projects native bindings and persisted UI locators in one scoped batch without treating either as authorization", async () => {
    const f = crmFixture();
    const reference = {
      sourceId: f.target.mcpServerId,
      serverRevision: f.target.serverRevision,
      organizationId: f.target.organizationId,
      crmRoleId: f.target.crmRoleId,
    };
    const groupId = recruiting.recruitingCrmConversationId(actor, reference);
    const read = f.effects.get("crm-read")!;
    const bound = {
      groupId: "existing-group",
      roleId: f.role.id,
      bindingEffectId: f.binding.id,
      bindingRequest: f.binding.request,
      bindingResult: f.binding.result,
      readStatus: read.status,
      readRequest: read.request,
      readResult: read.result,
      ownerMatches: true,
      reference: null,
      sourceRevision: 3,
    };
    const selected = { ...bound, groupId, roleId: null, bindingEffectId: null, reference };
    const $queryRaw = vi.fn(async (_query: unknown) => [bound, selected]);
    const result = await recruiting.getRecruitingGroupCrmReferences({ $queryRaw } as never, actor, [
      bound.groupId,
      groupId,
    ]);
    expect([...result]).toEqual([
      [bound.groupId, reference],
      [groupId, { ...reference, serverRevision: 3 }],
    ]);
    expect($queryRaw).toHaveBeenCalledOnce();
    const sql = $queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.values).toContain(actor.userId);
    expect(sql.values).toContain(actor.spaceId);
    expect(sql.sql).toContain("LEFT JOIN LATERAL");
    expect(sql.sql).toContain("group.created");
    expect(sql.sql).not.toContain("FROM messages");
    expect(sql.sql).toContain("LEFT JOIN mcp_servers");
    expect(
      recruiting.recruitingCrmConversationId({ ...actor, spaceId: "foreign" }, reference),
    ).not.toBe(groupId);
    expect(recruiting.recruitingCrmConversationId(actor, { ...reference, serverRevision: 9 })).toBe(
      groupId,
    );
  });
  it.each(["owner", "target", "request", "status", "group"])(
    "rejects %s identity without reviving older UI metadata",
    async (boundary) => {
      const f = crmFixture();
      const reference = {
        sourceId: f.target.mcpServerId,
        serverRevision: 2,
        organizationId: f.target.organizationId,
        crmRoleId: f.target.crmRoleId,
      };
      const read = f.effects.get("crm-read")!;
      const row = {
        groupId: "existing-group",
        roleId: f.role.id,
        bindingEffectId: f.binding.id as string | null,
        bindingRequest: f.binding.request,
        bindingResult: f.binding.result,
        readStatus: read.status,
        readRequest: read.request,
        readResult: read.result,
        ownerMatches: true,
        reference,
      };
      if (boundary === "owner") row.ownerMatches = false;
      if (boundary === "target")
        row.bindingResult = {
          ...(f.binding.result as object),
          target: { ...f.target, crmRoleId: reference.organizationId },
        };
      if (boundary === "request") row.bindingRequest = { ...f.bindingInput, roleId: "other-role" };
      if (boundary === "status") row.readStatus = "failed";
      if (boundary === "group") row.bindingEffectId = null;
      const $queryRaw = vi.fn(async () => [row]);
      expect(
        (
          await recruiting.getRecruitingGroupCrmReferences({ $queryRaw } as never, actor, [
            row.groupId,
          ])
        ).size,
      ).toBe(0);
    },
  );
});

describe("task-backed candidate page proof reads", () => {
  it("scopes research read-binding events to the owner run, not the whole space event log", async () => {
    const f = crmFixture();
    f.tx.event.findMany.mockClear();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items).toHaveLength(1);
    const reads = f.tx.event.findMany.mock.calls
      .map((call) => (call as unknown as [{ where: Record<string, unknown> }])[0].where)
      .filter((where) => where.type === "recruiting.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const where of reads)
      expect(where).toMatchObject({ spaceId: actor.spaceId, runId: "run" });
  });
});

describe("native CRM write approval target", () => {
  const route = {
    connectorId: "mcp" as const,
    resourceId: "crm-server",
    resourceRevision: 2,
    toolName: "crm_update_candidate_stage",
  };
  const args = {
    p_org: "10000000-0000-4000-8000-000000000001",
    p_candidate: "40000000-0000-4000-8000-000000000004",
    p_role: "20000000-0000-4000-8000-000000000002",
    p_expected_updated_at: "2026-01-01T00:00:00.123456+00:00",
    p_expected_stage: "Screening",
    p_stage: "Interview",
  };
  function targetFixture() {
    const f = crmFixture();
    f.tx.mcpServer.findFirst.mockResolvedValue({
      ...actor,
      id: route.resourceId,
      revision: route.resourceRevision,
      enabled: true,
    });
    f.tx.botMcpServer.findFirst.mockResolvedValue({
      allowAllTools: false,
      allowedTools: ["get_crm_candidate_review", route.toolName, "crm_append_candidate_note"],
    });
    const row = {
      id: "pipeline-row",
      organization_id: args.p_org,
      candidate_id: args.p_candidate,
      role_spec_id: args.p_role,
      candidate_full_name: "Ada Example",
      canonical_role_title: "Platform Engineer",
      stage: args.p_expected_stage,
      notes: "Old private business context",
      updated_at: args.p_expected_updated_at,
    };
    const effect = {
      ...f.binding,
      id: "review-read",
      kind: "renamed_read",
      request: boundDirectApprovalRequest(
        { ...route, toolName: "get_crm_candidate_review" },
        { p_org: args.p_org, p_candidate: args.p_candidate },
        "__rakazoCatalogTool",
      ) as unknown,
      result: { structuredContent: { data: row } } as unknown,
    };
    f.effects.set(effect.id, effect);
    return { ...f, row, effect };
  }
  const bindingRoute = { ...route, toolName: "crm_bind_candidate_role" };
  const bindingArgs = { p_org: args.p_org, p_candidate: args.p_candidate, p_role: args.p_role };
  function roleBindingFixture(catalog = false) {
    const f = targetFixture();
    f.effects.delete(f.effect.id); // A candidate without a pipeline has no review snapshot.
    f.tx.botMcpServer.findFirst.mockResolvedValue({
      allowAllTools: false,
      allowedTools: ["list_crm_candidates", "get_crm_role", bindingRoute.toolName],
    });
    const listArgs = { p_org: args.p_org, p_q: "Ada", p_limit: 10, p_offset: 20 };
    const row = {
      candidate_id: args.p_candidate,
      full_name: "Ada Example",
      role_label: "Source-only label",
      client_label: "Source-only client",
    };
    const listRead = {
      ...f.effect,
      id: "list-read",
      request: boundDirectApprovalRequest(
        { ...route, toolName: "list_crm_candidates" },
        listArgs,
        "__rakazoCatalogTool",
      ) as unknown,
      result: { structuredContent: { data: { total: 1, rows: [row] } } } as unknown,
    };
    f.effects.set(listRead.id, listRead);
    const roleRead = f.effects.get("crm-read")!;
    if (catalog)
      for (const [effect, toolName, readArgs] of [
        [listRead, "list_crm_candidates", listArgs],
        [roleRead, "get_crm_role", { p_org: args.p_org, p_role: args.p_role }],
      ] as const)
        effect.request = catalogApprovalRequest(
          "mcp_execute_tool",
          { id: `crm-server:${toolName}`, arguments: readArgs },
          "__rakazoCatalogTool",
          { ...route, toolName },
        );
    return { ...f, listArgs, listRead, roleRead, row };
  }
  it.each([false, true])(
    "projects a role binding from native list and canonical role reads without a pipeline, catalog=%s",
    async (catalog) => {
      const f = roleBindingFixture(catalog);
      await expect(
        recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, {
          route: bindingRoute,
          args: { ...bindingArgs, candidateName: "Model name", roleTitle: "Model role" },
        }),
      ).resolves.toEqual({
        candidateName: "Ada Example",
        roleTitle: f.target.roleLabel,
        clientName: f.target.clientLabel,
      });
      expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["failed", "uncertain", "empty", "missing-structured"])(
    "does not recover a binding name from an older result after the same list query is %s",
    async (state) => {
      const f = roleBindingFixture();
      f.effects.set("newer-list", {
        ...f.listRead,
        id: "newer-list",
        createdAt: new Date(f.listRead.createdAt.getTime() + 1),
        request: catalogApprovalRequest(
          "connectors_execute_tool",
          { id: "crm-server:list_crm_candidates", arguments: f.listArgs },
          "__rakazoCatalogTool",
          { ...route, toolName: "list_crm_candidates" },
        ),
        status: state === "uncertain" ? "uncertain" : "completed",
        result:
          state === "empty"
            ? { structuredContent: { data: { total: 0, rows: [] } } }
            : state === "missing-structured"
              ? { content: [{ type: "text", text: JSON.stringify(f.listRead.result) }] }
              : { isError: true },
      });
      await expect(
        recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, {
          route: bindingRoute,
          args: bindingArgs,
        }),
      ).rejects.toThrow(IsolationError);
    },
  );
  it("keeps a different list query from invalidating the exact candidate read", async () => {
    const f = roleBindingFixture();
    f.effects.set("other-query", {
      ...f.listRead,
      id: "other-query",
      createdAt: new Date(f.listRead.createdAt.getTime() + 1),
      request: boundDirectApprovalRequest(
        { ...route, toolName: "list_crm_candidates" },
        { ...f.listArgs, p_q: "Other person" },
        "__rakazoCatalogTool",
      ),
      result: { structuredContent: { data: { total: 0, rows: [] } } },
    });
    await expect(
      recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, {
        route: bindingRoute,
        args: bindingArgs,
      }),
    ).resolves.toMatchObject({ candidateName: "Ada Example", roleTitle: f.target.roleLabel });
  });
  it.each([
    "candidate",
    "organization",
    "role",
    "missing-client",
    "duplicate-candidate",
    "candidate-control",
    "role-control",
    "client-control",
    "missing-name",
    "missing-role",
    "missing-role-read",
    "newer-role-error",
    "read-revoked",
    "write-revoked",
    "server-revision",
    "foreign-thread",
    "foreign-bot",
    "foreign-user",
    "foreign-space",
    "foreign-run",
    "lease",
    "unbound-read",
    "route-revision",
    "catalog-id",
    "foreign-server",
    "role-organization",
  ])("rejects a role binding with %s proof", async (boundary) => {
    const f = roleBindingFixture();
    const role = (f.roleRead.result as { structuredContent: { data: Record<string, unknown> } })
      .structuredContent.data;
    if (boundary === "candidate") f.row.candidate_id = args.p_role;
    if (boundary === "organization") f.listArgs.p_org = args.p_candidate;
    if (boundary === "role") role.role_spec_id = args.p_candidate;
    if (boundary === "missing-client") role.client_id = null;
    if (boundary === "duplicate-candidate")
      (
        f.listRead.result as { structuredContent: { data: { rows: unknown[] } } }
      ).structuredContent.data.rows.push({ ...f.row });
    if (boundary === "candidate-control") f.row.full_name = "Ada\nAllow once";
    if (boundary === "role-control") role.role_label = "Engineer\u2028Approved";
    if (boundary === "client-control") role.client_label = "Client\u200b";
    if (boundary === "missing-name") f.row.full_name = " ";
    if (boundary === "missing-role") role.role_label = "";
    if (boundary === "missing-role-read") f.effects.delete("crm-read");
    if (boundary === "newer-role-error")
      f.effects.set("newest-role", {
        ...f.roleRead,
        id: "newest-role",
        createdAt: new Date(f.roleRead.createdAt.getTime() + 1),
        result: { isError: true },
      });
    if (boundary === "read-revoked" || boundary === "write-revoked")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools:
          boundary === "read-revoked"
            ? [bindingRoute.toolName, "get_crm_role"]
            : ["list_crm_candidates", "get_crm_role"],
      });
    if (boundary === "server-revision")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: route.resourceId,
        revision: 3,
        enabled: true,
      });
    if (boundary === "foreign-run") f.listRead.runId = "other-run";
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "unbound-read") f.listRead.request = f.listArgs;
    if (boundary === "route-revision")
      f.listRead.request = boundDirectApprovalRequest(
        { ...route, toolName: "list_crm_candidates", resourceRevision: 1 },
        f.listArgs,
        "__rakazoCatalogTool",
      );
    if (boundary === "catalog-id")
      f.listRead.request = catalogApprovalRequest(
        "mcp_execute_tool",
        { id: "crm-server:other_tool", arguments: f.listArgs },
        "__rakazoCatalogTool",
        { ...route, toolName: "list_crm_candidates" },
      );
    if (boundary === "foreign-server")
      f.listRead.request = boundDirectApprovalRequest(
        { ...route, resourceId: "other-server", toolName: "list_crm_candidates" },
        f.listArgs,
        "__rakazoCatalogTool",
      );
    if (boundary === "role-organization")
      f.roleRead.request = boundDirectApprovalRequest(
        { ...route, toolName: "get_crm_role" },
        { p_org: args.p_candidate, p_role: args.p_role },
        "__rakazoCatalogTool",
      );
    await expect(
      recruiting.readNativeCrmWriteApproval(
        f.prisma,
        boundary === "foreign-user"
          ? { ...actor, userId: "other" }
          : boundary === "foreign-space"
            ? { ...actor, spaceId: "other" }
            : actor,
        {
          ...f.trusted,
          ...(boundary === "foreign-thread" ? { threadId: "other" } : {}),
          ...(boundary === "foreign-bot" ? { botId: "other" } : {}),
        },
        { route: bindingRoute, args: bindingArgs },
      ),
    ).rejects.toThrow(IsolationError);
  });
  it.each([false, true])(
    "projects only the verified target and exact change, catalog=%s",
    async (catalog) => {
      const f = targetFixture();
      if (catalog)
        f.effect.request = catalogApprovalRequest(
          "mcp_execute_tool",
          {
            id: "crm-server:get_crm_candidate_review",
            arguments: { p_org: args.p_org, p_candidate: args.p_candidate },
          },
          "__rakazoCatalogTool",
          { ...route, toolName: "get_crm_candidate_review" },
        );
      await expect(
        recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, { route, args }),
      ).resolves.toEqual({
        candidateName: f.row.candidate_full_name,
        roleTitle: f.row.canonical_role_title,
        currentStage: args.p_expected_stage,
        newStage: args.p_stage,
      });
      const { p_expected_stage: _oldStage, p_stage: _newStage, ...scope } = args;
      const noteArgs = {
        ...scope,
        p_expected_notes: f.row.notes,
        p_note: "  Exact note.\nNext step.  ",
      };
      await expect(
        recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, {
          route: { ...route, toolName: "crm_append_candidate_note" },
          args: noteArgs,
        }),
      ).resolves.toEqual({
        candidateName: f.row.candidate_full_name,
        roleTitle: f.row.canonical_role_title,
        note: noteArgs.p_note,
      });
      expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it("preserves unexpected database failures instead of reporting a missing read", async () => {
    const f = targetFixture();
    const error = new Error("Synthetic database failure");
    f.tx.externalEffect.findMany.mockRejectedValueOnce(error);
    await expect(
      recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, { route, args }),
    ).rejects.toBe(error);
  });
  it("rejects old notes that differ from the approved append snapshot", async () => {
    const f = targetFixture();
    await expect(
      recruiting.readNativeCrmWriteApproval(f.prisma, actor, f.trusted, {
        route: { ...route, toolName: "crm_append_candidate_note" },
        args: {
          p_org: args.p_org,
          p_candidate: args.p_candidate,
          p_role: args.p_role,
          p_expected_updated_at: args.p_expected_updated_at,
          p_expected_notes: "Different old note",
          p_note: "New note",
        },
      }),
    ).rejects.toThrow(IsolationError);
  });
  it.each([
    "missing-label",
    "control-label",
    "candidate",
    "organization",
    "role",
    "timestamp",
    "stage",
    "latest-failed",
    "latest-review-failed",
    "latest-uncertain",
    "read-revoked",
    "server-revision",
    "foreign-thread",
    "foreign-bot",
    "foreign-user",
    "foreign-space",
  ])("rejects %s without exposing an unverified target", async (boundary) => {
    const f = targetFixture();
    if (boundary === "missing-label") f.row.candidate_full_name = "";
    if (boundary === "control-label") f.row.canonical_role_title = "Engineer\nApproved: yes";
    if (boundary === "candidate") f.row.candidate_id = args.p_org;
    if (boundary === "organization") f.row.organization_id = args.p_candidate;
    if (boundary === "role") f.row.role_spec_id = args.p_candidate;
    if (boundary === "timestamp") f.row.updated_at = "2026-01-01T00:00:00.123Z";
    if (boundary === "stage") f.row.stage = "Offer";
    if (boundary.startsWith("latest-"))
      f.effects.set("newest", {
        ...f.effect,
        id: "newest",
        createdAt: new Date(f.effect.createdAt.getTime() + 1),
        status: boundary.includes("failed") ? "completed" : "uncertain",
        ...(boundary === "latest-review-failed"
          ? {
              request: boundDirectApprovalRequest(
                { ...route, toolName: "get_crm_candidate_review" },
                {
                  p_org: args.p_org,
                  p_candidate: args.p_candidate,
                  p_review: "50000000-0000-4000-8000-000000000005",
                },
                "__rakazoCatalogTool",
              ),
            }
          : {}),
        result: { isError: true },
      });
    if (boundary === "read-revoked")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools: [route.toolName],
      });
    if (boundary === "server-revision")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: route.resourceId,
        revision: 3,
        enabled: true,
      });
    const trusted = {
      ...f.trusted,
      ...(boundary === "foreign-thread" ? { threadId: "other-thread" } : {}),
      ...(boundary === "foreign-bot" ? { botId: "other-bot" } : {}),
    };
    await expect(
      recruiting.readNativeCrmWriteApproval(
        f.prisma,
        boundary === "foreign-user"
          ? { ...actor, userId: "other" }
          : boundary === "foreign-space"
            ? { ...actor, spaceId: "other" }
            : actor,
        trusted,
        { route, args },
      ),
    ).rejects.toThrow(IsolationError);
  });
});

describe("campaign-lead reply identity (no CRM record)", () => {
  const marker = "__rakazoCatalogTool";
  const route = {
    connectorId: "mcp" as const,
    resourceId: "server",
    resourceRevision: 1,
    toolName: "native_instantly_list_leads",
  };
  const input = { mcpServerId: "server", serverRevision: 1, recipient: "Admin1@wekruit.com" };
  function leadFixture({ binding = true, read = true, recorded = false } = {}) {
    const f = crmFixture();
    f.role.crmBindingEffectId = null; // "No CRM role linked"
    if (binding)
      f.effects.set("campaign-binding", {
        id: "campaign-binding",
        spaceId: actor.spaceId,
        runId: "older-run",
        kind: "instantly_role_campaign",
        status: "completed",
        idempotencyKey: "instantly-role-campaign:server:role",
        request: { serverId: "server", roleId: "role" },
        result: {
          campaignId: "c-1",
          campaignName: "Native role",
          eaccount: "team@example.test",
          leads: recorded
            ? { "linkedin:/in/admin": { leadId: "lead-recorded", email: "admin1@wekruit.com" } }
            : {},
        },
        createdAt: new Date(),
      } as never);
    if (read)
      f.effects.set("lead-read", {
        id: "lead-read",
        spaceId: actor.spaceId,
        runId: "run",
        kind: "mcp__server__native_instantly_list_leads",
        status: "completed",
        request: boundDirectApprovalRequest(route, { campaign_id: "c-1", limit: 50 }, marker),
        result: {
          structuredContent: {
            source: "local_native_instantly_rest",
            result: { items: [{ id: "lead-1", email: "admin1@wekruit.com", campaign: "c-1" }] },
          },
        },
        createdAt: new Date(),
      } as never);
    return f;
  }
  it("resolves a campaign lead from this run's list_leads read with a stable surrogate identity", async () => {
    const f = leadFixture();
    await expect(
      recruiting.resolveRecruitingCampaignLead(f.prisma, actor, f.trusted, input),
    ).resolves.toEqual({
      roleId: "role",
      campaignId: "c-1",
      eaccount: "team@example.test",
      email: "admin1@wekruit.com",
      leadId: "lead-1",
      identity: "lead:c-1:admin1@wekruit.com",
      leadReadEffectId: "lead-read",
    });
  });
  it("accepts a lead the role's own campaign binding recorded when no read exists", async () => {
    const f = leadFixture({ read: false, recorded: true });
    await expect(
      recruiting.resolveRecruitingCampaignLead(f.prisma, actor, f.trusted, input),
    ).resolves.toMatchObject({ leadId: "lead-recorded", leadReadEffectId: "campaign-binding" });
  });
  it("returns null for an address that is neither a lead nor recorded, or without a campaign", async () => {
    const stranger = { ...input, recipient: "stranger@example.test" };
    await expect(
      recruiting.resolveRecruitingCampaignLead(
        leadFixture().prisma,
        actor,
        leadFixture().trusted,
        stranger,
      ),
    ).resolves.toBeNull();
    const f = leadFixture({ binding: false });
    await expect(
      recruiting.resolveRecruitingCampaignLead(f.prisma, actor, f.trusted, input),
    ).resolves.toBeNull();
  });
});

describe("native reply email proof", () => {
  const route = {
    connectorId: "mcp" as const,
    resourceId: "mail-server",
    resourceRevision: 1,
    toolName: "reply_to_email" as const,
  };
  const input = { route, replyToEmailId: "inbound-email" };
  const readRoute = { ...route, toolName: "get_email" };
  const proofRequest = boundDirectApprovalRequest(
    readRoute,
    { id: input.replyToEmailId },
    "__rakazoCatalogTool",
  );
  function proofFixture() {
    const f = crmFixture();
    f.tx.mcpServer.findFirst.mockResolvedValue({
      ...actor,
      id: "mail-server",
      revision: 1,
      enabled: true,
    });
    f.tx.botMcpServer.findFirst.mockResolvedValue({
      allowAllTools: false,
      allowedTools: ["get_email", "reply_to_email"],
    });
    const effect = {
      ...f.binding,
      id: "email-read",
      kind: "mcp__mail__get_email",
      request: proofRequest as unknown,
      result: { content: [{ type: "text", text: '{"id":"inbound-email"}' }] } as unknown,
    };
    f.effects.set(effect.id, effect);
    return { ...f, effect };
  }
  it("reads the exact canonical direct native receipt without provider parsing or mutation", async () => {
    expect(recruiting.readNativeReplyEmailProof).toBeTypeOf("function");
    const f = proofFixture();
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
    ).resolves.toEqual({ effectId: f.effect.id, result: f.effect.result });
    expect(f.tx.externalEffect.findMany).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, runId: "run" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });
  it.each(["connectors_execute_tool", "mcp_execute_tool"])(
    "accepts canonical %s receipts and chooses the deterministic newest proof",
    async (tool) => {
      const f = proofFixture();
      const latest = {
        ...f.effect,
        id: "z-email-read",
        request: catalogApprovalRequest(
          tool,
          { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
          "__rakazoCatalogTool",
          readRoute,
        ),
        result: { isError: false, content: [] },
      };
      f.effects.set(latest.id, latest);
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toEqual({ effectId: latest.id, result: latest.result });
    },
  );
  it.each(
    [
      { id: input.replyToEmailId },
      [
        "__rakazoCatalogTool",
        "mcp_execute_tool",
        { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
      ],
      boundDirectApprovalRequest(
        { ...readRoute, resourceRevision: "1" },
        { id: input.replyToEmailId },
        "__rakazoCatalogTool",
      ),
      boundDirectApprovalRequest(
        readRoute,
        { id: input.replyToEmailId, modelResult: {} },
        "__rakazoCatalogTool",
      ),
      catalogApprovalRequest(
        "other_execute_tool",
        { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
        "__rakazoCatalogTool",
        readRoute,
      ),
      catalogApprovalRequest(
        "mcp_execute_tool",
        { id: "different-server:get_email", arguments: { id: input.replyToEmailId } },
        "__rakazoCatalogTool",
        readRoute,
      ),
      [
        "__rakazoCatalogTool",
        "direct",
        { route: readRoute, args: { id: input.replyToEmailId }, extra: true },
      ],
    ].map((request) => ({ request })),
  )("does not admit noncanonical or unbound proof $request", async ({ request }) => {
    const f = proofFixture();
    f.effect.request = request;
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
    ).resolves.toBeNull();
  });
  it.each(["failed", "executing", "uncertain"])(
    "does not use an earlier success after the latest exact read is %s",
    async (status) => {
      const f = proofFixture();
      f.effects.set("newest", {
        ...f.effect,
        id: "newest",
        createdAt: new Date(f.effect.createdAt.getTime() + 1),
        status: status === "failed" ? "completed" : status,
        result: { isError: true, content: [] },
      });
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toBeNull();
    },
  );
  it.each(["missing", "other-email", "executing", "no-result"])(
    "returns no proof for %s",
    async (boundary) => {
      const f = proofFixture();
      if (boundary === "missing") f.effects.delete(f.effect.id);
      if (boundary === "other-email")
        f.effect.request = boundDirectApprovalRequest(
          readRoute,
          { id: "another-email" },
          "__rakazoCatalogTool",
        );
      if (boundary === "executing") f.effect.status = "executing";
      if (boundary === "no-result") f.effect.result = null;
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toBeNull();
    },
  );
  it.each([
    "lease",
    "expired",
    "stopped",
    "foreign-actor",
    "foreign-run",
    "foreign-thread",
    "foreign-bot",
    "disabled-server",
    "server-revision",
    "assignment",
  ])("rejects the %s boundary before reading a proof", async (boundary) => {
    const f = proofFixture();
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "expired") Object.assign(f.run, { leaseExpiresAt: new Date(0) });
    if (boundary === "stopped") f.run.status = "cancelled";
    if (boundary === "foreign-run") f.run.userId = "other";
    if (boundary === "foreign-thread")
      f.tx.thread.findFirst.mockResolvedValue({
        ...actor,
        userId: "other",
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "role",
      });
    if (boundary === "foreign-bot")
      f.tx.bot.findFirst.mockResolvedValue({ ...actor, userId: "other" });
    if (boundary === "disabled-server")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: "mail-server",
        revision: 1,
        enabled: false,
      });
    if (boundary === "server-revision")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: "mail-server",
        revision: 2,
        enabled: true,
      });
    if (boundary === "assignment")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools: ["get_email"],
      });
    await expect(
      recruiting.readNativeReplyEmailProof(
        f.prisma,
        boundary === "foreign-actor" ? { ...actor, spaceId: "other" } : actor,
        f.trusted,
        input,
      ),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.externalEffect.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, route: { ...route, connectorId: "foreign" } },
    { ...input, route: { ...route, resourceId: " " } },
    { ...input, route: { ...route, resourceRevision: 0 } },
    { ...input, route: { ...route, toolName: "get_email" } },
    { ...input, replyToEmailId: " " },
  ])("rejects invalid input %j", async (invalid) => {
    const f = proofFixture();
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, invalid as never),
    ).rejects.toThrow(IsolationError);
  });
});

async function replyFixture() {
  const f = crmFixture();
  const imported = (await recruiting.resolveRecruitingCrmImport(
    f.prisma,
    actor,
    f.trusted,
    f.input,
  ))!;
  const admission = await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
    effectKind: "crm-import",
    effectRequest: boundDirectApprovalRequest(imported.route, imported.args, "__rakazoCatalogTool"),
  });
  const receipt = {
    candidate_id: "40000000-0000-4000-8000-000000000004",
    source_id: "50000000-0000-4000-8000-000000000005",
    membership_id: "60000000-0000-4000-8000-000000000006",
    organization_id: f.target.organizationId,
    role_spec_id: f.target.crmRoleId,
    linkedin_identity: "/in/example",
    source_file: imported.args.p_source_file,
  };
  const importEffect = f.effects.get(admission.effect.id)!;
  Object.assign(importEffect, {
    status: "completed",
    result: { structuredContent: { data: receipt } },
  });
  const revision = await f.tx.recruitingRoleRevision.findFirst();
  Object.assign(revision, {
    sourceRefs: [
      {
        ...revision.sourceRefs[0],
        readState: "read",
        readAt: "2026-10-16T00:00:00Z",
        quote: "Search examples",
      },
    ],
    brief: {
      fields: [
        {
          key: "salary_range",
          value: "USD 100000 to 150000",
          state: "known",
          origin: "user_instruction",
          consequential: true,
          sourceRefIds: ["human"],
        },
        {
          key: "location",
          value: "Unrestricted",
          state: "known",
          origin: "user_instruction",
          consequential: true,
          sourceRefIds: ["human"],
        },
      ],
      searchFilters: [],
      questions: [],
      rules: [],
      confirmation: {
        revision: 1,
        userId: actor.userId,
        messageId: "human",
        confirmedAt: "2026-10-16T00:00:00Z",
      },
    },
  });
  const mailRoute = {
    connectorId: "mcp",
    resourceId: "mail-server",
    resourceRevision: 1,
    toolName: "reply_to_email",
  };
  const identity = {
    providerWorkspaceId: "workspace",
    account: "owner@example.test",
    threadId: "provider-thread",
    anchorId: "inbound-email",
    crmCandidateId: receipt.candidate_id,
  };
  const email = {
    ...f.binding,
    id: "email-read",
    kind: "get_email",
    request: boundDirectApprovalRequest(
      { ...mailRoute, toolName: "get_email" },
      { id: identity.anchorId },
      "__rakazoCatalogTool",
    ),
    result: { structuredContent: { id: identity.anchorId } } as unknown,
  };
  const crm = {
    ...email,
    id: "crm-context-read",
    request: boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: "crm-server",
        resourceRevision: 2,
        toolName: "get_crm_candidate_outreach_context",
      },
      { p_org: receipt.organization_id, p_candidate: receipt.candidate_id },
      "__rakazoCatalogTool",
    ),
    result: { structuredContent: { data: { candidate: { id: receipt.candidate_id } } } } as unknown,
  };
  f.effects.set(email.id, email);
  f.effects.set(crm.id, crm);
  const replyLinks: Array<{
    effectId: string;
    roleRevisionId: string;
    crmImportEffectId: string;
    emailReadEffectId: string;
    crmContextReadEffectId: string;
  }> = [];
  const tx = {
    ...f.tx,
    recruitingReply: {
      findUnique: vi.fn(async ({ where }) => {
        const link = replyLinks.find((item) => item.effectId === where.effectId);
        return link
          ? { ...link, effect: f.effects.get(link.effectId), roleRevision: revision }
          : null;
      }),
      findMany: vi.fn(async ({ where }) =>
        replyLinks
          .filter(
            (link) =>
              !where.crmImportEffectId || link.crmImportEffectId === where.crmImportEffectId,
          )
          .map((link) => ({
            ...link,
            effect: f.effects.get(link.effectId),
            roleRevision: revision,
          })),
      ),
      create: vi.fn(async ({ data }) => {
        replyLinks.push(data);
        return data;
      }),
    },
  };
  f.tx.mcpServer.findFirst.mockImplementation(async ({ where }) => ({
    ...actor,
    id: where.id,
    enabled: true,
    revision: where.id === "crm-server" ? 2 : 1,
    endpoint: "https://mcp.instantly.ai/mcp",
  }));
  f.tx.botMcpServer.findFirst.mockImplementation(async ({ where }) => ({
    allowAllTools: false,
    allowedTools:
      where.serverId === "crm-server"
        ? ["get_crm_candidate_outreach_context"]
        : ["get_email", "list_emails", "reply_to_email"],
  }));
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  const input = {
    roleId: "role",
    expectedRoleRevision: 1,
    crmImportEffectId: importEffect.id,
    mcpServerId: "mail-server",
    serverRevision: 1,
    replyToEmailId: identity.anchorId,
  };
  const native = {
    effectKind: "mcp__mail__reply_to_email",
    effectRequest: boundDirectApprovalRequest(
      mailRoute,
      {
        reply_to_uuid: identity.anchorId,
        eaccount: identity.account,
        to: "candidate@example.test",
        subject: "Exact subject",
        body_text: "Exact body",
        skip_validation: false,
      },
      "__rakazoCatalogTool",
    ),
    identity,
    emailReadEffectId: email.id,
    crmContextReadEffectId: crm.id,
    crmPreflightReadEffectId: crm.id,
  };
  return {
    ...f,
    prisma,
    tx,
    input,
    native,
    revision,
    receipt,
    importEffect,
    email,
    crm,
    replyLinks,
  };
}

async function nativeReplyFixture() {
  const f = await replyFixture();
  f.effects.delete(f.importEffect.id);
  f.tx.recruitingCandidate.findUnique.mockResolvedValue(null as never);
  f.tx.botMcpServer.findFirst.mockImplementation(async ({ where }) => ({
    allowAllTools: false,
    allowedTools:
      where.serverId === "crm-server"
        ? ["get_crm_candidate_outreach_context", "list_crm_candidate_roles"]
        : ["get_email", "list_emails", "reply_to_email"],
  }));
  f.crm.result = {
    structuredContent: {
      data: {
        candidate: {
          id: f.receipt.candidate_id,
          organization_id: f.target.organizationId,
          email: "candidate@example.test",
          linkedin_identity: "/in/example",
        },
      },
    },
  };
  const membership = {
    ...f.crm,
    id: "membership-read",
    request: boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: "crm-server",
        resourceRevision: 2,
        toolName: "list_crm_candidate_roles",
      },
      { p_org: f.target.organizationId, p_candidate: f.receipt.candidate_id },
      "__rakazoCatalogTool",
    ),
    result: {
      structuredContent: {
        data: [
          {
            membership_id: "66666666-6666-4666-8666-666666666666",
            organization_id: f.target.organizationId,
            candidate_id: f.receipt.candidate_id,
            role_spec_id: f.target.crmRoleId,
            client_id: f.target.crmClientId,
          },
        ],
      },
    },
  };
  f.effects.set(membership.id, membership);
  const input = {
    mcpServerId: "mail-server",
    serverRevision: 1,
    replyToEmailId: f.input.replyToEmailId,
    recipient: "candidate@example.test",
  };
  return { ...f, input, membership };
}

describe("durable recruiting reply linkage", () => {
  it("reads native correspondence in a bounded batch without a live lease or effect replay", async () => {
    const f = await nativeReplyFixture();
    const admitted = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input as never,
      f.native,
    );
    const saved = f.effects.get(admitted.effect.id)!;
    saved.status = "uncertain";
    const nativeFindMany = f.tx.externalEffect.findMany.getMockImplementation()!;
    f.tx.externalEffect.findMany.mockImplementation(async (query) => {
      if (query.where.runId) return nativeFindMany(query);
      return [...f.effects.values()]
        .filter((effect) => !query.where.id || query.where.id.in.includes(effect.id))
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        )
        .map((effect) => ({
          ...effect,
          updatedAt: effect.createdAt,
          run: { ...f.run, sourceMessageId: "human" },
        }));
    });
    Object.assign(f.tx.mcpServer, {
      findMany: vi.fn(async () => [
        {
          ...actor,
          id: "mail-server",
          name: "Mail",
          revision: 1,
          enabled: true,
          endpoint: "https://mcp.instantly.ai/mcp",
        },
        { ...actor, id: "crm-server", name: "CRM", revision: 2, enabled: true },
      ]),
    });
    Object.assign(f.tx.botMcpServer, {
      findMany: vi.fn(async () => [
        {
          ...actor,
          botId: "bot",
          serverId: "mail-server",
          allowAllTools: false,
          allowedTools: ["get_email", "reply_to_email"],
        },
        {
          ...actor,
          botId: "bot",
          serverId: "crm-server",
          allowAllTools: false,
          allowedTools: ["get_crm_candidate_outreach_context", "list_crm_candidate_roles"],
        },
      ]),
    });
    Object.assign(f.tx.recruitingRoleRevision, { findMany: vi.fn(async () => [f.revision]) });
    let inTransaction = false;
    Object.assign(f.prisma, {
      $transaction: vi.fn(async (callback: (tx: typeof f.tx) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await callback(f.tx);
        } finally {
          inTransaction = false;
        }
      }),
    });
    const contextBody = (f.crm.result as { structuredContent: unknown }).structuredContent;
    Object.defineProperty(f.crm.result, "structuredContent", {
      get: () => {
        expect(inTransaction).toBe(false);
        return contextBody;
      },
    });
    const creates = f.tx.externalEffect.create.mock.calls.length;
    const result = await recruiting.readRecruitingNativeCorrespondence(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
    });
    expect(result).toMatchObject({
      roleId: "role",
      bindingEffectId: "binding-effect",
      records: [
        {
          effect: { id: saved.id, status: "uncertain" },
          scope: { candidateId: f.receipt.candidate_id },
          emailRead: { id: "email-read" },
        },
      ],
    });
    expect(f.tx.externalEffect.create).toHaveBeenCalledTimes(creates);
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(
      f.tx.externalEffect.findMany.mock.calls.filter(([query]) => !query.where.runId),
    ).toHaveLength(3);
    f.effects.set("new-membership-failure", {
      ...f.membership,
      id: "new-membership-failure",
      status: "failed",
      result: { isError: true },
      createdAt: new Date(saved.createdAt.getTime() + 1000),
    } as never);
    expect(
      (await recruiting.readRecruitingNativeCorrespondence(f.prisma, actor, { threadId: "thread" }))
        ?.records,
    ).toEqual([]);
    f.effects.delete("new-membership-failure");
    const memberResult = f.membership.result;
    f.membership.result = { structuredContent: { data: [] } } as never;
    expect(
      (await recruiting.readRecruitingNativeCorrespondence(f.prisma, actor, { threadId: "thread" }))
        ?.records,
    ).toEqual([]);
    f.membership.result = memberResult;
    f.revision.roleId = "foreign-role";
    expect(
      (await recruiting.readRecruitingNativeCorrespondence(f.prisma, actor, { threadId: "thread" }))
        ?.records,
    ).toEqual([]);
    f.revision.roleId = "role";
    f.email.runId = "foreign-run";
    expect(
      (await recruiting.readRecruitingNativeCorrespondence(f.prisma, actor, { threadId: "thread" }))
        ?.records,
    ).toEqual([]);
  });
  it.each(["direct", "catalog"])(
    "admits a native canonical CRM member without an Autumn import and freezes proof in the original %s envelope",
    async (kind) => {
      const f = await nativeReplyFixture();
      if (kind === "catalog") {
        const payload = f.native.effectRequest[2] as {
          route: {
            connectorId: string;
            resourceId: string;
            resourceRevision: number;
            toolName: string;
          };
          args: Record<string, unknown>;
        };
        f.native.effectRequest = catalogApprovalRequest(
          "mcp_execute_tool",
          {
            id: `${payload.route.resourceId}:reply_to_email`,
            arguments: payload.args,
          },
          "__rakazoCatalogTool",
          payload.route,
        );
      }
      const resolved = await recruiting.resolveRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input as never,
      );
      expect(resolved).toMatchObject({
        crmImportReceipt: null,
        candidateId: f.receipt.candidate_id,
        membershipProof: { effectId: f.membership.id },
      });
      const admitted = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input as never,
        f.native,
      );
      expect(admitted.status).toBe("ready");
      expect(f.replyLinks).toEqual([]);
      expect(admitted.effect.request).not.toEqual(f.native.effectRequest);
      const saved = f.effects.get(admitted.effect.id)!;
      saved.status = "approved";
      f.approvals.add(saved.id);
      const restored = await recruiting.resolveRecruitingReply(
        f.prisma,
        actor,
        { ...f.trusted, approvedEffectId: saved.id },
        null,
      );
      expect(restored?.effect?.id).toBe(saved.id);
      expect(restored?.input).toEqual(f.input);
      await expect(
        recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input as never, {
          ...f.native,
          effectRequest: saved.request,
          effectId: saved.id,
          from: "approved",
        }),
      ).resolves.toBe(true);
      expect(saved.status).toBe("executing");
    },
  );
  it.each(["request", "route", "scope", "binding", "membership", "lease", "proof"])(
    "keeps an approved native request frozen at final %s validation",
    async (boundary) => {
      const f = await nativeReplyFixture();
      const admitted = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.native,
      );
      const effect = f.effects.get(admitted.effect.id)!;
      effect.status = "approved";
      f.approvals.add(effect.id);
      const request = structuredClone(effect.request) as [
        string,
        string,
        {
          args: Record<string, unknown>;
          route: Record<string, unknown>;
          recruitingReply: Record<string, unknown>;
        },
      ];
      const native = {
        ...f.native,
        effectRequest: request,
        effectId: effect.id,
        from: "approved" as const,
      };
      if (boundary === "request") request[2].args.body_text = "Unapproved replacement";
      if (boundary === "route") request[2].route.resourceRevision = 99;
      if (boundary === "scope") request[2].recruitingReply.candidateId = "other";
      if (boundary === "binding") f.role.crmBindingEffectId = null;
      if (boundary === "membership") f.membership.result.structuredContent.data = [];
      if (boundary === "lease") f.trusted.leaseFence += 1;
      if (boundary === "proof") f.approvals.delete(effect.id);
      await expect(
        recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, native),
      ).rejects.toThrow();
      expect(effect.status).toBe("approved");
    },
  );
  it.each(["native", "legacy"])(
    "fences newer CRM observations after a clear %s reply preflight",
    async (kind) => {
      for (const state of ["suppressed", "hold", "passed", "failed", "malformed"]) {
        const f = kind === "native" ? await nativeReplyFixture() : await replyFixture();
        const admitted = await recruiting.admitRecruitingReply(
          f.prisma,
          actor,
          f.trusted,
          f.input,
          f.native,
        );
        const effect = f.effects.get(admitted.effect.id)!;
        effect.status = "approved";
        f.approvals.add(effect.id);
        const clear = {
          ...f.crm,
          id: "clear-crm-preflight",
          createdAt: new Date(Date.now() + 1000),
        };
        f.effects.set(clear.id, clear);
        const latest = {
          ...clear,
          id: "later-crm-observation",
          createdAt: new Date(Date.now() + 2000),
          result:
            state === "failed"
              ? { isError: true }
              : state === "malformed"
                ? { structuredContent: { data: null } }
                : {
                    structuredContent: {
                      data: {
                        candidate: {
                          id: f.receipt.candidate_id,
                          organization_id: f.target.organizationId,
                          email: "candidate@example.test",
                          status: state === "passed" ? "passed" : "replied",
                        },
                        suppressed: state === "suppressed",
                        pipeline:
                          state === "hold"
                            ? { role_spec_id: f.target.crmRoleId, stage: "Hold" }
                            : null,
                      },
                    },
                  },
        };
        f.effects.set(latest.id, latest);
        const claim = {
          ...f.native,
          effectRequest: effect.request,
          effectId: effect.id,
          from: "approved" as const,
          crmPreflightReadEffectId: clear.id,
        };
        await expect(
          recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
        ).rejects.toThrow();
        expect(effect.status).toBe("approved");
      }
    },
  );
  it("uses frozen native proof IDs after fresh provider observations", async () => {
    const f = await nativeReplyFixture();
    const admitted = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    for (const original of [f.email, f.crm, f.membership]) {
      const id = `new-${original.id}`;
      f.effects.set(id, { ...original, id, createdAt: new Date(Date.now() + 1000) });
    }
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectRequest: effect.request,
        effectId: effect.id,
        from: "approved",
        crmPreflightReadEffectId: "new-crm-context-read",
      }),
    ).resolves.toBe(true);
  });
  it.each([
    ["intended", "running", "busy"],
    ["approved", "cancelled", "stopped"],
    ["executing", "failed", "unknown"],
    ["uncertain", "failed", "unknown"],
    ["completed", "completed", "completed"],
    ["denied", "cancelled", "denied"],
  ])(
    "keeps native %s on its original %s run as %s without redispatch or transfer",
    async (status, ownerStatus, expected) => {
      const f = await nativeReplyFixture();
      const admitted = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.native,
      );
      const effect = f.effects.get(admitted.effect.id)!;
      Object.assign(effect, { status, result: { outcome: "retained-provider-result" } });
      f.run.status = ownerStatus;
      const next = {
        ...f.run,
        id: "next-run",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      f.runs.set(next.id, next);
      for (const original of [f.email, f.crm, f.membership]) {
        const id = `next-${original.id}`;
        f.effects.set(id, { ...original, id, runId: next.id });
      }
      const got = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        { ...f.trusted, runId: next.id },
        f.input,
        {
          ...f.native,
          emailReadEffectId: `next-${f.email.id}`,
          crmContextReadEffectId: `next-${f.crm.id}`,
        },
      );
      expect(got.status).toBe(expected);
      expect(got.effect.id).toBe(effect.id);
      expect(got.effect.runId).toBe("run");
      expect(f.replyLinks).toEqual([]);
      expect(
        [...f.effects.values()].filter((item) => item.kind === f.native.effectKind),
      ).toHaveLength(1);
    },
  );
  it("resolves a CRM member already present in the deployed candidate index", async () => {
    const f = await nativeReplyFixture();
    const legacy = await replyFixture();
    const candidate = await legacy.tx.recruitingCandidate.findUnique();
    f.tx.recruitingCandidate.findUnique.mockResolvedValue(candidate as never);
    await expect(
      recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input as never),
    ).resolves.toMatchObject({ candidateId: f.receipt.candidate_id, crmImportReceipt: null });
  });
  it.each(["membership", "binding", "role", "email", "lease", "membership-failed", "hold"])(
    "rejects native member %s boundary",
    async (boundary) => {
      const f = await nativeReplyFixture();
      if (boundary === "membership")
        f.membership.result.structuredContent.data[0]!.role_spec_id = "other";
      if (boundary === "binding") f.role.crmBindingEffectId = "other";
      if (boundary === "role")
        f.tx.thread.findFirst.mockResolvedValue({
          ...actor,
          id: "thread",
          botId: "bot",
          activeRecruitingRoleId: null,
        } as never);
      if (boundary === "email") f.input.recipient = "other@example.test";
      if (boundary === "lease") f.trusted.leaseFence += 1;
      if (boundary === "membership-failed") f.membership.status = "uncertain";
      if (boundary === "hold") {
        const legacy = await replyFixture();
        const candidate = await legacy.tx.recruitingCandidate.findUnique();
        f.tx.recruitingCandidate.findUnique.mockResolvedValue({
          ...candidate,
          consideration: {
            operation: "hold",
            source: {
              messageId: "human",
              threadId: "thread",
              seq: 1,
              createdAt: "2026-10-19T00:00:00.000Z",
              quote: "Pause",
              actor: { userId: actor.userId, spaceId: actor.spaceId },
            },
          },
        } as never);
      }
      await expect(
        recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input as never),
      ).rejects.toThrow();
      expect(f.tx.recruitingReply.create).not.toHaveBeenCalled();
    },
  );

  it("resolves actual CRM/source records and opaque native read receipts with read-only CRM permissions", async () => {
    expect(recruiting.resolveRecruitingReply).toBeTypeOf("function");
    const f = await replyFixture();
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved).toMatchObject({
      input: f.input,
      target: f.target,
      crmImportReceipt: f.receipt,
      emailProof: { effectId: f.email.id, result: f.email.result },
      crmProof: { effectId: f.crm.id, result: f.crm.result },
      role: { id: "role", revision: 1 },
    });
    expect(resolved?.effect).toBeUndefined();
  });
  it.each(["hold", "pass", "resume"] as const)(
    "retains pure CRM archival while enforcing current-role %s before a reply",
    async (operation) => {
      const f = crmFixture();
      const candidate = await f.tx.recruitingCandidate.findUnique();
      const consideration = {
        operation,
        source: {
          messageId: "deleted-human",
          threadId: "deleted-source-thread",
          seq: 2,
          createdAt: "2026-10-18T00:00:00.000Z",
          quote: "An explicit consideration decision",
          actor: { userId: actor.userId, spaceId: actor.spaceId },
        },
      };
      f.tx.recruitingCandidate.findUnique.mockResolvedValue({
        ...candidate,
        consideration,
      } as never);
      const archived = (await recruiting.resolveRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
      ))!;
      expect(archived.input).toEqual(f.input);
      await expect(
        recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
          effectKind: "crm-import",
          effectRequest: boundDirectApprovalRequest(
            archived.route,
            archived.args,
            "__rakazoCatalogTool",
          ),
        }),
      ).resolves.toMatchObject({ effect: { status: "intended" } });
      const reply = await replyFixture();
      const importedCandidate = await reply.tx.recruitingCandidate.findUnique();
      reply.tx.recruitingCandidate.findUnique.mockResolvedValue({
        ...importedCandidate,
        consideration,
      } as never);
      const resolved = recruiting.resolveRecruitingReply(
        reply.prisma,
        actor,
        reply.trusted,
        reply.input,
      );
      if (operation === "resume")
        await expect(resolved).resolves.toMatchObject({ input: reply.input });
      else await expect(resolved).rejects.toThrow(recruiting.RecruitingConflictError);
    },
  );

  it("rechecks a later hold before claiming the original approved reply", async () => {
    const f = await replyFixture();
    const admitted = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    const candidate = await f.tx.recruitingCandidate.findUnique();
    f.tx.recruitingCandidate.findUnique.mockResolvedValue({
      ...candidate,
      consideration: {
        operation: "hold",
        source: {
          messageId: "later-human",
          threadId: "another-thread",
          seq: 1,
          createdAt: "2026-10-19T00:00:00.000Z",
          quote: "Pause consideration",
          actor: { userId: actor.userId, spaceId: actor.spaceId },
        },
      },
    } as never);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: effect.id,
        from: "approved",
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(effect.status).toBe("approved");
    effect.status = "completed";
    await expect(
      recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input),
    ).resolves.toMatchObject({ effect: { status: "completed" } });
  });

  it.each([
    "role",
    "revision",
    "binding",
    "receipt",
    "source",
    "mail-assignment",
    "crm-assignment",
    "mail-revision",
    "lease",
    "email-proof",
    "crm-proof",
    "brief",
  ])("rejects the invalid %s context before admission", async (boundary) => {
    const f = await replyFixture();
    if (boundary === "role")
      f.tx.thread.findFirst.mockResolvedValue({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "other",
      });
    if (boundary === "revision") f.input.expectedRoleRevision += 1;
    if (boundary === "binding") f.role.crmBindingEffectId = "other";
    if (boundary === "receipt") f.importEffect.result = { success: true };
    if (boundary === "source") f.occurrence.name = null;
    if (boundary === "mail-assignment" || boundary === "crm-assignment")
      f.tx.botMcpServer.findFirst.mockImplementation(async ({ where }) => ({
        allowAllTools: false,
        allowedTools:
          where.serverId === (boundary === "mail-assignment" ? "mail-server" : "crm-server")
            ? []
            : ["get_email", "list_emails", "reply_to_email", "get_crm_candidate_outreach_context"],
      }));
    if (boundary === "mail-revision") f.input.serverRevision = 2;
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "email-proof") f.email.status = "uncertain";
    if (boundary === "crm-proof") f.crm.status = "executing";
    if (boundary === "brief") Object.assign(f.revision, { brief: null });
    await expect(
      recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input),
    ).rejects.toThrow();
    expect(f.tx.recruitingReply.create).not.toHaveBeenCalled();
  });
  it("leaves provider endpoint translation to the adapter while validating owned assignments", async () => {
    const f = await replyFixture();
    f.tx.mcpServer.findFirst.mockImplementation(async ({ where }) => ({
      ...actor,
      id: where.id,
      enabled: true,
      revision: where.id === "crm-server" ? 2 : 1,
      endpoint: "https://other.example.test/mcp",
    }));
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved?.route).toEqual({
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 1,
      toolName: "reply_to_email",
    });
    expect(f.tx.recruitingReply.create).not.toHaveBeenCalled();
  });
  it("reserves one native effect and thin link, restores original scope, and claims only the human-approved original request", async () => {
    expect(recruiting.admitRecruitingReply).toBeTypeOf("function");
    const f = await replyFixture();
    const first = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const second = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    expect(first.status).toBe("ready");
    expect(second.effect.id).toBe(first.effect.id);
    expect(f.replyLinks).toEqual([
      {
        effectId: first.effect.id,
        roleRevisionId: "revision",
        crmImportEffectId: f.importEffect.id,
        emailReadEffectId: f.email.id,
        crmContextReadEffectId: f.crm.id,
      },
    ]);
    const effect = f.effects.get(first.effect.id)!;
    const claim = { ...f.native, effectId: effect.id, from: "approved" as const };
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(false);
    effect.status = "approved";
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).rejects.toThrow(IsolationError);
    f.approvals.add(effect.id);
    expect(
      (
        await recruiting.resolveRecruitingReply(
          f.prisma,
          actor,
          { ...f.trusted, approvedEffectId: effect.id },
          { ...f.input, roleId: "changed", expectedRoleRevision: 99 },
        )
      )?.input,
    ).toEqual(f.input);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(true);
    expect(effect.status).toBe("executing");
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(false);
  });
  it.each([
    "email-proof",
    "crm-proof",
    "candidate-identity",
    "anchor-identity",
    "route",
    "noncanonical",
  ])("rejects inconsistent frozen %s before creating a reply", async (boundary) => {
    const f = await replyFixture();
    const native: recruiting.RecruitingReplyNative = {
      ...f.native,
      identity: { ...f.native.identity },
    };
    if (boundary === "email-proof") native.emailReadEffectId = "other";
    if (boundary === "crm-proof") native.crmContextReadEffectId = "other";
    if (boundary === "candidate-identity") native.identity.crmCandidateId = "other";
    if (boundary === "anchor-identity") native.identity.anchorId = "other";
    if (boundary === "route")
      native.effectRequest = boundDirectApprovalRequest(
        {
          connectorId: "mcp",
          resourceId: "other",
          resourceRevision: 1,
          toolName: "reply_to_email",
        },
        {},
        "__rakazoCatalogTool",
      );
    if (boundary === "noncanonical") native.effectRequest = { body: "model reconstruction" };
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, native),
    ).rejects.toThrow();
    expect(f.replyLinks).toHaveLength(0);
  });
  it("keeps the first draft immutable and rejects stale binding or proof changes at claim", async () => {
    const f = await replyFixture();
    const admitted = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectRequest: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: "mail-server",
            resourceRevision: 1,
            toolName: "reply_to_email",
          },
          { changed: true },
          "__rakazoCatalogTool",
        ),
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        emailReadEffectId: "other",
        effectId: effect.id,
        from: "approved",
      }),
    ).rejects.toThrow(IsolationError);
    f.role.crmBindingEffectId = null;
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: effect.id,
        from: "approved",
      }),
    ).rejects.toThrow();
    expect(effect.status).toBe("approved");
  });
  it("rejects inconsistent stored role linkage rather than reusing a pending action", async () => {
    const f = await replyFixture();
    await recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, f.native);
    f.replyLinks[0]!.roleRevisionId = "other-revision";
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, f.native),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
  });
  it("uses frozen retained proof IDs when later preflight reads exist", async () => {
    const f = await replyFixture();
    const admission = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admission.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    f.effects.set("later-email", {
      ...f.email,
      id: "later-email",
      status: "uncertain",
      createdAt: new Date(f.email.createdAt.getTime() + 1),
    });
    f.effects.set("later-crm", {
      ...f.crm,
      id: "later-crm",
      status: "completed",
      createdAt: new Date(f.crm.createdAt.getTime() + 1),
    });
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved?.emailProof.effectId).toBe(f.email.id);
    expect(resolved?.crmProof.effectId).toBe(f.crm.id);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: effect.id,
        from: "approved",
        crmPreflightReadEffectId: "later-crm",
      }),
    ).resolves.toBe(true);
  });
  it("contends on one provider round even when another CRM identity maps to its email", async () => {
    const first = await replyFixture();
    const existing = await recruiting.admitRecruitingReply(
      first.prisma,
      actor,
      first.trusted,
      first.input,
      first.native,
    );
    const second = await replyFixture();
    second.receipt.candidate_id = "70000000-0000-4000-8000-000000000007";
    second.native.identity.crmCandidateId = second.receipt.candidate_id;
    second.crm.request = boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: "crm-server",
        resourceRevision: 2,
        toolName: "get_crm_candidate_outreach_context",
      },
      { p_org: second.receipt.organization_id, p_candidate: second.receipt.candidate_id },
      "__rakazoCatalogTool",
    );
    second.crm.result = {
      structuredContent: { data: { candidate: { id: second.receipt.candidate_id } } },
    };
    const next = {
      ...second.run,
      id: "next-run",
      status: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    second.runs.set(next.id, next);
    const email = { ...second.email, id: "next-email", runId: next.id };
    const crm = { ...second.crm, id: "next-crm", runId: next.id };
    second.effects.set(email.id, email);
    second.effects.set(crm.id, crm);
    second.effects.set(existing.effect.id, existing.effect as never);
    const stored = {
      ...first.replyLinks[0]!,
      effect: existing.effect,
      roleRevision: first.revision,
    };
    second.tx.recruitingReply.findUnique.mockResolvedValue(stored);
    const result = await recruiting.admitRecruitingReply(
      second.prisma,
      actor,
      { ...second.trusted, runId: next.id },
      second.input,
      { ...second.native, emailReadEffectId: email.id, crmContextReadEffectId: crm.id },
    );
    expect(result).toMatchObject({ status: "busy", effect: { id: existing.effect.id } });
    expect(second.replyLinks).toHaveLength(0);
  });
  it.each([
    ["intended", "running", "busy"],
    ["approved", "completed", "stopped"],
    ["executing", "running", "busy"],
    ["executing", "failed", "unknown"],
    ["uncertain", "failed", "unknown"],
    ["completed", "completed", "completed"],
    ["denied", "cancelled", "denied"],
  ])(
    "retains %s effect owned by a %s run as %s without transfer or another effect",
    async (status, ownerStatus, expected) => {
      const f = await replyFixture();
      const admitted = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.native,
      );
      const effect = f.effects.get(admitted.effect.id)!;
      Object.assign(effect, { status, result: { outcome: "retained-provider-result" } });
      f.run.status = ownerStatus;
      const next = {
        ...f.run,
        id: "next-run",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      f.runs.set(next.id, next);
      const got = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        { ...f.trusted, runId: next.id },
        f.input,
        f.native,
      );
      expect(got.status).toBe(expected);
      expect(got.effect.id).toBe(effect.id);
      expect(got.effect.result).toEqual(effect.result);
      expect(effect.runId).toBe("run");
      expect(f.replyLinks).toHaveLength(1);
    },
  );
});

describe("native CRM binding and source import", () => {
  it("reuses the current locked owner while admitting and claiming an internal import", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const native = {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    f.tx.run.findFirst.mockClear();
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
        ...native,
        effectId: admitted.effect.id,
        from: "intended",
      }),
    ).resolves.toBe(true);
    expect(f.tx.run.findFirst).toHaveBeenCalledTimes(6);
    expect(f.tx.run.findUniqueOrThrow).not.toHaveBeenCalledWith({
      where: { id: f.run.id },
      select: { status: true, leaseExpiresAt: true },
    });
    expect(f.effects.get(admitted.effect.id)!.status).toBe("executing");
    expect(f.links).toHaveLength(1);
  });
  it.each(["owner", "space", "bot-owner"])(
    "still authorizes a historical import's %s scope",
    async (boundary) => {
      const f = crmFixture();
      const resolved = (await recruiting.resolveRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
      ))!;
      const native = {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      };
      const admitted = await recruiting.admitRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        native,
      );
      const oldOwner = { ...f.run, id: "historical-owner", bot: { ...f.run.bot } };
      if (boundary === "owner") oldOwner.userId = "foreign";
      if (boundary === "space") oldOwner.spaceId = "foreign";
      if (boundary === "bot-owner") oldOwner.bot.userId = "foreign";
      f.runs.set(oldOwner.id, oldOwner);
      f.effects.get(admitted.effect.id)!.runId = oldOwner.id;
      f.tx.run.findFirst.mockClear();
      await expect(
        recruiting.resolveRecruitingCrmImport(f.prisma, actor, f.trusted, f.input),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: oldOwner.id, spaceId: actor.spaceId, userId: actor.userId },
        }),
      );
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it("reuses the authorized binding owner for its proof and same-owner CRM read", async () => {
    const f = crmFixture();
    await expect(
      recruiting.getRecruitingCrmTarget(f.prisma, actor, { runId: f.run.id, roleId: f.role.id }),
    ).resolves.toEqual({ roleId: f.role.id, bindingEffectId: f.binding.id, target: f.target });
    expect(f.tx.run.findFirst).toHaveBeenCalledTimes(2);
    expect(f.tx.message.findUnique).toHaveBeenCalledWith({
      where: { id: `approval-card:${f.binding.id}` },
    });
  });
  it.each(["same-scope", "foreign-owner", "different-thread", "different-bot"])(
    "rechecks a historical CRM read owned by a %s run",
    async (boundary) => {
      const f = crmFixture();
      const historical = { ...f.run, id: "historical-read-run" };
      if (boundary === "foreign-owner") historical.userId = "another-owner";
      if (boundary === "different-thread") historical.threadId = "another-thread";
      if (boundary === "different-bot") historical.botId = "another-bot";
      f.runs.set(historical.id, historical);
      f.effects.get("crm-read")!.runId = historical.id;
      const result = recruiting.getRecruitingCrmTarget(f.prisma, actor, {
        runId: f.run.id,
        roleId: f.role.id,
      });
      if (boundary === "same-scope")
        await expect(result).resolves.toMatchObject({ target: f.target });
      else await expect(result).rejects.toThrow(IsolationError);
      expect(f.tx.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: historical.id, spaceId: actor.spaceId, userId: actor.userId },
        }),
      );
    },
  );
  it("refuses a native binding that duplicates an attached canonical workspace", async () => {
    const f = crmFixture();
    f.role.crmBindingEffectId = null;
    f.binding.status = "executing";
    f.tx.recruitingCrmWorkspaceAttachment.findMany.mockResolvedValue([
      {
        roleId: "another-native-role",
        mcpServerId: f.target.mcpServerId,
        organizationId: f.target.organizationId,
        crmRoleId: f.target.crmRoleId,
      },
    ] as never);
    await expect(
      recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
  });
  it("binds and replays an internal CRM target without a human approval card", async () => {
    const f = crmFixture();
    f.role.crmBindingEffectId = null;
    f.binding.status = "executing";
    f.approvals.clear();
    f.cards.clear();
    const saved = await recruiting.executeRecruitingCrmBinding(
      f.prisma,
      actor,
      { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
      f.bindingInput,
    );
    expect(saved).toEqual(f.binding.result);
    expect(f.role.crmBindingEffectId).toBe(f.binding.id);
    f.run.status = "completed";
    expect(
      await recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).toEqual(saved);
    expect(f.tx.recruitingRole.updateMany).toHaveBeenCalledOnce();
  });
  it("claims a verified card-free internal import once without human approval", async () => {
    const f = crmFixture();
    f.approvals.clear();
    f.cards.clear();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const native = {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const claim = { ...native, effectId: admitted.effect.id, from: "intended" as const };
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(true);
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(false);
    expect(f.effects.get(admitted.effect.id)!.status).toBe("executing");
    expect(f.links).toHaveLength(1);
  });
  it("binds only from a retained role read and native human approval, then replays the immutable receipt", async () => {
    expect(recruiting.prepareRecruitingCrmBinding).toBeTypeOf("function");
    const f = crmFixture();
    f.role.crmBindingEffectId = null;
    f.binding.status = "executing";
    expect(
      await recruiting.prepareRecruitingCrmBinding(f.prisma, actor, f.trusted, f.bindingInput),
    ).toEqual({ target: f.target, roleTitle: "Native role" });
    f.approvals.clear();
    await expect(
      recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).rejects.toThrow(IsolationError);
    f.approvals.add(f.binding.id);
    const saved = await recruiting.executeRecruitingCrmBinding(
      f.prisma,
      actor,
      { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
      f.bindingInput,
    );
    expect(f.role.crmBindingEffectId).toBe(f.binding.id);
    expect(f.binding.status).toBe("completed");
    f.role.crmBindingEffectId = "new-binding";
    expect(
      await recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).toEqual(saved);
    expect(f.role.crmBindingEffectId).toBe("new-binding");
  });
  it.each(["lease", "thread", "bot", "actor", "revision", "server", "assignment", "request"])(
    "keeps the %s boundary for a card-free internal binding",
    async (boundary) => {
      const f = crmFixture();
      f.role.crmBindingEffectId = null;
      f.binding.status = "executing";
      f.cards.clear();
      f.approvals.clear();
      const trusted = {
        ...f.trusted,
        effectId: f.binding.id,
        effectRequest: f.bindingInput as unknown,
      };
      if (boundary === "lease") trusted.leaseFence += 1;
      if (boundary === "thread") trusted.threadId = "another-thread";
      if (boundary === "bot") trusted.botId = "another-bot";
      if (boundary === "revision") f.role.revision += 1;
      if (boundary === "server")
        f.tx.mcpServer.findFirst.mockResolvedValue({
          ...actor,
          id: "crm-server",
          revision: 3,
          enabled: true,
        });
      if (boundary === "assignment")
        f.tx.botMcpServer.findFirst.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
      if (boundary === "request") trusted.effectRequest = { ...f.bindingInput, operation: "read" };
      await expect(
        recruiting.executeRecruitingCrmBinding(
          f.prisma,
          boundary === "actor" ? { ...actor, userId: "another-owner" } : actor,
          trusted,
          f.bindingInput,
        ),
      ).rejects.toThrow();
      expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
      expect(f.binding.status).toBe("executing");
    },
  );
  it.each(["pending", "denied", "changed-request", "missing-card"])(
    "does not reinterpret a %s human binding decision as autonomous storage",
    async (boundary) => {
      const f = crmFixture();
      f.role.crmBindingEffectId = null;
      f.binding.status = "executing";
      if (boundary === "pending") f.approvals.clear();
      if (boundary === "missing-card") f.tx.message.findUnique.mockResolvedValue(null as never);
      if (boundary === "denied" || boundary === "changed-request") {
        const original = f.tx.event.findFirst.getMockImplementation()!;
        f.tx.event.findFirst.mockImplementation(async (query) => {
          const event = await original(query);
          if (event) {
            if (boundary === "denied") event.payload.answer = "deny";
            else event.payload.requestHash = "a".repeat(64);
          }
          return event;
        });
      }
      await expect(
        recruiting.executeRecruitingCrmBinding(
          f.prisma,
          actor,
          { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
          f.bindingInput,
        ),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["approved", "denied", "lease", "source", "assignment", "binding"])(
    "preserves the %s boundary before claiming a card-free import",
    async (boundary) => {
      const f = crmFixture();
      f.cards.clear();
      f.approvals.clear();
      const resolved = (await recruiting.resolveRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
      ))!;
      const native = {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      };
      const admitted = await recruiting.admitRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        native,
      );
      const effect = f.effects.get(admitted.effect.id)!;
      if (boundary === "approved" || boundary === "denied") effect.status = boundary;
      if (boundary === "lease") f.trusted.leaseFence += 1;
      if (boundary === "source") f.occurrence.name = "Changed source";
      if (boundary === "assignment")
        f.tx.botMcpServer.findFirst.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
      if (boundary === "binding") f.role.crmBindingEffectId = "changed-binding";
      const claim = recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
        ...native,
        effectId: admitted.effect.id,
        from: boundary === "approved" ? "approved" : "intended",
      });
      if (boundary === "denied") await expect(claim).resolves.toBe(false);
      else await expect(claim).rejects.toThrow();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it("derives immutable professional args and reserves one native effect/source link", async () => {
    const f = crmFixture();
    const resolved = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    );
    expect(resolved?.args).toEqual({
      p_org: f.target.organizationId,
      p_role: f.target.crmRoleId,
      p_name: "Example",
      p_linkedin_url: f.occurrence.linkedinUrl,
      p_title: "Engineer",
      p_company: "Example Company",
      p_location: "London",
      p_source_file: `rakazo:artifact:${f.page.artifactId}:sha256:${f.page.artifactHash}:row:0`,
    });
    const native = {
      effectKind: "mcp__crm__crm_import_candidate",
      effectRequest: boundDirectApprovalRequest(
        resolved!.route,
        resolved!.args,
        "__rakazoCatalogTool",
      ),
    };
    const first = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const second = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    expect(second.effect.id).toBe(first.effect.id);
    expect(f.links).toHaveLength(1);
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
    const claim = { ...native, effectId: first.effect.id, from: "approved" as const };
    f.cards.add(first.effect.id);
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
        ...claim,
        from: "intended",
      }),
    ).rejects.toThrow(IsolationError);
    f.effects.get(first.effect.id)!.status = "approved";
    f.approvals.add(first.effect.id);
    const approved = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      { ...f.trusted, approvedEffectId: first.effect.id },
      { ...f.input, candidateKey: "model-changed", rowIndex: 99 },
    );
    expect(approved?.input).toEqual(f.input);
    expect(
      (
        await recruiting.resolveRecruitingCrmImport(
          f.prisma,
          actor,
          { ...f.trusted, approvedEffectId: first.effect.id },
          null,
        )
      )?.input,
    ).toEqual(f.input);
    f.role.crmBindingEffectId = "new-binding";
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(f.effects.get(first.effect.id)!.status).toBe("approved");
    f.role.crmBindingEffectId = f.binding.id;
    expect(
      await recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).toBe(true);
  });
  it("derives historical source status from strict native receipts after rebinding", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "completed";
    effect.result = { message: "Looks synced" };
    f.role.crmBindingEffectId = null;
    f.tx.botMcpServer.findFirst.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
    expect(
      (await recruiting.resolveRecruitingCrmImport(f.prisma, actor, f.trusted, f.input))?.effect
        ?.id,
    ).toBe(effect.id);
    let sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items[0]?.crmImports[0]).toMatchObject({
      status: "unknown",
      receipt: null,
      target: f.target,
    });
    effect.result = {
      structuredContent: {
        data: {
          candidate_id: "40000000-0000-4000-8000-000000000004",
          source_id: "50000000-0000-4000-8000-000000000005",
          membership_id: "60000000-0000-4000-8000-000000000006",
          organization_id: f.target.organizationId,
          role_spec_id: f.target.crmRoleId,
          linkedin_identity: "/in/example",
          source_file: resolved.args.p_source_file,
        },
      },
    };
    sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items[0]?.crmImports[0]).toMatchObject({
      status: "synced",
      target: f.target,
      receipt: { source_file: resolved.args.p_source_file },
    });
  });
  it("projects the current target and pending membership from the native source-linked effect", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    const { page: _page, pageId: _pageId, rowIndex: _rowIndex, ...profile } = f.occurrence;
    f.tx.$queryRaw.mockResolvedValueOnce(
      candidateProjectionRows(
        [
          {
            total: 1n,
            rankAvailable: false,
            tierAvailable: false,
            scoreAvailable: false,
            sourceRows: 1n,
            candidates: 1n,
            identifiedCandidates: 1n,
            unassessed: 1n,
            assessed: 0n,
            shortlisted: 0n,
          },
        ],
        [
          {
            ...profile,
            consideration: null,
            shortlisted: false,
            shortlistedAt: null,
            revision: 0,
            discoveryCount: 1,
            profileSourcePageIds: [],
            firstDiscoveredAt: "2026-10-16T00:00:00.000Z",
            lastDiscoveredAt: "2026-10-16T00:00:00.000Z",
            assessmentVersion: null,
            assessmentRoleRevisionId: null,
            assessmentCreatedAt: null,
            hardGate: null,
            sortValue: "example",
          },
        ],
      ) as never,
    );
    const listed = await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: f.input.roleId,
    });
    expect(listed.crmTarget).toEqual({ bindingEffectId: f.binding.id, target: f.target });
    expect(listed.items[0]?.crm).toMatchObject({
      effectId: admitted.effect.id,
      status: "pending",
      receipt: null,
      target: f.target,
    });
  });
  it.each([new Date(0), null])(
    "projects an executing import as unknown when its running lease is %s",
    async (leaseExpiresAt) => {
      const f = crmFixture();
      const resolved = (await recruiting.resolveRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
      ))!;
      const admitted = await recruiting.admitRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        {
          effectKind: "crm-import",
          effectRequest: boundDirectApprovalRequest(
            resolved.route,
            resolved.args,
            "__rakazoCatalogTool",
          ),
        },
      );
      const effect = f.effects.get(admitted.effect.id)!;
      effect.status = "executing";
      const input = { roleId: f.input.roleId, candidateKey: f.input.candidateKey };
      const live = await recruiting.listRecruitingCandidateSources(f.prisma, actor, input);
      expect(live.items[0]?.crmImports[0]?.status).toBe("syncing");
      Object.assign(f.run, { leaseExpiresAt });
      const interrupted = await recruiting.listRecruitingCandidateSources(f.prisma, actor, input);
      expect(interrupted.items[0]?.crmImports[0]).toMatchObject({
        status: "unknown",
        receipt: null,
      });
      expect(effect.status).toBe("executing");
      expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  async function unclaimedCrmRetryFixture() {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const native = {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    f.run.status = "completed";
    const next = {
      ...f.run,
      id: "next-run",
      status: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    f.runs.set(next.id, next);
    const trusted = { ...f.trusted, runId: next.id };
    return { ...f, native, effect, next, trusted };
  }
  it.each(["completed", "failed"])(
    "reuses the same undispatched card-free import after its owner %s",
    async (status) => {
      const f = await unclaimedCrmRetryFixture();
      f.run.status = status;
      const before = structuredClone({
        run: f.run,
        request: f.effect.request,
        links: f.links,
        result: f.effect.result,
      });
      const retried = await recruiting.admitRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.native,
      );
      expect(retried).toMatchObject({
        status: "ready",
        effect: { id: f.effect.id, runId: f.next.id, status: "intended" },
      });
      expect({
        run: f.run,
        request: f.effect.request,
        links: f.links,
        result: f.effect.result,
      }).toEqual(before);
      expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
      expect(appendEventInTransaction).toHaveBeenCalledWith(
        f.tx,
        expect.objectContaining({
          type: "effect.reconciled",
          runId: f.next.id,
          payload: expect.objectContaining({ effectId: f.effect.id, previousRunId: f.run.id }),
        }),
      );
      const claim = { ...f.native, effectId: f.effect.id, from: "intended" as const };
      await expect(
        recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
      ).resolves.toBe(true);
      await expect(
        recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
      ).resolves.toBe(false);
    },
  );
  it("leaves the original import owned by its original run when the retry CAS loses", async () => {
    const f = await unclaimedCrmRetryFixture();
    f.tx.externalEffect.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    expect(result).toMatchObject({
      status: "busy",
      effect: { id: f.effect.id, runId: f.run.id, status: "intended" },
    });
    expect(f.links).toHaveLength(1);
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
    expect(appendEventInTransaction).not.toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ type: "effect.reconciled", runId: f.next.id }),
    );
  });
  it.each([
    "cancelled",
    "approved",
    "denied",
    "executing",
    "uncertain",
    "live",
    "thread",
    "bot",
    "actor",
    "binding",
    "assignment",
    "lease",
    "source",
    "request",
    "pending-card",
    "answered-card",
  ])("never adopts an unclaimed import across the %s boundary", async (boundary) => {
    const f = await unclaimedCrmRetryFixture();
    if (boundary === "cancelled") f.run.status = "cancelled";
    if (["approved", "denied", "executing", "uncertain"].includes(boundary))
      f.effect.status = boundary;
    if (boundary === "live") f.run.status = "running";
    if (boundary === "thread") f.run.threadId = "another-thread";
    if (boundary === "bot") f.run.botId = "another-bot";
    if (boundary === "binding") f.role.crmBindingEffectId = "new-binding";
    if (boundary === "assignment")
      f.tx.botMcpServer.findFirst.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "source") f.occurrence.name = "Changed source";
    if (boundary === "request") f.native.effectKind = "another-tool";
    if (boundary === "pending-card" || boundary === "answered-card") f.cards.add(f.effect.id);
    if (boundary === "answered-card") f.approvals.add(f.effect.id);
    const retry = recruiting.admitRecruitingCrmImport(
      f.prisma,
      boundary === "actor" ? { ...actor, userId: "foreign" } : actor,
      f.trusted,
      f.input,
      f.native,
    );
    if (
      [
        "thread",
        "bot",
        "actor",
        "binding",
        "assignment",
        "lease",
        "source",
        "request",
        "pending-card",
      ].includes(boundary)
    )
      await expect(retry).rejects.toThrow();
    else
      await expect(retry).resolves.toMatchObject({
        status:
          boundary === "denied"
            ? "denied"
            : ["executing", "uncertain"].includes(boundary)
              ? "unknown"
              : boundary === "live"
                ? "busy"
                : "stopped",
      });
    expect(f.effect.runId).toBe(f.run.id);
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
  });
  it("keeps another live owner busy and terminal unclaimed owner stopped without transferring effects", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const native = {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.runId = "another-run";
    const owner = { ...f.run, id: "another-run" };
    f.runs.set(owner.id, owner);
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("busy");
    owner.status = "cancelled";
    f.role.crmBindingEffectId = "new-target";
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("stopped");
    effect.status = "executing";
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("unknown");
    expect(effect.runId).toBe(owner.id);
    expect(f.links).toHaveLength(1);
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
  });
  it.each([
    "source",
    "candidate",
    "name",
    "assignment",
    "foreign",
    "lease",
    "binding",
    "retained-read",
  ])("rejects an invalid %s before reserving an import", async (boundary) => {
    const f = crmFixture();
    if (boundary === "source") f.input.rowIndex = 1;
    if (boundary === "candidate") f.input.candidateKey = "another-person";
    if (boundary === "name") f.occurrence.name = null;
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "binding") f.role.crmBindingEffectId = "new-binding";
    if (boundary === "retained-read") f.effects.get("crm-read")!.status = "executing";
    if (boundary === "assignment")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools: ["get_crm_role"],
      });
    await expect(
      recruiting.resolveRecruitingCrmImport(
        f.prisma,
        boundary === "foreign" ? { ...actor, userId: "foreign" } : actor,
        f.trusted,
        f.input,
      ),
    ).rejects.toThrow();
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
  });
});

describe("recruiting workspace authorization", () => {
  it("returns only the current role's verified CRM binding at the workspace top level", async () => {
    const f = crmFixture();
    const workspace = await recruiting.getRecruitingWorkspace(f.prisma, actor, {
      threadId: "thread",
    });
    expect(workspace).toMatchObject({
      role: {
        id: f.role.id,
        currentRevisionId: f.role.currentRevisionId,
        revision: f.role.revision,
      },
      crmTarget: { bindingEffectId: f.binding.id, target: f.target },
    });
    expect(workspace?.role).not.toHaveProperty("crmBindingEffectId");
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });
  it("returns an explicit null workspace CRM target when the role has no binding", async () => {
    const f = crmFixture();
    f.role.crmBindingEffectId = null;
    await expect(
      recruiting.getRecruitingWorkspace(f.prisma, actor, { threadId: "thread" }),
    ).resolves.toMatchObject({
      role: { id: f.role.id },
      crmTarget: null,
    });
    expect(f.tx.externalEffect.findFirst).not.toHaveBeenCalled();
  });
  it("revalidates workspace CRM proof on every read and never revives a removed binding", async () => {
    const f = crmFixture();
    const read = () => recruiting.getRecruitingWorkspace(f.prisma, actor, { threadId: "thread" });
    await expect(read()).resolves.toMatchObject({ crmTarget: { bindingEffectId: f.binding.id } });
    f.binding.result = {
      status: "connected",
      roleId: f.role.id,
      bindingEffectId: f.binding.id,
      target: { ...f.target, serverRevision: 99 },
    };
    await expect(read()).rejects.toThrow(IsolationError);
    f.role.crmBindingEffectId = null;
    await expect(read()).resolves.toMatchObject({ crmTarget: null });
  });
  it.each([
    "binding-role",
    "binding-space",
    "source-owner",
    "receipt-revision",
    "current-revision",
  ])("rejects a workspace CRM target with an invalid %s proof", async (boundary) => {
    const f = crmFixture();
    if (boundary === "binding-role") f.binding.request = { ...f.bindingInput, roleId: "other" };
    if (boundary === "binding-space") f.binding.spaceId = "other";
    if (boundary === "source-owner") f.run.userId = "other";
    if (boundary === "receipt-revision") {
      const read = f.effects.get("crm-read")!;
      read.request = boundDirectApprovalRequest(
        {
          connectorId: "mcp",
          resourceId: f.target.mcpServerId,
          resourceRevision: 99,
          toolName: "get_crm_role",
        },
        { p_org: f.target.organizationId, p_role: f.target.crmRoleId },
        "__rakazoCatalogTool",
      );
    }
    if (boundary === "current-revision")
      f.tx.recruitingRoleRevision.findFirst.mockResolvedValue(null as never);
    await expect(
      recruiting.getRecruitingWorkspace(f.prisma, actor, { threadId: "thread" }),
    ).rejects.toThrow(IsolationError);
  });
  it.each([
    "same",
    "different",
    "thread-owner",
    "thread-space",
    "bot-owner",
    "bot-space",
    "message-other",
    "message-foreign",
  ])("reuses only the authorized source thread at the %s boundary", async (boundary) => {
    const f = observationFixture([]);
    const thread = await f.tx.thread.findFirst();
    f.tx.thread.findFirst.mockClear();
    const messageSource = boundary.startsWith("message-");
    if (boundary !== "same" && !messageSource) f.role.sourceThreadId = "source-thread";
    const source = { ...thread, id: messageSource ? "source-thread" : f.role.sourceThreadId };
    if (messageSource) (await f.tx.message.findMany())[0]!.threadId = source.id;
    if (boundary === "thread-owner" || boundary === "message-foreign") source.userId = "other";
    if (boundary === "thread-space") source.spaceId = "other";
    f.tx.thread.findFirst
      .mockResolvedValueOnce(thread)
      .mockResolvedValueOnce(source)
      .mockResolvedValue(thread);
    if (boundary === "bot-owner" || boundary === "bot-space")
      f.tx.bot.findFirst.mockResolvedValueOnce(actor).mockResolvedValue({
        ...actor,
        ...(boundary === "bot-owner" ? { userId: "other" } : { spaceId: "other" }),
      });
    f.tx.recruitingRoleRevision.findFirst.mockImplementation(async () => {
      // Retained source provenance is validated separately after this authorization boundary.
      expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(
        boundary === "same" || messageSource ? 1 : 2,
      );
      expect(f.tx.bot.findFirst).toHaveBeenCalledTimes(
        boundary === "same" || messageSource ? 1 : 2,
      );
      return f.revision;
    });
    const result = recruiting.getRecruitingWorkspace(f.prisma, actor, { threadId: thread.id });
    if (boundary === "same" || boundary === "different" || boundary === "message-other") {
      await expect(result).resolves.toMatchObject({ role: { id: "role" } });
      expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(boundary === "same" ? 1 : 2);
      expect(f.tx.bot.findFirst).toHaveBeenCalledTimes(boundary === "same" ? 1 : 2);
    } else await expect(result).rejects.toThrow(IsolationError);
    expect(f.tx.thread.findFirst).toHaveBeenNthCalledWith(boundary === "same" ? 1 : 2, {
      where: { id: source.id, spaceId: actor.spaceId, userId: actor.userId },
      select: expect.any(Object),
    });
  });
});

describe("native observation indexing", () => {
  it.each([undefined, []])(
    "keeps raw-only observations distinct from accepted empty pages: %j",
    async (rows) => {
      const f = observationFixture(rows);
      await recruiting.recordRecruitingResearchObservation(f.prisma, actor, f.input as never);
      expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ rowCount: rows === undefined ? null : 0 }),
      });
      expect(f.tx.recruitingCandidate.createMany).not.toHaveBeenCalled();
      expect(f.tx.recruitingCandidateOccurrence.createMany).not.toHaveBeenCalled();
      expect(f.tx.recruitingResearchAction.update).toHaveBeenCalledOnce();
    },
  );
  it("indexes all rows with independent unknown keys and deduplicated canonical profile keys", async () => {
    const row = {
      name: { value: "Example", source_id: "source" },
      linkedin_url: "https://www.linkedin.com/in/Example?trk=source",
      current_title: "Engineer",
      current_company: "Company",
      location: "London",
      resume_url: null,
      evidence_urls: [],
    };
    const f = observationFixture([
      row,
      { ...row, linkedin_url: "https://linkedin.com/in/EXAMPLE/" },
      null,
      { full_name: "Never inferred", _sources: { profile: "https://www.linkedin.com/in/no" } },
    ]);
    const receipt = await recruiting.recordRecruitingResearchObservation(
      f.prisma,
      actor,
      f.input as never,
    );
    expect(receipt).toHaveProperty("candidateRows", [
      { rowIndex: 0, candidateKey: "linkedin:/in/example" },
      { rowIndex: 1, candidateKey: "linkedin:/in/example" },
      { rowIndex: 2, candidateKey: "source-row:read:2" },
      { rowIndex: 3, candidateKey: "source-row:read:3" },
    ]);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rowCount: 4,
        effectId: "read",
        artifactId: "observation-artifact",
        roleRevisionId: "revision",
      }),
    });
    expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "role", candidateKey: "linkedin:/in/example" },
        { roleId: "role", candidateKey: "source-row:read:2" },
        { roleId: "role", candidateKey: "source-row:read:3" },
      ],
      skipDuplicates: true,
    });
    const occurrences = f.tx.recruitingCandidateOccurrence.createMany.mock
      .lastCall?.[0] as unknown as {
      data: Array<{
        rowIndex: number;
        candidateKey: string;
        name: string | null;
        issues: string[];
      }>;
    };
    expect(occurrences.data.map((item) => item.rowIndex)).toEqual([0, 1, 2, 3]);
    expect(occurrences.data[0]).toMatchObject({
      candidateKey: "linkedin:/in/example",
      name: "Example",
    });
    expect(occurrences.data[2]).toMatchObject({ name: null, issues: ["invalid_row"] });
    expect(occurrences.data[3]?.name).toBeNull();
  });
  it("fills a previously recorded native receipt without changing its cursor, state or usage", async () => {
    const f = observationFixture([{ name: "Example" }]);
    const output = {
      ...actor,
      id: "observation-artifact",
      hash: f.hash,
      botId: "bot",
      groupId: null,
      runId: "run",
      storageKey: "observation",
    };
    f.artifacts.set(output.id, output);
    Object.assign(f.action, {
      outputArtifacts: [{ artifactId: output.id, sha256: output.hash }],
      cursor: "current-cursor",
      receiptArtifactId: "context",
      receiptArtifactHash: f.hash,
      usage: [{ scope: "task", unit: "credits", amount: 2 }],
    });
    f.tx.artifact.findUnique.mockResolvedValue(output as never);
    const binding = (await f.tx.event.findMany())[0]!;
    f.tx.event.findMany.mockResolvedValue([
      binding,
      {
        ...binding,
        id: "recorded",
        seq: 2,
        payload: {
          phase: "recorded",
          taskId: "task",
          actionId: "action",
          effectId: "read",
          outputArtifact: { artifactId: output.id, sha256: output.hash },
        },
      },
    ] as never);
    await recruiting.recordRecruitingResearchObservation(f.prisma, actor, {
      ...f.input,
      historicalBackfill: true,
      cursor: "old-cursor",
      usage: [{ scope: "task", unit: "credits", amount: 0 }],
    } as never);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledOnce();
    expect(f.tx.recruitingResearchAction.update).not.toHaveBeenCalled();
    expect(f.tx.artifact.create).not.toHaveBeenCalled();
    f.tx.recruitingCandidatePage.findUnique.mockResolvedValue({ effectId: "read" } as never);
    const replay = await recruiting.recordRecruitingResearchObservation(
      f.prisma,
      actor,
      f.input as never,
    );
    expect(replay.candidateRows).toEqual([{ rowIndex: 0, candidateKey: "source-row:read:0" }]);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledOnce();
    expect(f.tx.recruitingCandidateOccurrence.createMany).toHaveBeenCalledOnce();
  });
  it("does not index a result that differs from its completed native effect", async () => {
    const f = observationFixture([{ name: "Example" }]);
    await expect(
      recruiting.recordRecruitingResearchObservation(f.prisma, actor, {
        ...f.input,
        rawResult: { changed: true },
      } as never),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
    expect(f.tx.artifact.create).not.toHaveBeenCalled();
  });
});

function nativeCandidateFixture() {
  const row = {
    name: "Example",
    linkedin_url: "https://www.linkedin.com/in/example",
    current_title: "Engineer",
    current_company: "Example Company",
    location: null,
    resume_url: null,
    evidence_urls: [],
  };
  const f = observationFixture([row, { ...row }, null]);
  Object.assign(f.run, {
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const input = {
    operation: "save_results" as const,
    expectedRoleRevision: 1,
    mcpServerId: "server",
    providerTaskId: "provider-task",
    cursor: null,
  };
  const saveEffect = {
    ...f.effect,
    id: "save",
    kind: "recruiting_research",
    status: "executing",
    request: input,
    result: null,
  };
  const pages = new Map<string, unknown>();
  const snapshot = { request: f.effect.request, providerResult: f.effect.result };
  const bytes = Buffer.from(stableJsonValue(snapshot));
  const file = {
    name: "native-candidates.json",
    mimeType: "application/json",
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: "native-source",
    clientNonce: "recruiting-observation:read",
  };
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(
      async (query: unknown): Promise<unknown[]> =>
        (query as { sql: string }).sql.includes("incoming_source_rows") ? [] : [{ id: "thread" }],
    ),
    externalEffect: {
      findMany: vi.fn(async () => [f.effect]),
      findFirst: vi.fn(async ({ where }) => (where.id === "save" ? saveEffect : f.effect)),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(saveEffect, data);
        return { count: 1 };
      }),
    },
    event: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({
        id: "adoption",
        seq: 1,
        spaceId: actor.spaceId,
        threadId: "thread",
        botId: "bot",
        runId: "run",
        type: "recruiting.context.adopted",
        payload: {
          roleId: "role",
          roleRevisionId: "revision",
          contextArtifact: { artifactId: "context", sha256: f.hash },
        },
        createdAt: f.now,
      })),
    },
    recruitingCandidatePage: {
      findUnique: vi.fn(async ({ where }) => pages.get(where.effectId) ?? null),
      create: vi.fn(async ({ data }) => {
        pages.set(data.effectId, data);
        return data;
      }),
    },
  };
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  const trusted = {
    runId: "run",
    leaseOwner: "worker",
    leaseFence: 1,
    effectId: "save",
    effectRequest: input,
  };
  return { ...f, tx, prisma, input, trusted, saveEffect, file, row, snapshot };
}

describe("native candidate shortlist", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, "", "   "])(
    "rejects approval without an actual candidate name: %s",
    async (name) => {
      const f = nativeCandidateFixture();
      const input = {
        roleId: "role",
        expectedRoleRevision: 1,
        candidateKey: "candidate",
        expectedRevision: 0,
        shortlisted: true,
      };
      f.tx.$queryRaw.mockResolvedValue([
        {
          id: "thread",
          name,
          linkedinUrl: null,
          resumeUrl: null,
          sourcePageId: null,
          profileSourcePageIds: [],
        },
      ]);
      await expect(
        recruiting.prepareNativeRecruitingShortlist(
          f.prisma,
          actor,
          { ...f.trusted, threadId: "thread", botId: "bot" },
          input,
        ),
      ).rejects.toThrow(IsolationError);
      expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
      expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
    },
  );

  it("records a bot decision atomically and replays its receipt after a later human decision", async () => {
    expect(recruiting.executeNativeRecruitingShortlist).toBeTypeOf("function");
    const f = nativeCandidateFixture();
    const input = {
      roleId: "role",
      expectedRoleRevision: 1,
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: true,
    };
    Object.assign(f.saveEffect, { kind: "recruiting_shortlist", request: input });
    const trusted = { ...f.trusted, threadId: "thread", botId: "bot", effectRequest: input };
    const candidate = await f.tx.recruitingCandidate.findUnique();
    f.tx.recruitingCandidate.findUnique.mockImplementation(async () => ({ ...candidate }));
    f.tx.recruitingCandidate.updateMany.mockImplementation(async (...args: unknown[]) => {
      const { data } = args[0] as { data: Partial<typeof candidate> };
      Object.assign(candidate, data);
      return { count: 1 };
    });
    f.tx.$queryRaw.mockResolvedValue([
      {
        id: "thread",
        name: "Synthetic Avery",
        linkedinUrl: null,
        resumeUrl: null,
        sourcePageId: null,
        profileSourcePageIds: [],
      },
    ]);
    expect(
      await recruiting.prepareNativeRecruitingShortlist(f.prisma, actor, trusted, input),
    ).toEqual({
      candidateName: "Synthetic Avery",
      roleTitle: "Example engineer",
      shortlisted: true,
    });
    const saved = await recruiting.executeNativeRecruitingShortlist(
      f.prisma,
      actor,
      trusted,
      input,
    );
    expect(saved).toEqual({
      kind: "saved",
      roleId: "role",
      candidateKey: "candidate",
      shortlisted: true,
      revision: 1,
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        role: "bot",
        botId: "bot",
        runId: "run",
        threadId: "thread",
        clientNonce: "recruiting-shortlist:save",
      }),
    );
    expect(f.saveEffect).toMatchObject({ status: "completed", result: saved });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "effect.recorded",
        payload: { effectId: "save", tool: "recruiting_shortlist", result: saved },
      }),
    );
    await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      candidateKey: "candidate",
      expectedRevision: 1,
      shortlisted: false,
    });
    expect(candidate).toMatchObject({ shortlisted: false, revision: 2 });
    expect(
      await recruiting.executeNativeRecruitingShortlist(f.prisma, actor, trusted, input),
    ).toEqual(saved);
    expect(candidate).toMatchObject({ shortlisted: false, revision: 2 });
    expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledTimes(2);
    expect(createThreadMessageInTransaction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createThreadMessageInTransaction).mock.calls[1]![1].role).toBe("user");
  });

  it.each([
    "no-op",
    "cancelled",
    "expired lease",
    "wrong thread",
    "wrong bot",
    "foreign actor",
    "changed role",
    "changed role revision",
    "stale candidate",
    "changed request",
    "foreign profile",
  ])("preserves native shortlist boundaries for %s", async (boundary) => {
    expect(recruiting.executeNativeRecruitingShortlist).toBeTypeOf("function");
    const f = nativeCandidateFixture();
    const input = {
      roleId: "role",
      expectedRoleRevision: 1,
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: boundary !== "no-op",
    };
    Object.assign(f.saveEffect, { kind: "recruiting_shortlist", request: input });
    const trusted = { ...f.trusted, threadId: "thread", botId: "bot", effectRequest: input };
    const candidate = await f.tx.recruitingCandidate.findUnique();
    f.tx.$queryRaw.mockResolvedValue([
      {
        id: "thread",
        name: "Synthetic Avery",
        linkedinUrl: null,
        resumeUrl: null,
        sourcePageId: null,
        profileSourcePageIds: boundary === "foreign profile" ? ["foreign-page"] : [],
      },
    ]);
    if (boundary === "cancelled") f.run.status = "cancelled";
    if (boundary === "expired lease") Object.assign(f.run, { leaseExpiresAt: new Date(0) });
    if (boundary === "wrong thread") trusted.threadId = "other-thread";
    if (boundary === "wrong bot") trusted.botId = "other-bot";
    if (boundary === "foreign actor") f.run.userId = "other-owner";
    if (boundary === "changed role")
      f.tx.thread.findFirst.mockResolvedValue({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "other-role",
      });
    if (boundary === "changed role revision") f.role.revision = 2;
    if (boundary === "stale candidate") candidate.revision = 1;
    if (boundary === "changed request") trusted.effectRequest = { ...input, shortlisted: false };
    if (boundary === "no-op") {
      expect(
        await recruiting.executeNativeRecruitingShortlist(f.prisma, actor, trusted, input),
      ).toEqual({
        kind: "saved",
        roleId: "role",
        candidateKey: "candidate",
        shortlisted: false,
        revision: 0,
      });
      expect(f.saveEffect.status).toBe("completed");
    } else {
      await expect(
        recruiting.executeNativeRecruitingShortlist(f.prisma, actor, trusted, input),
      ).rejects.toThrow();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    }
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
  });
});

async function nativeSourceFixture(additionalRows: readonly unknown[] = []) {
  const f = crmFixture(additionalRows);
  const read = f.effects.get("read")!;
  const bytes = Buffer.from(
    stableJsonValue({ request: read.request, providerResult: read.result }),
  );
  const artifact = await f.tx.artifact.findUnique();
  Object.assign(artifact, {
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
  Object.assign(f.page, { taskId: null, actionId: null, artifactHash: artifact.hash });
  const event = {
    id: "native-saved",
    seq: 3,
    spaceId: actor.spaceId,
    threadId: "thread",
    runId: "run",
    botId: "bot",
    type: "recruiting.candidates.saved",
    createdAt: new Date(),
    payload: {
      roleId: "role",
      roleRevisionId: "revision",
      effectId: "read",
      mcpServerId: "server",
      serverRevision: 1,
      providerTaskId: "provider-task",
      requestCursor: null,
      outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
      candidateOutputSchema: "candidate_output_v1",
    },
  };
  f.tx.event.findMany.mockResolvedValue([event] as never);
  const thread = { ...(await f.tx.thread.findFirst()), bot: { ...actor } };
  const nativeProofs = vi.fn(async () => [
    {
      ...artifact,
      effectId: read.id,
      effectStatus: read.status,
      effectRequest: read.request,
      effectResult: read.result === null ? null : JSON.stringify(read.result),
      effectRun: { ...f.run, thread },
    },
  ]);
  const queryRaw = f.tx.$queryRaw.getMockImplementation()!;
  f.tx.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    (args[0] as { sql: string }).sql.includes('FROM "external_effects" e')
      ? ((await nativeProofs()) as never)
      : queryRaw(),
  );
  return { ...f, artifact, event, read, thread, nativeProofs };
}

describe("native candidate source provenance", () => {
  async function nativeImportReadFixture(additionalRows: readonly unknown[] = []) {
    const f = await nativeSourceFixture(additionalRows);
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    f.nativeProofs.mockClear();
    f.tx.externalEffect.findFirst.mockClear();
    return { ...f, importEffect: f.effects.get(admitted.effect.id)! };
  }
  function nativeCandidateListRead(f: Awaited<ReturnType<typeof nativeImportReadFixture>>) {
    const { page: _page, pageId, rowIndex, ...profile } = f.occurrence;
    f.tx.$queryRaw.mockResolvedValueOnce(
      candidateProjectionRows(
        [
          {
            total: 1n,
            rankAvailable: false,
            tierAvailable: false,
            scoreAvailable: false,
            sourceRows: 1n,
            candidates: 1n,
            identifiedCandidates: 1n,
            unassessed: 1n,
            assessed: 0n,
            shortlisted: 0n,
          },
        ],
        [
          {
            ...profile,
            consideration: null,
            sourcePageId: pageId,
            sourceRowIndex: rowIndex,
            profileSourcePageIds: [pageId],
            shortlisted: false,
            shortlistedAt: null,
            revision: 0,
            discoveryCount: 1,
            firstDiscoveredAt: f.page.observedAt.toISOString(),
            lastDiscoveredAt: f.page.observedAt.toISOString(),
            assessmentVersion: null,
            assessmentRoleRevisionId: null,
            assessmentCreatedAt: null,
            hardGate: null,
            sortValue: "example",
          },
        ],
      ) as never,
    );
    f.tx.recruitingCandidatePage.findMany.mockResolvedValue([
      { ...f.page, effect: f.read },
    ] as never);
    return recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: f.role.id,
      query: "Example",
      limit: 1,
    });
  }
  it("scopes native saved-page proof events to the proven runs, not the whole space event log", async () => {
    // Production 2026-10-22T23:23Z: space-wide JSON-path scans of `events` held the read
    // transaction past 15s and starved the 4-slot pool (P2028 / pool connect timeouts).
    const f = await nativeImportReadFixture();
    f.tx.event.findMany.mockClear();
    await nativeCandidateListRead(f);
    const saved = f.tx.event.findMany.mock.calls
      .map((call) => (call as unknown as [{ where: Record<string, unknown> }])[0].where)
      .filter((where) => where.type === "recruiting.candidates.saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ spaceId: actor.spaceId, runId: { in: [f.run.id] } });
  });
  it("batches exact current-binding imports and verifies their shared native page once after the read snapshot", async () => {
    const row = {
      name: "Second Example",
      linkedin_url: "https://www.linkedin.com/in/second-example",
    };
    const f = await nativeImportReadFixture([row]);
    const { candidateKey, ...profile } = normalizeRecruitingCandidateRow(row, {
      schemaKnown: true,
    });
    const occurrence = { ...f.occurrence, ...profile, candidateKey: candidateKey!, rowIndex: 1 };
    const args = {
      p_org: f.target.organizationId,
      p_role: f.target.crmRoleId,
      p_name: row.name,
      p_linkedin_url: row.linkedin_url,
      p_source_file: `rakazo:artifact:${f.page.artifactId}:sha256:${f.page.artifactHash}:row:1`,
    };
    const effect = {
      ...f.importEffect,
      id: "second-import",
      idempotencyKey: `recruiting-crm-import:${stableJsonValue([f.binding.id, f.page.effectId, 1])}`,
      request: boundDirectApprovalRequest(
        {
          connectorId: "mcp",
          resourceId: f.target.mcpServerId,
          resourceRevision: 2,
          toolName: "crm_import_candidate",
        },
        args,
        "__rakazoCatalogTool",
      ),
      status: "completed",
      result: {
        structuredContent: {
          data: {
            candidate_id: "40000000-0000-4000-8000-000000000004",
            source_id: "50000000-0000-4000-8000-000000000005",
            membership_id: "60000000-0000-4000-8000-000000000006",
            organization_id: f.target.organizationId,
            role_spec_id: f.target.crmRoleId,
            linkedin_identity: "/in/second-example",
            source_file: args.p_source_file,
          },
        },
      },
    };
    f.tx.recruitingCrmImport.findMany.mockResolvedValue([
      { ...f.links[0]!, effect: f.importEffect, occurrence: f.occurrence },
      {
        effectId: effect.id,
        bindingEffectId: f.binding.id,
        pageId: f.page.effectId,
        rowIndex: 1,
        effect,
        occurrence,
      },
    ] as never);
    f.tx.run.findMany.mockClear();
    let inTransaction = false;
    const prisma = {
      $transaction: vi.fn(async (read: (tx: typeof f.tx) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await read(f.tx);
        } finally {
          inTransaction = false;
        }
      }),
    } as unknown as PrismaClient;
    const json = JSON.stringify(f.read.result);
    const parse = JSON.parse;
    let byteChecks = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text === json) {
        byteChecks += 1;
        expect(inTransaction).toBe(false);
      }
      return parse(text, reviver);
    });
    try {
      const result = await recruiting.getRecruitingCrmCandidateSyncs(prisma, actor, {
        roleId: f.role.id,
        effectIds: [f.importEffect.id, effect.id, f.importEffect.id],
      });
      expect(result).toMatchObject([
        { effectId: f.importEffect.id, status: "pending", receipt: null },
        { effectId: effect.id, status: "synced", receipt: { source_file: args.p_source_file } },
      ]);
      expect(f.nativeProofs).toHaveBeenCalledOnce();
      expect(byteChecks).toBe(1);
      expect(f.tx.run.findMany).toHaveBeenCalledOnce();
      expect(f.tx.recruitingCrmImport.findMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          effectId: { in: [f.importEffect.id, effect.id] },
          bindingEffectId: f.binding.id,
          occurrence: { roleId: f.role.id },
          effect: { spaceId: actor.spaceId, run: { spaceId: actor.spaceId, userId: actor.userId } },
        },
        include: { effect: true, occurrence: { include: { page: true } } },
      });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "RepeatableRead",
      });
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    "actor",
    "space",
    "missing",
    "binding",
    "role",
    "source-role",
    "effect-identity",
    "effect-space",
    "owner",
    "bytes",
  ])("rejects an invalid exact import batch %s without exposing receipts", async (boundary) => {
    const f = await nativeImportReadFixture();
    const link = { ...f.links[0]!, effect: f.importEffect, occurrence: f.occurrence };
    let caller = actor;
    if (boundary === "actor") caller = { ...actor, userId: "another-owner" };
    if (boundary === "space") caller = { ...actor, spaceId: "another-space" };
    if (boundary === "binding") link.bindingEffectId = "another-binding";
    if (boundary === "role") link.occurrence = { ...link.occurrence, roleId: "another-role" };
    if (boundary === "source-role")
      link.occurrence = { ...link.occurrence, page: { ...f.page, roleId: "another-role" } };
    if (boundary === "effect-identity") link.effect = { ...link.effect, id: "another-import" };
    if (boundary === "effect-space") link.effect = { ...link.effect, spaceId: "another-space" };
    if (boundary === "owner")
      f.tx.run.findMany.mockResolvedValue([{ ...f.run, userId: "another-owner" }]);
    if (boundary === "bytes") f.read.result = { changed: true } as never;
    f.tx.recruitingCrmImport.findMany.mockResolvedValue(boundary === "missing" ? [] : [link]);
    await expect(
      recruiting.getRecruitingCrmCandidateSyncs(f.prisma, caller, {
        roleId: f.role.id,
        effectIds: [f.importEffect.id],
      }),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });
  it("bounds exact import batches before starting a snapshot", async () => {
    const f = await nativeImportReadFixture();
    vi.mocked(f.prisma.$transaction).mockClear();
    await expect(
      recruiting.getRecruitingCrmCandidateSyncs(f.prisma, actor, {
        roleId: f.role.id,
        effectIds: Array.from({ length: 201 }, (_, index) => `import-${index}`),
      }),
    ).rejects.toThrow(IsolationError);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(["candidates", "sources", "research"] as const)(
    "releases the read snapshot before verifying full native result bytes for %s",
    async (operation) => {
      const base = await nativeImportReadFixture();
      let inTransaction = false;
      const f = {
        ...base,
        prisma: {
          $executeRaw: vi.fn(async () => 0),
          $transaction: vi.fn(async (fn: (tx: typeof base.tx) => Promise<unknown>) => {
            inTransaction = true;
            try {
              return await fn(base.tx);
            } finally {
              inTransaction = false;
            }
          }),
        } as unknown as PrismaClient,
      };
      Object.assign(f.tx.recruitingResearchTask, { findMany: vi.fn(async () => []) });
      f.tx.recruitingCandidatePage.findMany.mockResolvedValue([
        { ...f.page, effect: f.read },
      ] as never);
      let resultJson = JSON.stringify(f.read.result);
      const parse = JSON.parse;
      let byteChecks = 0;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text === resultJson) {
          byteChecks += 1;
          expect(inTransaction).toBe(false);
        }
        return parse(text, reviver);
      });
      try {
        const read = () =>
          operation === "candidates"
            ? nativeCandidateListRead(f)
            : operation === "sources"
              ? recruiting.listRecruitingCandidateSources(f.prisma, actor, {
                  roleId: f.role.id,
                  candidateKey: f.occurrence.candidateKey,
                })
              : recruiting.listRecruitingResearch(f.prisma, actor, { roleId: f.role.id });
        await read();
        expect(byteChecks).toBe(1);
        f.read.result = { changed: true } as never;
        resultJson = JSON.stringify(f.read.result);
        await expect(read()).rejects.toThrow(IsolationError);
        expect(byteChecks).toBe(2);
        f.run.userId = "another-owner";
        await expect(read()).rejects.toThrow(IsolationError);
        expect(byteChecks).toBe(2);
      } finally {
        parseSpy.mockRestore();
      }
    },
  );
  it.each([false, true])(
    "keeps full native byte verification atomic with shortlist writes, corrupted=%s",
    async (corrupted) => {
      vi.mocked(createThreadMessageInTransaction).mockClear();
      const f = await nativeSourceFixture();
      const { page: _page, pageId, rowIndex, ...profile } = f.occurrence;
      const queryRaw = f.tx.$queryRaw.getMockImplementation()!;
      f.tx.$queryRaw.mockImplementation(async (...args: unknown[]) =>
        (args[0] as { sql: string }).sql.includes('FROM "external_effects" e')
          ? Reflect.apply(queryRaw, undefined, args)
          : ([
              {
                ...profile,
                sourcePageId: pageId,
                sourceRowIndex: rowIndex,
                profileSourcePageIds: [pageId],
              },
            ] as never),
      );
      f.tx.recruitingCandidatePage.findMany.mockResolvedValue([
        { ...f.page, effect: f.read },
      ] as never);
      if (corrupted) f.read.result = { changed: true } as never;
      let inTransaction = false;
      const prisma = {
        $transaction: vi.fn(async (fn: (tx: typeof f.tx) => Promise<unknown>) => {
          inTransaction = true;
          try {
            return await fn(f.tx);
          } finally {
            inTransaction = false;
          }
        }),
      } as unknown as PrismaClient;
      const resultJson = JSON.stringify(f.read.result);
      const parse = JSON.parse;
      let byteChecks = 0;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text === resultJson) {
          byteChecks += 1;
          expect(inTransaction).toBe(true);
          expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
        }
        return parse(text, reviver);
      });
      try {
        const save = recruiting.setRecruitingCandidateShortlist(prisma, actor, {
          threadId: "thread",
          roleId: f.role.id,
          candidateKey: f.occurrence.candidateKey,
          expectedRevision: 0,
          shortlisted: true,
        });
        if (corrupted) {
          await expect(save).rejects.toThrow(IsolationError);
          expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
          expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
        } else {
          await expect(save).resolves.toMatchObject({ shortlisted: true });
          expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledOnce();
        }
        expect(byteChecks).toBe(1);
      } finally {
        parseSpy.mockRestore();
      }
    },
  );
  it("reuses the same read snapshot's native page and binding while projecting a candidate import", async () => {
    const f = await nativeImportReadFixture();
    const listed = await nativeCandidateListRead(f);
    expect(listed.items[0]?.crm).toMatchObject({
      effectId: f.importEffect.id,
      status: "pending",
      target: f.target,
    });
    expect(f.nativeProofs).toHaveBeenCalledOnce();
    expect(
      f.tx.externalEffect.findFirst.mock.calls.filter(([query]) => query.where.id === f.binding.id),
    ).toHaveLength(1);
  });
  it("reuses the same source-list snapshot's verified native report for its import projection", async () => {
    const f = await nativeImportReadFixture();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.role.id,
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]?.crmImports).toMatchObject([
      { effectId: f.importEffect.id, status: "pending", target: f.target },
    ]);
    expect(f.nativeProofs).toHaveBeenCalledOnce();
  });
  it("batches native CRM source and owner reads while preserving each historical binding and status", async () => {
    const f = await nativeImportReadFixture();
    const otherBinding = {
      ...f.binding,
      id: "another-binding",
      result: { ...(f.binding.result as object), bindingEffectId: "another-binding" },
    };
    const otherEffect = {
      ...f.importEffect,
      id: "another-import",
      status: "executing",
      idempotencyKey: `recruiting-crm-import:${stableJsonValue([otherBinding.id, f.page.effectId, 0])}`,
    };
    f.effects.set(otherBinding.id, otherBinding);
    f.effects.set(otherEffect.id, otherEffect);
    f.links.push({ ...f.links[0]!, effectId: otherEffect.id, bindingEffectId: otherBinding.id });
    Object.assign(f.run, { leaseExpiresAt: new Date(0) });
    f.tx.run.findFirst.mockClear();
    f.tx.run.findUniqueOrThrow.mockClear();
    f.tx.recruitingCandidateOccurrence.findUnique.mockClear();
    const before = structuredClone({ links: f.links, effects: [...f.effects.values()] });
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.role.id,
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]?.crmImports).toEqual([
      expect.objectContaining({ effectId: f.importEffect.id, status: "pending", receipt: null }),
      expect.objectContaining({ effectId: otherEffect.id, status: "unknown", receipt: null }),
    ]);
    expect(sources.items[0]?.crmImports.map((item) => item.bindingEffectId)).toEqual([
      f.binding.id,
      otherBinding.id,
    ]);
    expect(f.tx.run.findMany).toHaveBeenCalledOnce();
    expect(f.tx.run.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        id: { in: [f.run.id] },
        bot: { spaceId: actor.spaceId, userId: actor.userId },
        thread: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [
            { botId: { not: null }, bot: { spaceId: actor.spaceId, userId: actor.userId } },
            {
              botId: null,
              groupId: { not: null },
              group: { spaceId: actor.spaceId, userId: actor.userId },
            },
            {
              botId: null,
              groupId: null,
              externalConversationId: { not: null },
              externalConversation: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                bot: { spaceId: actor.spaceId, userId: actor.userId },
              },
            },
          ],
        },
      },
      select: { id: true, spaceId: true, userId: true, status: true, leaseExpiresAt: true },
    });
    expect(f.tx.run.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(f.tx.recruitingCandidateOccurrence.findUnique).not.toHaveBeenCalled();
    expect(f.nativeProofs).toHaveBeenCalledOnce();
    expect({ links: f.links, effects: [...f.effects.values()] }).toEqual(before);
  });
  it.each(["missing", "foreign"])("rejects a %s batched CRM import owner", async (boundary) => {
    const f = await nativeImportReadFixture();
    f.tx.run.findMany.mockResolvedValue(
      boundary === "missing" ? [] : [{ ...f.run, userId: "another-owner" }],
    );
    await expect(nativeCandidateListRead(f)).rejects.toThrow(IsolationError);
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });
  it.each(["hash", "role", "revision", "artifact", "effect", "cursor"])(
    "does not reuse a native proof for a mismatched imported source %s",
    async (boundary) => {
      const f = await nativeImportReadFixture();
      const page = { ...f.page };
      if (boundary === "hash") page.artifactHash = "f".repeat(64);
      if (boundary === "role") page.roleId = "another-role";
      if (boundary === "revision") page.roleRevisionId = "another-revision";
      if (boundary === "artifact") page.artifactId = "foreign-artifact";
      if (boundary === "effect") page.effectId = "different-effect";
      if (boundary === "cursor") page.requestCursor = "different-cursor" as never;
      f.tx.recruitingCrmImport.findMany.mockResolvedValue([
        {
          ...f.links[0]!,
          effect: f.importEffect,
          occurrence: { ...f.occurrence, page },
        },
      ]);
      await expect(nativeCandidateListRead(f)).rejects.toThrow(IsolationError);
      expect(f.nativeProofs).toHaveBeenCalledTimes(2);
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it("does not reuse the current binding for an import from another binding", async () => {
    const f = await nativeImportReadFixture();
    f.links[0]!.bindingEffectId = "another-binding";
    await expect(nativeCandidateListRead(f)).rejects.toThrow(IsolationError);
    expect(f.tx.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "another-binding" }) }),
    );
  });
  it("keeps historical action sources subject to the canonical import schema check", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    });
    const action = await f.tx.recruitingResearchAction.findFirst();
    action.candidateOutputSchema = null as never;
    await expect(
      recruiting.listRecruitingCandidateSources(f.prisma, actor, {
        roleId: f.role.id,
        candidateKey: f.occurrence.candidateKey,
      }),
    ).rejects.toThrow(IsolationError);
  });
  it("revalidates the full native source when claiming a write after a read snapshot", async () => {
    const f = await nativeImportReadFixture();
    await nativeCandidateListRead(f);
    f.nativeProofs.mockClear();
    f.artifact.hash = "f".repeat(64);
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
        effectId: f.importEffect.id,
        effectKind: f.importEffect.kind,
        effectRequest: f.importEffect.request,
        from: "intended",
      }),
    ).rejects.toThrow(IsolationError);
    expect(f.nativeProofs).toHaveBeenCalledOnce();
    expect(f.importEffect.status).toBe("intended");
  });
  it.each([
    ["list", "valid"],
    ["list", "historical-owner"],
    ["list", "historical-hash"],
    ["shortlist", "valid"],
    ["shortlist", "historical-owner"],
    ["shortlist", "historical-hash"],
  ])(
    "validates contributing history once for %s at the %s boundary",
    async (operation, boundary) => {
      vi.mocked(createThreadMessageInTransaction).mockClear();
      const f = await nativeSourceFixture();
      f.role.crmBindingEffectId = null;
      const read = {
        ...f.read,
        id: "compact-read",
        result: { structuredContent: { rows: [{ name: "Example", updated_rank: 1 }] } },
      };
      const bytes = Buffer.from(
        stableJsonValue({ request: read.request, providerResult: read.result }),
      );
      const artifact = {
        ...f.artifact,
        id: "compact-artifact",
        hash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        clientNonce: "recruiting-observation:compact-read",
      };
      const page = {
        ...f.page,
        effectId: read.id,
        artifactId: artifact.id,
        artifactHash: artifact.hash,
        effect: read,
      };
      const historicalRun = { ...f.run, thread: f.thread };
      if (boundary === "historical-owner") historicalRun.userId = "other";
      if (boundary === "historical-hash") f.artifact.hash = "f".repeat(64);
      f.nativeProofs.mockResolvedValue([
        {
          ...f.artifact,
          effectId: f.read.id,
          effectStatus: f.read.status,
          effectRequest: f.read.request,
          effectResult: f.read.result === null ? null : JSON.stringify(f.read.result),
          effectRun: historicalRun,
        },
        {
          ...artifact,
          effectId: read.id,
          effectStatus: read.status,
          effectRequest: read.request,
          effectResult: read.result === null ? null : JSON.stringify(read.result),
          effectRun: { ...f.run, thread: f.thread },
        },
      ] as never);
      f.tx.event.findMany.mockResolvedValue([
        f.event,
        {
          ...f.event,
          id: "compact-event",
          payload: {
            ...f.event.payload,
            effectId: read.id,
            outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
          },
        },
      ] as never);
      const { page: _page, pageId: _pageId, rowIndex: _rowIndex, ...profile } = f.occurrence;
      const row = {
        ...profile,
        sourcePageId: page.effectId,
        sourceRowIndex: 0,
        profileSourcePageIds: [page.effectId, f.page.effectId],
        shortlisted: false,
        shortlistedAt: null,
        consideration: null,
        revision: 0,
        discoveryCount: 2,
        firstDiscoveredAt: f.page.observedAt.toISOString(),
        lastDiscoveredAt: f.page.observedAt.toISOString(),
        assessmentVersion: null,
        assessmentRoleRevisionId: null,
        assessmentCreatedAt: null,
        hardGate: null,
        sortValue: "example",
      };
      const queryRaw = f.tx.$queryRaw.getMockImplementation()!;
      f.tx.$queryRaw.mockImplementation(async (...args: unknown[]) =>
        (args[0] as { sql: string }).sql.includes('FROM "external_effects" e')
          ? Reflect.apply(queryRaw, undefined, args)
          : ([row] as never),
      );
      if (operation === "list")
        f.tx.$queryRaw.mockResolvedValueOnce(
          candidateProjectionRows(
            [
              {
                total: 1n,
                rankAvailable: false,
                tierAvailable: false,
                scoreAvailable: false,
                sourceRows: 2n,
                candidates: 1n,
                identifiedCandidates: 1n,
                unassessed: 1n,
                assessed: 0n,
                shortlisted: 0n,
              },
            ],
            [row],
          ) as never,
        );
      const findMany = vi.fn(async () => [page, { ...f.page, effect: f.read }]);
      const tx = {
        ...f.tx,
        recruitingCandidatePage: { ...f.tx.recruitingCandidatePage, findMany },
      };
      const prisma = {
        $executeRaw: vi.fn(async () => 0),
        $transaction: vi.fn(async (fn) => fn(tx)),
      } as unknown as PrismaClient;
      const result =
        operation === "list"
          ? recruiting.listRecruitingCandidates(prisma, actor, { roleId: "role" })
          : recruiting.setRecruitingCandidateShortlist(prisma, actor, {
              threadId: "thread",
              roleId: "role",
              candidateKey: f.occurrence.candidateKey,
              expectedRevision: 0,
              shortlisted: true,
            });
      if (boundary === "valid") {
        const saved = await result;
        if ("items" in saved) expect(saved.items[0]?.latestSource?.effectId).toBe(page.effectId);
      } else {
        await expect(result).rejects.toThrow(IsolationError);
        expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
      }
      expect(findMany).toHaveBeenLastCalledWith({
        where: { roleId: "role", effectId: { in: [page.effectId, f.page.effectId] } },
        include: { effect: { select: { request: true } } },
      });
      expect(findMany).toHaveBeenCalledTimes(operation === "list" ? 2 : 1);
      expect(f.nativeProofs).toHaveBeenCalledTimes(1);
      expect(f.tx.event.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it("reads native source proof in one joined request without ORM relation fanout", async () => {
    const f = await nativeSourceFixture();
    const queryRaw = vi.fn(async (_query: unknown) => [
      {
        ...f.artifact,
        effectId: f.read.id,
        effectStatus: f.read.status,
        effectRequest: f.read.request,
        effectResult: f.read.result === null ? null : JSON.stringify(f.read.result),
        effectRun: { ...f.run, thread: f.thread },
      },
    ]);
    const tx = {
      ...f.tx,
      $queryRaw: queryRaw,
      recruitingResearchTask: { findMany: vi.fn(async () => []) },
      recruitingCandidatePage: {
        findMany: vi.fn(async () => [{ ...f.page, effect: f.read }]),
      },
    };
    const prisma = {
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn) => fn(tx)),
    } as unknown as PrismaClient;
    expect(
      (await recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" })).observations,
    ).toHaveLength(1);
    expect(f.tx.externalEffect.findMany).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledOnce();
    const statement = queryRaw.mock.calls[0]![0] as unknown as {
      sql: string;
      values: unknown[];
    };
    for (const table of [
      "external_effects",
      "runs",
      "bots",
      "threads",
      "chat_groups",
      "external_conversations",
      "recruiting_candidate_pages",
      "artifacts",
    ])
      expect(statement.sql).toContain(`"${table}"`);
    expect(statement.sql).toContain('e."result"::text AS "effectResult"');
    expect(statement.values).toEqual([f.read.id, actor.spaceId]);
    f.read.result = { changed: true } as never;
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
    queryRaw.mockResolvedValueOnce([
      { ...(await f.nativeProofs())[0]!, effectResult: "{malformed" },
    ]);
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(SyntaxError);
  });

  it("validates every native page in one snapshot proof batch, including duplicate-event rejection", async () => {
    const f = await nativeSourceFixture();
    const thread = await f.tx.thread.findFirst();
    const pages = Array.from({ length: 13 }, (_, index) => {
      const id = `read-${index}`;
      const request = structuredClone(f.read.request) as unknown[];
      (request[2] as { args: { cursor?: string } }).args.cursor = `cursor-${index}`;
      const effect = { ...f.read, id, request };
      const bytes = Buffer.from(stableJsonValue({ request, providerResult: effect.result }));
      const artifact = {
        ...f.artifact,
        id: `artifact-${index}`,
        clientNonce: `recruiting-observation:${id}`,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      };
      return {
        ...f.page,
        effectId: id,
        requestCursor: `cursor-${index}`,
        artifactId: artifact.id,
        artifactHash: artifact.hash,
        artifact,
        effect,
      };
    });
    const events = pages.map((page, index) => ({
      ...f.event,
      id: `event-${index}`,
      payload: {
        ...f.event.payload,
        effectId: page.effectId,
        requestCursor: page.requestCursor,
        outputArtifact: { artifactId: page.artifactId, sha256: page.artifactHash },
      },
    }));
    f.nativeProofs.mockImplementation(
      async () =>
        pages.map((page) => ({
          ...page.artifact,
          effectId: page.effectId,
          effectStatus: page.effect.status,
          effectRequest: page.effect.request,
          effectResult: page.effect.result === null ? null : JSON.stringify(page.effect.result),
          effectRun: { ...f.run, thread: { ...thread, bot: actor } },
        })) as never,
    );
    f.tx.event.findMany.mockImplementation(async (...args: unknown[]) => {
      const where = (args[0] as { where: { payload?: { equals: string } } }).where;
      return (
        where.payload
          ? events.filter((event) => event.payload.effectId === where.payload!.equals)
          : events
      ) as never;
    });
    f.tx.externalEffect.findFirst.mockImplementation(
      async ({ where }) =>
        (pages.find((page) => page.effectId === where.id)?.effect ?? null) as never,
    );
    f.tx.artifact.findUnique.mockImplementation(async (...args: unknown[]) => {
      const { where } = args[0] as { where: { id: string } };
      return (pages.find((page) => page.artifactId === where.id)?.artifact ?? null) as never;
    });
    const tx = {
      ...f.tx,
      recruitingResearchTask: { findMany: vi.fn(async () => []) },
      recruitingCandidatePage: { findMany: vi.fn(async () => pages) },
    };
    const prisma = {
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn) => fn(tx)),
    } as unknown as PrismaClient;
    f.tx.thread.findFirst.mockClear();
    const result = await recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" });
    expect(result.observations.map((page) => page.effectId)).toEqual(
      pages.map((page) => page.effectId),
    );
    expect(f.nativeProofs).toHaveBeenCalledTimes(1);
    expect(f.tx.event.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        spaceId: actor.spaceId,
        runId: { in: [f.run.id] },
        type: "recruiting.candidates.saved",
        OR: pages.map((page) => ({ payload: { path: ["effectId"], equals: page.effectId } })),
      },
    });
    expect(f.tx.run.findFirst).not.toHaveBeenCalled();
    expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    events.push({ ...events.at(-1)!, id: "duplicate-other-thread", threadId: "other-thread" });
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
  });

  it("lists native saved research history without creating domain tasks", async () => {
    const f = await nativeSourceFixture();
    const tx = {
      ...f.tx,
      recruitingResearchTask: { findMany: vi.fn(async () => []) },
      recruitingCandidatePage: {
        ...f.tx.recruitingCandidatePage,
        findMany: vi.fn(async () => [{ ...f.page, effect: f.read }]),
      },
    };
    const prisma = {
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn) => fn(tx)),
    } as unknown as PrismaClient;
    const result = await recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" });
    expect(result).toEqual({
      tasks: [],
      actions: [],
      observations: [
        {
          effectId: "read",
          providerTaskId: "provider-task",
          roleRevisionId: "revision",
          runId: "run",
          rowCount: 1,
          observedAt: f.page.observedAt.toISOString(),
          requestCursor: null,
          artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
        },
      ],
    });
    expect(tx.recruitingCandidatePage.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", taskId: null, actionId: null },
      orderBy: [{ observedAt: "asc" }, { effectId: "asc" }],
      include: { effect: { select: { runId: true, request: true } } },
    });
    f.artifact.hash = "f".repeat(64);
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
    tx.recruitingCandidatePage.findMany.mockClear();
    await expect(
      recruiting.listRecruitingResearch(prisma, { ...actor, userId: "other" }, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
    expect(tx.recruitingCandidatePage.findMany).not.toHaveBeenCalled();
  });
  it("serves the native artifact and keeps unassessed sources readable after a role revision", async () => {
    const f = await nativeSourceFixture();
    f.role.currentRevisionId = "later-revision";
    f.role.revision = 2;
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]).toMatchObject({
      providerTaskId: "provider-task",
      taskId: null,
      actionId: null,
      effectId: "read",
      roleRevisionId: "revision",
      artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
    });
    expect(f.tx.recruitingCandidateOccurrence.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: f.occurrence.candidateKey },
      orderBy: [{ page: { observedAt: "desc" } }, { pageId: "desc" }, { rowIndex: "desc" }],
      take: 26,
      include: { page: { include: { effect: { select: { request: true } } } } },
    });
    expect(f.tx.recruitingResearchAction.findFirst).not.toHaveBeenCalled();
  });
  it("loads source imports once and keeps each receipt on its exact source page", async () => {
    const f = await nativeSourceFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "completed";
    effect.result = {
      structuredContent: {
        data: {
          candidate_id: "40000000-0000-4000-8000-000000000004",
          source_id: "50000000-0000-4000-8000-000000000005",
          membership_id: "60000000-0000-4000-8000-000000000006",
          organization_id: f.target.organizationId,
          role_spec_id: f.target.crmRoleId,
          linkedin_identity: "/in/example",
          source_file: resolved.args.p_source_file,
        },
      },
    };
    const request = structuredClone(f.page.effect.request);
    const read = { ...f.page.effect, id: "later-read", request };
    const bytes = Buffer.from(stableJsonValue({ request, providerResult: read.result }));
    const artifact = {
      ...f.artifact,
      id: "later-artifact",
      clientNonce: `recruiting-observation:${read.id}`,
      size: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
    const page = {
      ...f.page,
      effectId: read.id,
      effect: read,
      artifactId: artifact.id,
      artifactHash: artifact.hash,
    };
    f.nativeProofs.mockResolvedValue([
      ...(await f.nativeProofs()),
      {
        ...artifact,
        effectId: read.id,
        effectStatus: read.status,
        effectRequest: read.request,
        effectResult: read.result === null ? null : JSON.stringify(read.result),
        effectRun: { ...f.run, thread: f.thread },
      },
    ]);
    f.tx.event.findMany.mockResolvedValue([
      f.event,
      {
        ...f.event,
        id: "later-save",
        payload: {
          ...f.event.payload,
          effectId: read.id,
          outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
        },
      },
    ] as never);
    f.tx.recruitingCandidateOccurrence.count.mockResolvedValue(2);
    f.tx.recruitingCandidateOccurrence.findMany.mockResolvedValue([
      f.occurrence,
      { ...f.occurrence, pageId: page.effectId, page },
    ]);
    const findImports = f.tx.recruitingCrmImport.findMany.getMockImplementation()!;
    f.tx.recruitingCrmImport.findMany.mockImplementation(async (...args: unknown[]) => {
      const where = (
        args[0] as {
          where: {
            pageId?: string;
            rowIndex?: number;
            OR?: { pageId: string; rowIndex: number }[];
          };
        }
      ).where;
      const tuples = where.OR ?? [where];
      return (await findImports()).filter((link) =>
        tuples.some((tuple) => tuple.pageId === link.pageId && tuple.rowIndex === link.rowIndex),
      );
    });
    f.tx.recruitingCrmImport.findMany.mockClear();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(f.tx.recruitingCrmImport.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        occurrence: { roleId: "role", candidateKey: f.occurrence.candidateKey },
        OR: [
          { pageId: f.page.effectId, rowIndex: 0 },
          { pageId: page.effectId, rowIndex: 0 },
        ],
      },
      include: { effect: true, occurrence: true },
      orderBy: [{ effect: { createdAt: "asc" } }, { effectId: "asc" }],
    });
    expect(sources.items[0]?.crmImports).toMatchObject([
      {
        effectId: effect.id,
        status: "synced",
        receipt: { source_file: resolved.args.p_source_file },
      },
    ]);
    expect(sources.items[1]?.crmImports).toEqual([]);
  });
  it("does not query imports when the selected source page is empty", async () => {
    const f = await nativeSourceFixture();
    f.tx.recruitingCandidateOccurrence.count.mockResolvedValue(0);
    f.tx.recruitingCandidateOccurrence.findMany.mockResolvedValue([]);
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items).toEqual([]);
    expect(f.tx.recruitingCrmImport.findMany).not.toHaveBeenCalled();
  });
  it.each(["unselected-tuple", "other-role", "other-candidate"])(
    "rejects an out-of-scope source import before reading its receipt: %s",
    async (boundary) => {
      const f = await nativeSourceFixture();
      f.tx.recruitingCrmImport.findMany.mockResolvedValue([
        {
          effectId: "unexpected-import",
          bindingEffectId: f.binding.id,
          pageId: f.page.effectId,
          rowIndex: boundary === "unselected-tuple" ? 1 : 0,
          occurrence: {
            ...f.occurrence,
            roleId: boundary === "other-role" ? "other-role" : f.role.id,
            candidateKey:
              boundary === "other-candidate" ? "other-candidate" : f.occurrence.candidateKey,
          },
        },
      ] as never);
      f.tx.externalEffect.findFirst.mockClear();
      await expect(
        recruiting.listRecruitingCandidateSources(f.prisma, actor, {
          roleId: "role",
          candidateKey: f.occurrence.candidateKey,
        }),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.externalEffect.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each(
    ["valid", "foreign-actor", "artifact-hash"].flatMap((boundary) =>
      (["name", "rank", "tier", "score"] as const).map((sort) => ({ boundary, sort })),
    ),
  )(
    "binds the bounded candidate page to its validated latest source at $boundary for $sort",
    async ({ boundary, sort }) => {
      const f = await nativeSourceFixture();
      f.role.crmBindingEffectId = null;
      const { page: _page, pageId, rowIndex, ...profile } = f.occurrence;
      const row = {
        ...profile,
        sourcePageId: pageId,
        sourceRowIndex: rowIndex,
        profileSourcePageIds: [pageId],
        shortlisted: false,
        shortlistedAt: null,
        consideration: null,
        revision: 0,
        discoveryCount: 1,
        firstDiscoveredAt: f.page.observedAt.toISOString(),
        lastDiscoveredAt: f.page.observedAt.toISOString(),
        assessmentVersion: null,
        assessmentRoleRevisionId: null,
        assessmentCreatedAt: null,
        hardGate: null,
        sortValue: "example",
      };
      f.tx.$queryRaw.mockResolvedValueOnce(
        candidateProjectionRows(
          [
            {
              total: 1n,
              rankAvailable: false,
              tierAvailable: false,
              scoreAvailable: false,
              sourceRows: 1n,
              candidates: 1n,
              identifiedCandidates: 1n,
              unassessed: 1n,
              assessed: 0n,
              shortlisted: 0n,
            },
          ],
          [row],
        ) as never,
      );
      const findMany = vi.fn(async () => [{ ...f.page, effect: f.read }]);
      const tx = {
        ...f.tx,
        recruitingCandidatePage: { ...f.tx.recruitingCandidatePage, findMany },
      };
      const prisma = {
        $executeRaw: vi.fn(async () => 0),
        $transaction: vi.fn(async (fn) => fn(tx)),
      } as unknown as PrismaClient;
      if (boundary === "artifact-hash") f.artifact.hash = "f".repeat(64);
      const result = recruiting.listRecruitingCandidates(
        prisma,
        boundary === "foreign-actor" ? { ...actor, userId: "other" } : actor,
        { roleId: "role", limit: 1, sort },
      );
      if (boundary !== "valid") {
        await expect(result).rejects.toThrow(IsolationError);
        if (boundary === "foreign-actor") expect(findMany).not.toHaveBeenCalled();
        return;
      }
      expect((await result).items[0]?.latestSource).toMatchObject({
        effectId: pageId,
        rowIndex,
        taskId: null,
        actionId: null,
        roleRevisionId: "revision",
        artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
      });
      expect(findMany).toHaveBeenLastCalledWith({
        where: { roleId: "role", effectId: { in: [pageId] } },
        include: { effect: { select: { request: true } } },
      });
      expect(findMany).toHaveBeenCalledTimes(2);
      const [statement] = f.tx.$queryRaw.mock.calls[0] as unknown as [{ sql: string }];
      expect(statement.sql).toContain(
        'p."pageId" AS "sourcePageId", p."rowIndex" AS "sourceRowIndex"',
      );
    },
  );
  it("keeps the exact provider task separate from historical custom task/action links", async () => {
    const f = crmFixture();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]).toMatchObject({
      providerTaskId: "provider-task",
      taskId: "task",
      actionId: "action",
    });
  });
  it.each([{ userId: "other" }, { spaceId: "other" }])(
    "rejects an actor mismatch before reading source metadata: %j",
    async (mismatch) => {
      const f = await nativeSourceFixture();
      await expect(
        recruiting.listRecruitingCandidateSources(
          f.prisma,
          { ...actor, ...mismatch },
          {
            roleId: "role",
            candidateKey: f.occurrence.candidateKey,
          },
        ),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingCandidateOccurrence.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    "artifact-hash",
    "artifact-size",
    "artifact-id",
    "run-owner",
    "run-empty-owner",
    "run-bot-owner",
    "thread-owner",
    "thread-empty-owner",
    "thread-bot-owner",
    "thread-bot-empty-owner",
    "source-role",
    "event-role",
    "event-owner",
    "route",
    "schema",
    "missing-event",
    "duplicate-event",
  ])("rejects a native source with invalid %s", async (boundary) => {
    const f = await nativeSourceFixture();
    if (boundary === "artifact-hash") f.artifact.hash = "f".repeat(64);
    if (boundary === "artifact-size") Object.assign(f.artifact, { size: 0 });
    if (boundary === "artifact-id") f.artifact.id = "other-artifact";
    if (boundary === "run-owner") f.run.userId = "other";
    if (boundary === "run-empty-owner") f.run.userId = "";
    if (boundary === "run-bot-owner") f.run.bot = { ...actor, userId: "other" };
    if (boundary === "thread-owner") f.thread.userId = "other";
    if (boundary === "thread-empty-owner") f.thread.userId = "";
    if (boundary === "thread-bot-owner") f.thread.bot.userId = "other";
    if (boundary === "thread-bot-empty-owner") f.thread.bot.userId = "";
    if (boundary === "source-role") f.page.roleId = "other-role";
    if (boundary === "event-role") f.event.payload.roleId = "other-role";
    if (boundary === "event-owner") f.event.runId = "other-run";
    if (boundary === "route") f.event.payload.providerTaskId = "other-task";
    if (boundary === "schema") f.event.payload.candidateOutputSchema = "unknown";
    if (boundary === "missing-event") f.tx.event.findMany.mockResolvedValue([]);
    if (boundary === "duplicate-event")
      f.tx.event.findMany.mockResolvedValue([f.event, { ...f.event, id: "duplicate" }] as never);
    await expect(
      recruiting.listRecruitingCandidateSources(f.prisma, actor, {
        roleId: "role",
        candidateKey: f.occurrence.candidateKey,
      }),
    ).rejects.toThrow();
  });
  it.each(["group", "external-conversation", "external-bot"])(
    "preserves scoped native %s thread parents",
    async (boundary) => {
      const f = await nativeSourceFixture();
      f.role.crmBindingEffectId = null;
      const parent = { ...actor };
      const bot = { ...actor };
      Object.assign(f.thread, {
        botId: null,
        groupId: boundary === "group" ? "group" : null,
        group: parent,
        externalConversationId: boundary === "group" ? null : "conversation",
        externalConversation: { ...parent, bot },
      });
      const input = { roleId: "role", candidateKey: f.occurrence.candidateKey };
      expect(
        (await recruiting.listRecruitingCandidateSources(f.prisma, actor, input)).items,
      ).toHaveLength(1);
      if (boundary === "group") parent.userId = "other";
      if (boundary === "external-conversation")
        Object.assign(f.thread, { externalConversation: { ...parent, userId: "other", bot } });
      if (boundary === "external-bot") bot.userId = "other";
      await expect(
        recruiting.listRecruitingCandidateSources(f.prisma, actor, input),
      ).rejects.toThrow(IsolationError);
    },
  );
  it("keeps the existing CRM identity and target guards for a native discovery", async () => {
    const f = await nativeSourceFixture();
    const prepared = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    );
    expect(prepared?.args).toMatchObject({
      p_name: "Example",
      p_linkedin_url: f.occurrence.linkedinUrl,
    });
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
    f.occurrence.name = null;
    await expect(
      recruiting.resolveRecruitingCrmImport(f.prisma, actor, f.trusted, f.input),
    ).rejects.toThrow();
  });
});

describe("native candidate results without domain actions", () => {
  it.each([20, 100])("reuses complete source rows one-to-one with read limit %s", async (limit) => {
    const f = nativeCandidateFixture();
    const anonymous = {
      ...f.row,
      name: { value: "Anonymous profile", source_id: "name-source" },
      linkedin_url: null,
      signals: { value: ["first", "second"], source_ids: ["a", "b"], reasoning: null },
    };
    const route = {
      connectorId: "mcp" as const,
      resourceId: "server",
      resourceRevision: 1,
      toolName: "get_rows",
    };
    const args = { task_id: "provider-task", limit: 20 };
    const originalQuery = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: unknown) => {
      if (!(query as { sql: string }).sql.includes("incoming_source_rows"))
        return originalQuery(query);
      return f.effect.id === "read"
        ? []
        : [
            { rowIndex: 0, candidateKey: "source-row:read:1" },
            { rowIndex: 2, candidateKey: "source-row:read:2" },
          ];
    });
    for (const [effectId, rows] of [
      ["read", [f.row, anonymous, structuredClone(anonymous)]],
      [
        "followup-read",
        [
          Object.fromEntries(Object.entries(anonymous).reverse()),
          { ...f.row, match_score: 2 },
          structuredClone(anonymous),
        ],
      ],
    ] as const) {
      const request = boundDirectApprovalRequest(
        route,
        { ...args, limit: effectId === "read" ? 20 : limit },
        "__rakazoCatalogTool",
      );
      Object.assign(f.effect, {
        id: effectId,
        request,
        result: { structuredContent: { rows, next_cursor: null } },
      });
      Object.assign(f.saveEffect, { status: "executing", result: null });
      const bytes = Buffer.from(stableJsonValue({ request, providerResult: f.effect.result }));
      Object.assign(f.file, {
        hash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        clientNonce: `recruiting-observation:${effectId}`,
      });
      await recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
        sourceEffectId: effectId,
        rows,
        outputArtifact: f.file,
      });
    }
    const writes = f.tx.recruitingCandidateOccurrence.createMany.mock.calls.map(
      ([input]) => (input as { data: Array<{ candidateKey: string }> }).data,
    );
    expect(writes[1]?.map((row) => row.candidateKey)).toEqual([
      "source-row:read:1",
      "linkedin:/in/example",
      "source-row:read:2",
    ]);
    expect(new Set(writes.flat().map((row) => row.candidateKey)).size).toBe(3);
    expect(writes.flat()).toHaveLength(6);
    const queries = f.tx.$queryRaw.mock.calls
      .map(([query]) => query as { sql: string; values: unknown[] })
      .filter((query) => query.sql.includes("incoming_source_rows"));
    expect(queries).toHaveLength(2);
    for (const [index, query] of queries.entries()) {
      expect(query.values).toEqual(
        expect.arrayContaining([
          actor.spaceId,
          actor.userId,
          "role",
          JSON.stringify(route),
          JSON.stringify({ ...args, limit: index === 0 ? 20 : limit }),
        ]),
      );
      expect(query.sql).toContain("row_number()");
      expect(query.sql).toContain("selected_source_pages");
      expect(query.sql).toContain("count(*) AS multiplicity");
      expect(query.sql).toContain("page.args = current.args");
      expect(query.sql).toContain("NOT (page.args ? 'cursor')");
      expect(query.sql).toContain("NOT (current.args ? 'cursor')");
      expect(query.sql).toContain("page.body->'next_cursor' = 'null'::jsonb");
      expect(query.sql).toContain("current.body->'next_cursor' = 'null'::jsonb");
      expect(query.sql).toContain('returned.value = incoming."row"');
      expect(query.sql).not.toMatch(/->\s*'(?:name|source_id|source_ids)'/);
    }
  });

  it("reuses the locked run and same source thread without rereading validated artifact metadata", async () => {
    const f = nativeCandidateFixture();
    await recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
      sourceEffectId: "read",
      rows: [f.row],
      outputArtifact: f.file,
    });
    expect(f.tx.run.findFirst).toHaveBeenCalledTimes(1);
    expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(2);
    expect(f.tx.artifact.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "context", spaceId: actor.spaceId, userId: actor.userId },
    });
    expect(f.tx.thread.findFirst).toHaveBeenLastCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        id: "thread",
        groupId: null,
        OR: [{ botId: "bot" }, { externalConversation: { botId: "bot" } }],
      },
    });
    expect(f.tx.artifact.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each(["owner", "space", "hash", "run", "anchor", "unrelated-thread"])(
    "still validates the adopted artifact %s when reusing the locked context",
    async (boundary) => {
      const f = nativeCandidateFixture();
      const artifact = f.artifacts.get("context")!;
      if (boundary === "owner") artifact.userId = "other";
      if (boundary === "space") artifact.spaceId = "other";
      if (boundary === "hash") artifact.hash = "f".repeat(64);
      if (boundary === "run") {
        artifact.runId = "other-run";
        f.tx.run.findFirst.mockResolvedValueOnce(f.run).mockResolvedValueOnce({
          ...f.run,
          id: "other-run",
          userId: "other",
        });
      }
      if (boundary === "anchor" || boundary === "unrelated-thread") {
        const thread = await f.tx.thread.findFirst();
        if (boundary === "anchor")
          f.tx.thread.findFirst.mockResolvedValueOnce(thread).mockResolvedValueOnce(null as never);
        else {
          Object.assign(artifact, { runId: null });
          f.tx.thread.findFirst
            .mockResolvedValueOnce(thread)
            .mockResolvedValueOnce({ ...thread, id: "other-thread" })
            .mockResolvedValueOnce({ ...thread, id: "other-thread", userId: "other" });
        }
      }
      await expect(
        recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
          sourceEffectId: "read",
          rows: [f.row],
          outputArtifact: f.file,
        }),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );

  it("still authorizes a different role source thread before saving", async () => {
    const f = nativeCandidateFixture();
    f.role.sourceThreadId = "source-thread";
    const thread = await f.tx.thread.findFirst();
    f.tx.thread.findFirst.mockClear();
    f.tx.thread.findFirst
      .mockResolvedValueOnce(thread)
      .mockResolvedValueOnce({ ...thread, id: "source-thread", userId: "other" });
    await expect(
      recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
        sourceEffectId: "read",
        rows: [f.row],
        outputArtifact: f.file,
      }),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
  });

  it.each(
    ["direct", "connectors_execute_tool", "mcp_execute_tool"].flatMap((tool) =>
      [undefined, null, "next-page"].map((cursor) => ({ tool, cursor })),
    ),
  )(
    "filters native $tool receipts by task and cursor $cursor before loading their results",
    async ({ tool, cursor }) => {
      const f = nativeCandidateFixture();
      const route = {
        connectorId: "mcp",
        resourceId: "server",
        resourceRevision: 1,
        toolName: "get_rows",
      };
      const args = { task_id: "provider-task", ...(cursor === undefined ? {} : { cursor }) };
      f.effect.request = (
        tool === "direct"
          ? boundDirectApprovalRequest(route, args, "__rakazoCatalogTool")
          : catalogApprovalRequest(
              tool,
              { id: "server:get_rows", arguments: args },
              "__rakazoCatalogTool",
              route,
            )
      ) as never;
      const result = await recruiting.readNativeRecruitingCandidatePage(f.prisma, actor, "run", {
        ...f.input,
        cursor: cursor ?? null,
      });
      expect(result.effect.id).toBe("read");
      const argsPath = ["2", tool === "direct" ? "args" : "arguments"];
      expect(f.tx.externalEffect.findMany).toHaveBeenCalledExactlyOnceWith({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          runId: "run",
          status: "completed",
          request: { path: ["0"], equals: "__rakazoCatalogTool" },
          OR: expect.arrayContaining([
            {
              AND: expect.arrayContaining([
                { request: { path: ["1"], equals: tool } },
                { request: { path: [...argsPath, "task_id"], equals: "provider-task" } },
                { request: { path: [...argsPath, "cursor"], equals: cursor ?? Prisma.AnyNull } },
              ]),
            },
          ]),
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
    },
  );

  it("derives the connection from the completed native receipt when saving without an internal ID", async () => {
    const f = nativeCandidateFixture();
    const { mcpServerId: _, ...input } = f.input;
    Object.assign(f.saveEffect, { request: input });
    const result = await recruiting.saveNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      { ...f.trusted, effectRequest: input },
      input,
      { sourceEffectId: "read", rows: [f.row], outputArtifact: f.file },
    );
    expect(result).toMatchObject({ status: "saved", sourceEffectId: "read" });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "recruiting.candidates.saved",
        payload: expect.objectContaining({ mcpServerId: "server" }),
      }),
    );
  });

  it("selects only an owned completed get_rows page on the exact native task and cursor", async () => {
    const f = nativeCandidateFixture();
    const result = await recruiting.readNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      "run",
      f.input,
    );
    expect(result.effect.id).toBe("read");
    expect(result.snapshot).toEqual(f.snapshot);
    expect(f.tx.recruitingResearchAction.findFirst).not.toHaveBeenCalled();
    expect(f.tx.recruitingResearchTask.findUnique).not.toHaveBeenCalled();
    expect(f.tx.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { lte: f.effect.createdAt } }),
      }),
    );
    for (const input of [
      { ...f.input, providerTaskId: "other-task" },
      { ...f.input, mcpServerId: "other-server" },
      { ...f.input, cursor: "another-page" },
    ]) {
      await expect(
        recruiting.readNativeRecruitingCandidatePage(f.prisma, actor, "run", input),
      ).rejects.toThrow();
    }
  });

  it("indexes native candidates and completes its save receipt atomically without fake tasks", async () => {
    const f = nativeCandidateFixture();
    const candidate = await f.tx.recruitingCandidate.findUnique();
    const consideration = {
      operation: "hold",
      source: {
        messageId: "human-decision",
        threadId: "thread",
        seq: 5,
        createdAt: "2026-10-18T00:00:00.000Z",
        quote: "Pause consideration",
        actor: { userId: actor.userId, spaceId: actor.spaceId },
      },
    };
    Object.assign(candidate, { candidateKey: "linkedin:/in/example", consideration, revision: 5 });
    const result = await recruiting.saveNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      { sourceEffectId: "read", rows: [f.row, { ...f.row }, null], outputArtifact: f.file },
    );
    expect(result).toMatchObject({
      status: "saved",
      roleId: "role",
      roleRevisionId: "revision",
      sourceEffectId: "read",
      candidateRows: [
        { rowIndex: 0, candidateKey: "linkedin:/in/example" },
        { rowIndex: 1, candidateKey: "linkedin:/in/example" },
        { rowIndex: 2, candidateKey: "source-row:read:2" },
      ],
    });
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: null,
        actionId: null,
        roleId: "role",
        effectId: "read",
        rowCount: 3,
        observedAt: f.effect.updatedAt,
        artifactHash: f.file.hash,
      }),
    });
    expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "role", candidateKey: "linkedin:/in/example" },
        { roleId: "role", candidateKey: "source-row:read:2" },
      ],
      skipDuplicates: true,
    });
    expect(candidate).toMatchObject({ consideration, revision: 5 });
    expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
    expect(f.saveEffect).toMatchObject({ status: "completed", result });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "recruiting.candidates.saved",
        payload: expect.objectContaining({
          candidateOutputSchema: "candidate_output_v1",
          providerTaskId: "provider-task",
          outputArtifact: { artifactId: "observation-artifact", sha256: f.file.hash },
        }),
      }),
    );
    expect(f.tx.recruitingResearchAction.update).not.toHaveBeenCalled();
  });

  it("keeps people sharing an article distinct across native source pages", async () => {
    for (const [effectId, cursor] of [
      ["first-read", null],
      ["followup-read", "next-page"],
    ] as const) {
      const f = nativeCandidateFixture();
      const row = {
        ...f.row,
        linkedin_url: null,
        profile_url: { value: "https://example.test/interviews/two-people", source_id: effectId },
      };
      const rows = [row, { ...row, name: "Another Example" }, null];
      const before = JSON.stringify(rows);
      Object.assign(f.effect, {
        id: effectId,
        request: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: "server",
            resourceRevision: 1,
            toolName: "get_rows",
          },
          { task_id: "provider-task", cursor },
          "__rakazoCatalogTool",
        ),
        result: { structuredContent: { rows } },
      });
      Object.assign(f.input, { cursor });
      const bytes = Buffer.from(
        stableJsonValue({ request: f.effect.request, providerResult: f.effect.result }),
      );
      Object.assign(f.file, {
        hash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        clientNonce: `recruiting-observation:${effectId}`,
      });
      const result = await recruiting.saveNativeRecruitingCandidatePage(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        { sourceEffectId: effectId, rows, outputArtifact: f.file },
      );
      const candidateKey = `source-row:${effectId}:0`;
      const otherKey = `source-row:${effectId}:1`;
      const unknownKey = `source-row:${effectId}:2`;
      expect(result).toMatchObject({
        candidateRows: [
          { rowIndex: 0, candidateKey },
          { rowIndex: 1, candidateKey: otherKey },
          { rowIndex: 2, candidateKey: unknownKey },
        ],
      });
      expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
        data: [
          { roleId: "role", candidateKey },
          { roleId: "role", candidateKey: otherKey },
          { roleId: "role", candidateKey: unknownKey },
        ],
        skipDuplicates: true,
      });
      expect(f.tx.recruitingCandidateOccurrence.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ pageId: effectId, rowIndex: 0, candidateKey }),
          expect.objectContaining({ pageId: effectId, rowIndex: 1, candidateKey: otherKey }),
          expect.objectContaining({ pageId: effectId, rowIndex: 2, candidateKey: unknownKey }),
        ],
      });
      expect(JSON.stringify(rows)).toBe(before);
    }
  });

  it.each(["foreign-run", "wrong-hash", "expired-lease", "stale-role", "changed-receipt"])(
    "rejects %s without candidate writes",
    async (failure) => {
      const f = nativeCandidateFixture();
      if (failure === "foreign-run") f.effect.runId = "other-run";
      if (failure === "wrong-hash") f.file.hash = "f".repeat(64);
      if (failure === "expired-lease") Object.assign(f.run, { leaseExpiresAt: new Date(0) });
      if (failure === "stale-role") f.input.expectedRoleRevision = 2;
      if (failure === "changed-receipt")
        f.saveEffect.request = { ...f.input, providerTaskId: "other" };
      await expect(
        recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
          sourceEffectId: "read",
          rows: [f.row],
          outputArtifact: f.file,
        }),
      ).rejects.toThrow();
      expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );

  it("replays a completed save after a role revision without recreating projections", async () => {
    const f = nativeCandidateFixture();
    const saved = {
      status: "saved",
      roleId: "role",
      roleRevisionId: "revision",
      sourceEffectId: "read",
      outputArtifact: { artifactId: "observation-artifact", sha256: f.file.hash },
      candidateRows: [{ rowIndex: 0, candidateKey: "linkedin:/in/example" }],
    };
    Object.assign(f.saveEffect, { status: "completed", result: saved });
    f.input.expectedRoleRevision = 1;
    f.tx.recruitingRole.findFirst.mockResolvedValue({ ...f.role, revision: 2 } as never);
    expect(
      await recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
        sourceEffectId: "read",
        rows: [f.row],
        outputArtifact: f.file,
      }),
    ).toEqual(saved);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
  });
});

describe("recruiter CSV candidate import", () => {
  function csvImportFixture() {
    const f = nativeCandidateFixture();
    const input = {
      operation: "import_csv" as const,
      roleId: "role",
      expectedRoleRevision: 1,
      artifactId: "csv",
      mapping: { name: "Name", linkedinUrl: "LinkedIn", company: "Company" },
    };
    Object.assign(f.saveEffect, { request: input });
    const trusted = { ...f.trusted, effectRequest: input };
    const csvHash = "c".repeat(64);
    const csvArtifact = { ...actor, id: "csv", hash: csvHash, botId: "bot", runId: "upload-run" };
    const contextFind = f.tx.artifact.findFirst.getMockImplementation()!;
    f.tx.artifact.findFirst.mockImplementation(async (args) =>
      args.where.id === "csv" ? (csvArtifact as never) : contextFind(args),
    );
    const existing: Array<{ candidateKey: string }> = [];
    Object.assign(f.tx.recruitingCandidate, {
      findMany: vi.fn(async () => existing),
      createMany: vi.fn(async () => ({ count: 1 })),
    });
    const captured: Parameters<typeof recruiting.recruitingCsvImportReceipt>[1] = {
      artifactSha256: csvHash,
      header: ["Name", "LinkedIn", "Company"],
      rows: [
        {
          rowIndex: 0,
          csvRowIndex: 0,
          row: {
            name: "Ada Example",
            linkedin_url: "https://www.linkedin.com/in/example",
            current_company: "Example Co",
          },
        },
        { rowIndex: 1, csvRowIndex: 2, row: { name: "No Profile" } },
      ],
      skipped: [{ csvRowIndex: 1, reason: "missing_name_and_linkedin_url" }],
      truncated: false,
    };
    const bytes = Buffer.from(
      stableJsonValue(recruiting.recruitingCsvImportReceipt(input, captured)),
    );
    const outputArtifact = {
      name: "recruiting-csv-import.json",
      mimeType: "application/json",
      size: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
      storageKey: "receipt",
      clientNonce: "recruiting-csv-import:save",
    };
    const save = () =>
      recruiting.saveRecruitingCandidateCsvImport(f.prisma, actor, trusted, input, {
        ...captured,
        outputArtifact,
      });
    return { ...f, input, trusted, captured, outputArtifact, existing, csvArtifact, save };
  }

  it("saves one unassessed page with CSV provenance and reports skipped rows", async () => {
    const f = csvImportFixture();
    const result = (await f.save()) as Record<string, unknown>;
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        effectId: "save",
        roleId: "role",
        taskId: null,
        actionId: null,
        roleRevisionId: "revision",
        artifactId: "observation-artifact",
        artifactHash: f.outputArtifact.hash,
        requestCursor: null,
        outputId: null,
        rowCount: 2,
      }),
    });
    const occurrences = (
      f.tx.recruitingCandidateOccurrence.createMany.mock.calls[0]![0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(occurrences.map((row) => [row.rowIndex, row.candidateKey, row.name])).toEqual([
      [0, "linkedin:/in/example", "Ada Example"],
      [1, "source-row:save:1", "No Profile"],
    ]);
    // Unmapped columns stay missing so they never mask an older provider value.
    expect(occurrences[0]!.issues).toEqual(
      expect.arrayContaining(["missing_field:current_title", "missing_field:location"]),
    );
    expect(result).toMatchObject({
      status: "saved",
      sourceEffectId: "save",
      source: {
        kind: "csv_import",
        artifactId: "csv",
        artifactSha256: "c".repeat(64),
        importedBy: { userId: actor.userId, runId: "run" },
        observedAt: expect.any(String),
      },
      outputArtifact: { artifactId: "observation-artifact", sha256: f.outputArtifact.hash },
      candidateRows: [
        { rowIndex: 0, csvRowIndex: 0, candidateKey: "linkedin:/in/example", alreadyInPool: false },
        { rowIndex: 1, csvRowIndex: 2, candidateKey: "source-row:save:1", alreadyInPool: false },
      ],
      skipped: [{ csvRowIndex: 1, reason: "missing_name_and_linkedin_url" }],
      truncated: false,
    });
    expect(f.saveEffect).toMatchObject({ status: "completed", result });
  });

  it("adds a discovery to an existing LinkedIn candidate instead of duplicating them", async () => {
    const f = csvImportFixture();
    f.existing.push({ candidateKey: "linkedin:/in/example" });
    const result = (await f.save()) as { candidateRows: Array<Record<string, unknown>> };
    expect(result.candidateRows[0]).toMatchObject({
      candidateKey: "linkedin:/in/example",
      alreadyInPool: true,
    });
    // discoveryCount is the occurrence count per key: one new occurrence, no new candidate row.
    expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "role", candidateKey: "linkedin:/in/example" },
        { roleId: "role", candidateKey: "source-row:save:1" },
      ],
      skipDuplicates: true,
    });
  });

  it("refuses a stale role revision before writing", async () => {
    const f = csvImportFixture();
    f.role.revision = 2;
    await expect(f.save()).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
  });

  it.each(["foreign-artifact", "artifact-hash", "receipt-hash", "inactive-role"])(
    "refuses %s",
    async (boundary) => {
      const f = csvImportFixture();
      if (boundary === "foreign-artifact")
        f.tx.artifact.findFirst.mockImplementation(async () => undefined as never);
      if (boundary === "artifact-hash") f.csvArtifact.hash = "d".repeat(64);
      if (boundary === "receipt-hash") f.outputArtifact.hash = "e".repeat(64);
      if (boundary === "inactive-role") f.input.roleId = "other-role";
      if (boundary === "inactive-role") Object.assign(f.saveEffect, { request: f.input });
      if (boundary === "inactive-role") f.trusted.effectRequest = f.input;
      await expect(f.save()).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
    },
  );
});

describe("recruiter CSV page provenance on read", () => {
  async function importedSourceFixture() {
    const f = await nativeSourceFixture();
    const request = {
      operation: "import_csv",
      roleId: "role",
      expectedRoleRevision: 1,
      artifactId: "csv",
      mapping: { name: "Name" },
    };
    Object.assign(f.read, {
      request,
      result: {
        status: "saved",
        roleRevisionId: "revision",
        outputArtifact: { artifactId: f.artifact.id, sha256: f.artifact.hash },
      },
    });
    Object.assign(f.artifact, { clientNonce: `recruiting-csv-import:${f.read.id}` });
    f.tx.event.findMany.mockResolvedValue([] as never);
    return f;
  }
  it("lists an imported row as a source with no provider task", async () => {
    const f = await importedSourceFixture();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items).toHaveLength(1);
    expect(sources.items[0]).toMatchObject({
      providerTaskId: null,
      taskId: null,
      actionId: null,
      effectId: f.read.id,
      artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
    });
  });
  it.each(["nonce", "receipt", "role"])("rejects an imported page with a forged %s", async (b) => {
    const f = await importedSourceFixture();
    if (b === "nonce") Object.assign(f.artifact, { clientNonce: "recruiting-csv-import:other" });
    if (b === "receipt")
      Object.assign(f.read, { result: { roleRevisionId: "revision", outputArtifact: null } });
    if (b === "role") Object.assign(f.read.request as object, { roleId: "other-role" });
    await expect(
      recruiting.listRecruitingCandidateSources(f.prisma, actor, {
        roleId: "role",
        candidateKey: f.occurrence.candidateKey,
      }),
    ).rejects.toThrow(IsolationError);
  });
});
