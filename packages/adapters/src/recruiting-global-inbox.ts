import type { ConnectorProvider, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor, GlobalRecruitingInboxInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createGroupRepos,
  createRepos,
  IsolationError,
  readGlobalRecruitingInbox,
  readGlobalRecruitingInboxSummary,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  authenticated,
  getRecruitingCorrespondence,
  type RecruitingThreadTarget,
} from "./recruiting-reads.js";

export async function getGlobalRecruitingInbox(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    jobs: JobPublisher;
    signal?: AbortSignal;
    reauthorize?: () => Promise<void>;
    stillAuthorized?: () => Promise<boolean>;
  },
  actor: Actor,
  input: GlobalRecruitingInboxInput,
) {
  const authorize = async () => {
    await deps.reauthorize?.();
    if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
  };
  return authenticated(async () => {
    const page = await readGlobalRecruitingInbox(deps.prisma, actor, input, authorize);
    if (!input.thread && !input.cursor) refreshSendingRoles(deps, actor, page.roles, authorize);
    // Lists and thread pages stay stored/paginated. Only one explicitly opened preview reads its body.
    if (!input.thread?.emailId || page.items.length !== 1) return page;
    const entry = page.items[0]!;
    const message = entry.email;
    if (!message.snippet) return page;
    const role = page.roles.find((role) => role.id === entry.roleId);
    if (!role) throw new IsolationError();
    const target = () => roleTarget(deps.prisma, actor, role, authorize);
    const detail = await getRecruitingCorrespondence(
      deps.prisma,
      actor,
      await target(),
      "inbox",
      undefined,
      undefined,
      { message },
      {
        connectors: deps.connectors,
        jobs: deps.jobs,
        signal: deps.signal,
        stillAuthorized: deps.stillAuthorized,
        reauthorize: target,
      },
    );
    const full = detail.emails[0];
    if (!full || full.id !== message.id) throw new IsolationError();
    await target();
    return { ...page, items: [{ ...entry, email: { ...message, ...full } }] };
  });
}

export async function getGlobalRecruitingInboxSummary(
  deps: {
    prisma: PrismaClient;
    stillAuthorized?: () => Promise<boolean>;
    reauthorize?: () => Promise<void>;
  },
  actor: Actor,
) {
  const authorize = async () => {
    await deps.reauthorize?.();
    if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
  };
  return authenticated(() => readGlobalRecruitingInboxSummary(deps.prisma, actor, authorize));
}

type InboxRole = { id: string; threadId: string; groupId: string | null };

/** The role conversation a role's mail is read through, checked against the caller again. */
async function roleTarget(
  prisma: PrismaClient,
  actor: Actor,
  role: InboxRole,
  authorize: () => Promise<void>,
): Promise<RecruitingThreadTarget> {
  await authorize();
  const thread = await prisma.thread.findFirst({
    where: {
      id: role.threadId,
      userId: actor.userId,
      spaceId: actor.spaceId,
      activeRecruitingRoleId: role.id,
    },
    select: { botId: true },
  });
  if (!thread) throw new IsolationError();
  if (role.groupId) {
    const group = await createGroupRepos(prisma).getGroupTarget(actor, role.groupId);
    if (group.thread?.id !== role.threadId) throw new IsolationError();
    return {
      kind: "group",
      groupId: group.id,
      threadId: role.threadId,
      memberBotIds: group.members.map((member) => member.bot.id),
    };
  }
  if (!thread.botId) throw new IsolationError();
  const bot = await createRepos(prisma).getBot(actor, thread.botId);
  if (bot.thread?.id !== role.threadId) throw new IsolationError();
  return { kind: "bot", botId: bot.id, threadId: role.threadId };
}

/**
 * Roles whose mail was read live this recently are not read again when the Inbox opens. Short, so
 * looking again a minute after a send reads the mail service again (gate 63c860bb, send-at-night:
 * a second look inside two minutes showed nothing new).
 */
const REFRESH_EVERY_MS = 30_000;
const SENDING_ROLES = 5;
const refreshedAt = new Map<string, number>();

/**
 * Opening the Inbox reads the newest mail of the roles that send, behind the stored page: sent
 * mail is stored only once someone reads it (gate b2005684, send-at-night: two emails had gone
 * out, the role's inbox showed them, the account Inbox was empty). Each read stores what it sees
 * and tells the open Inbox, the same path a role's inbox already takes.
 */
function refreshSendingRoles(
  deps: Parameters<typeof getGlobalRecruitingInbox>[0],
  actor: Actor,
  roles: readonly InboxRole[],
  authorize: () => Promise<void>,
) {
  const now = Date.now();
  void Promise.resolve()
    .then(() =>
      deps.prisma.externalEffect.findMany({
        where: {
          spaceId: actor.spaceId,
          run: { userId: actor.userId, spaceId: actor.spaceId },
          kind: "instantly_role_campaign",
          status: "completed",
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { request: true },
      }),
    )
    .then(async (bindings) => {
      const sending = new Set(
        bindings.map((binding) => (binding.request as { roleId?: unknown } | null)?.roleId),
      );
      const due = roles
        .filter((role) => sending.has(role.id))
        .filter(
          (role) => now - (refreshedAt.get(`${actor.userId}:${role.id}`) ?? 0) > REFRESH_EVERY_MS,
        )
        .slice(0, SENDING_ROLES);
      for (const role of due) {
        refreshedAt.set(`${actor.userId}:${role.id}`, now);
        const target = () => roleTarget(deps.prisma, actor, role, authorize);
        await getRecruitingCorrespondence(
          deps.prisma,
          actor,
          await target(),
          "inbox",
          undefined,
          undefined,
          { limit: 50 },
          {
            connectors: deps.connectors,
            jobs: deps.jobs,
            stillAuthorized: deps.stillAuthorized,
            reauthorize: target,
          },
        ).catch((error) =>
          getLogger().warn("recruiting.inbox_refresh_failed", {
            error: error instanceof Error ? error.name : "Unknown error",
          }),
        );
      }
    })
    .catch(() => undefined);
}
