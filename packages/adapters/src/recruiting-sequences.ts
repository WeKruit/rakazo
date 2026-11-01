import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor, RecruitingSequenceInput, RecruitingSequenceOutput } from "@rakazo/contracts";
import { RecruitingSequenceInputSchema, RecruitingSequenceOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getRecruitingWorkspace, IsolationError } from "@rakazo/db";
import type { RecruitingThreadTarget } from "./recruiting-reads.js";

/** Web drafts share native REST authorization. This closed operation set cannot activate or send. */
export async function executeRecruitingSequence(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    signal?: AbortSignal;
    reauthorize: () => Promise<RecruitingThreadTarget>;
    stillAuthorized: () => Promise<boolean>;
  },
  actor: Actor,
  target: RecruitingThreadTarget,
  value: RecruitingSequenceInput,
): Promise<RecruitingSequenceOutput> {
  const input = RecruitingSequenceInputSchema.parse(value);
  const workspace = await getRecruitingWorkspace(deps.prisma, actor, { threadId: target.threadId });
  if (workspace?.role.id !== input.roleId) throw new IsolationError();
  const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
  const assignmentWhere = {
    userId: actor.userId,
    spaceId: actor.spaceId,
    serverId: input.serverId,
    botId: { in: botIds },
    server: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      enabled: true,
      endpoint: "https://mcp.instantly.ai/mcp",
      transport: "streamable_http" as const,
    },
  };
  const assignment = await deps.prisma.botMcpServer.findFirst({
    where: assignmentWhere,
    orderBy: { botId: "asc" },
    include: { server: true },
  });
  if (!assignment) throw new IsolationError();
  const guard = async () => {
    if (!(await deps.stillAuthorized()) || !isDeepStrictEqual(await deps.reauthorize(), target))
      throw new IsolationError();
    const current = await deps.prisma.botMcpServer.findFirst({
      where: { ...assignmentWhere, botId: assignment.botId },
      include: { server: true },
    });
    const role = await getRecruitingWorkspace(deps.prisma, actor, { threadId: target.threadId });
    if (!current || !isDeepStrictEqual(current, assignment) || role?.role.id !== input.roleId)
      throw new IsolationError();
  };
  const run =
    input.operation === "create"
      ? await deps.prisma.run.findFirst({
          where: {
            threadId: target.threadId,
            botId: assignment.botId,
            userId: actor.userId,
            spaceId: actor.spaceId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
  const context: AdapterContext = {
    reauthorize: guard,
    operationId: randomUUID(),
    traceId: randomUUID(),
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId: assignment.botId,
    ...(run ? { runId: run.id } : {}),
    signal: deps.signal ?? AbortSignal.timeout(30_000),
  };
  const call = async (
    tool: "get_role_draft" | "create_role_draft" | "update_role_draft" | "pause_campaign",
    args: Record<string, unknown>,
  ) => {
    await guard();
    let result: unknown;
    for await (const event of deps.connectors.execute(
      {
        tool: `native_instantly_${tool}`,
        route: {
          connectorId: "mcp",
          resourceId: assignment.server.id,
          resourceRevision: assignment.server.revision,
          toolName: `native_instantly_${tool}`,
        },
        executionId: randomUUID(),
        args,
      },
      context,
    )) {
      if (event.type === "error") throw new Error("Could not save this sequence");
      if (event.type === "result")
        result = (event.data as { structuredContent?: { result?: unknown } })?.structuredContent
          ?.result;
    }
    await guard();
    return result;
  };
  if (input.operation === "pause") {
    const current = RecruitingSequenceOutputSchema.parse(
      await call("get_role_draft", { role_id: input.roleId, campaign_id: input.campaignId }),
    );
    if (current.campaign?.id !== input.campaignId) throw new IsolationError();
    await call("pause_campaign", { campaign_id: input.campaignId });
  }
  const result =
    input.operation === "create" || input.operation === "save"
      ? await call(input.operation === "create" ? "create_role_draft" : "update_role_draft", {
          role_id: input.roleId,
          ...(input.operation === "save" ? { campaign_id: input.campaignId } : {}),
          ...input.draft,
        })
      : await call("get_role_draft", { role_id: input.roleId });
  return RecruitingSequenceOutputSchema.parse(result);
}
