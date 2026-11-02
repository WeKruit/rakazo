import { indexSavedRecruitingInbox } from "@rakazo/adapters/recruiting-reads";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, indexRecruitingInboxBatch, recruitingGlobalGroupId } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RecruitingCrmReadDeps } from "./recruiting.js";
import { syncRecruitingCrm } from "./recruiting-crm-sync.js";
import { resolveThreadTarget } from "./thread-target.js";

const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** A complete pass at most this often per person; an unfinished one resumes at the next check. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SLICES = 2_000;

type Owner = { userId: string; spaceId: string; email: string };

/**
 * People whose CRM copy is older than a day, or whose last pass stopped partway (a restart or a
 * failed read). Only owners with the product's own CRM connection are considered.
 */
export async function dueRecruitingCrmOwners(
  prisma: Pick<PrismaClient, "$queryRaw">,
  crmEndpoint: string,
  now: Date,
): Promise<Owner[]> {
  const before = new Date(now.getTime() - STALE_AFTER_MS);
  return prisma.$queryRaw<Owner[]>`
    SELECT DISTINCT s."userId", s."spaceId", u.email
    FROM mcp_servers s
    JOIN "user" u ON u.id = s."userId"
    JOIN space_members m ON m."userId" = s."userId" AND m."spaceId" = s."spaceId"
    WHERE s.endpoint = ${crmEndpoint} AND s.enabled
      AND (
        EXISTS (SELECT 1 FROM recruiting_crm_sync_progress p
          WHERE p."userId" = s."userId" AND p."spaceId" = s."spaceId")
        OR coalesce((SELECT max(c."syncedAt") FROM recruiting_crm_contacts c
          WHERE c."userId" = s."userId" AND c."spaceId" = s."spaceId"), 'epoch') < ${before}
      )`;
}

/** Runs one owner's sync to the end, picking up a pass that an earlier process left unfinished. */
export async function syncRecruitingCrmOwner(
  deps: Omit<RecruitingCrmReadDeps, "reauthorize" | "stillAuthorized">,
  owner: Owner,
): Promise<void> {
  const actor: Actor = { ...owner, isDeploymentOwner: false };
  const groupId = recruitingGlobalGroupId(actor);
  const reauthorize = () => resolveThreadTarget(deps.prisma, actor, { groupId });
  const stillAuthorized = async () =>
    Boolean(
      await deps.prisma.spaceMember.findFirst({
        where: { userId: actor.userId, spaceId: actor.spaceId },
        select: { userId: true },
      }),
    );
  const target = await reauthorize();
  const saved = await deps.prisma.recruitingCrmSyncProgress.findUnique({
    where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
    select: { token: true, targetKey: true },
  });
  let cursor =
    saved?.targetKey === JSON.stringify([target.kind, target.threadId]) ? saved.token : undefined;
  for (let slice = 0; slice < MAX_SLICES && !deps.signal?.aborted; slice++) {
    let report: Awaited<ReturnType<typeof syncRecruitingCrm>>;
    try {
      report = await syncRecruitingCrm({ ...deps, reauthorize, stillAuthorized }, actor, target, {
        cursor,
      });
    } catch (error) {
      // An expired or superseded pass starts over once; anything else waits for the next check.
      if (!cursor) throw error;
      cursor = undefined;
      continue;
    }
    if (!report.nextCursor) return;
    cursor = report.nextCursor;
  }
}

/** All active role owners, including people with only imports or retained native mail. */
export async function indexRecruitingStoredMailOwner(
  prisma: PrismaClient,
  owner: Owner,
  signal?: AbortSignal,
  crmEndpoint?: string,
) {
  const actor: Actor = { ...owner, isDeploymentOwner: false };
  const authorize = async () => {
    if (
      !(await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        select: { userId: true },
      }))
    )
      throw new IsolationError();
  };
  for (let slice = 0; slice < MAX_SLICES && !signal?.aborted; slice++) {
    const coverage = await indexRecruitingInboxBatch(prisma, actor, authorize);
    if (coverage.importsComplete && coverage.crmComplete) {
      await indexSavedRecruitingInbox(
        prisma,
        actor,
        async (threadId) => {
          const thread = await prisma.thread.findFirst({
            where: { id: threadId, userId: actor.userId, spaceId: actor.spaceId },
            select: { groupId: true, botId: true },
          });
          if (!thread || (!thread.groupId && !thread.botId)) throw new IsolationError();
          return resolveThreadTarget(
            prisma,
            actor,
            thread.groupId ? { groupId: thread.groupId } : { botId: thread.botId! },
          );
        },
        authorize,
        signal,
        crmEndpoint,
      );
      return;
    }
  }
}

/** Keeps every CRM-linked person's contacts current without anyone starting a sync by hand. */
export function startRecruitingCrmAutoSync(
  deps: Omit<RecruitingCrmReadDeps, "reauthorize" | "stillAuthorized" | "firstPartyMcpUrl"> & {
    firstPartyMcpUrl?: string;
    signal: AbortSignal;
  },
): void {
  let running = false;
  const check = async () => {
    if (running || deps.signal.aborted) return;
    running = true;
    try {
      const owners = deps.firstPartyMcpUrl
        ? await dueRecruitingCrmOwners(deps.prisma, deps.firstPartyMcpUrl, new Date())
        : [];
      for (const owner of owners) {
        if (deps.signal.aborted) break;
        await syncRecruitingCrmOwner(deps, owner).catch((error) =>
          getLogger().warn("crm.autosync.failed", { reason: String(error) }),
        );
      }
    } catch (error) {
      getLogger().warn("crm.autosync.failed", { reason: String(error) });
    }
    try {
      const owners = await deps.prisma.$queryRaw<
        Owner[]
      >`SELECT DISTINCT r."userId",r."spaceId",u.email FROM recruiting_roles r JOIN "user" u ON u.id=r."userId" JOIN space_members m ON m."userId"=r."userId" AND m."spaceId"=r."spaceId" JOIN threads t ON t.id=r."sourceThreadId" WHERE r."archivedAt" IS NULL AND t."activeRecruitingRoleId"=r.id AND t."userId"=r."userId" AND t."spaceId"=r."spaceId"`;
      for (const owner of owners) {
        if (deps.signal.aborted) break;
        await indexRecruitingStoredMailOwner(
          deps.prisma,
          owner,
          deps.signal,
          deps.firstPartyMcpUrl,
        ).catch((error) => getLogger().warn("inbox.index.failed", { reason: String(error) }));
      }
    } catch (error) {
      getLogger().warn("inbox.index.failed", { reason: String(error) });
    } finally {
      running = false;
    }
  };
  setTimeout(() => void check(), FIRST_CHECK_MS).unref();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
}
