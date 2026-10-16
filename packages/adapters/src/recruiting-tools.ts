import type { Actor } from "@rakazo/contracts";
import { RecruitingRoleToolInputSchema } from "@rakazo/contracts";
import type { PrismaClient, RecruitingRoleToolResult } from "@rakazo/db";
import { executeRecruitingRoleMutation, getRecruitingWorkspace, scoped } from "@rakazo/db";

export async function executeRecruitingRoleTool(
  prisma: PrismaClient,
  context: { actor: Actor; runId: string; sourceMessageId: string | null },
  untrusted: unknown,
): Promise<RecruitingRoleToolResult> {
  const input = RecruitingRoleToolInputSchema.parse(untrusted);
  const { actor, runId, sourceMessageId } = context;
  if (input.operation !== "read")
    return executeRecruitingRoleMutation(prisma, actor, { runId, sourceMessageId }, input);
  const run = scoped(
    actor,
    await prisma.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      select: {
        spaceId: true,
        userId: true,
        threadId: true,
        bot: { select: { spaceId: true, userId: true } },
      },
    }),
  );
  scoped(actor, run.bot);
  const workspace = await getRecruitingWorkspace(prisma, actor, { threadId: run.threadId });
  return { status: "current", workspace, source: null, changed: false };
}
