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
import {
  authenticated,
  getRecruitingCorrespondence,
  type RecruitingThreadTarget,
} from "./recruiting-reads.js";

export async function getGlobalRecruitingInbox(
  deps: {
    prisma: PrismaClient;
    connectors?: Pick<ConnectorProvider, "execute">;
    jobs?: JobPublisher;
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
    // Lists and thread pages stay stored/paginated. Only one explicitly opened preview reads its body.
    if (!input.thread?.emailId || page.items.length !== 1 || !deps.connectors) return page;
    const entry = page.items[0]!;
    const message = entry.email;
    if (
      !message.snippet &&
      !/\[truncated — use get_email for full content\]\s*$/u.test(message.body)
    )
      return page;
    const role = page.roles.find((role) => role.id === entry.roleId);
    if (!role) throw new IsolationError();
    const target = async (): Promise<RecruitingThreadTarget> => {
      await authorize();
      const thread = await deps.prisma.thread.findFirst({
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
        const group = await createGroupRepos(deps.prisma).getGroupTarget(actor, role.groupId);
        if (group.thread?.id !== role.threadId) throw new IsolationError();
        return {
          kind: "group",
          groupId: group.id,
          threadId: role.threadId,
          memberBotIds: group.members.map((member) => member.bot.id),
        };
      }
      if (!thread.botId) throw new IsolationError();
      const bot = await createRepos(deps.prisma).getBot(actor, thread.botId);
      if (bot.thread?.id !== role.threadId) throw new IsolationError();
      return { kind: "bot", botId: bot.id, threadId: role.threadId };
    };
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
