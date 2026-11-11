import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** A sender read whose result asks support to add a mailbox for this account. */
export function needsSenderNotice(result: unknown): boolean {
  try {
    return JSON.stringify(result ?? null).includes('"missingSender":true');
  } catch {
    return false;
  }
}

/**
 * Tells the deployment's support address, once per account, that an account we set up asked to
 * email candidates without a sending mailbox, so the recruiter is not the one who has to ask.
 */
export async function notifyMissingSender(
  deps: {
    prisma: Pick<PrismaClient, "deploymentSettings" | "externalEffect" | "user">;
    email?: TransactionalEmailProvider;
  },
  run: { id: string; userId: string; spaceId: string },
): Promise<boolean> {
  if (!deps.email) return false;
  try {
    const settings = await deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { supportEmail: true },
    });
    const to = settings?.supportEmail?.trim();
    if (!to) return false;
    try {
      await deps.prisma.externalEffect.create({
        data: {
          spaceId: run.spaceId,
          runId: run.id,
          kind: "sender_missing_notice",
          status: "completed",
          idempotencyKey: `sender-missing-notice:${run.userId}`,
          request: {},
          result: { to },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return false;
      throw error;
    }
    const user = await deps.prisma.user.findUnique({
      where: { id: run.userId },
      select: { email: true },
    });
    await deps.email.send({
      to,
      subject: "An account needs a sending mailbox",
      text: [
        `${user?.email ?? "An account"} asked to email candidates, but no sending mailbox is assigned to it yet.`,
        "Assign one with deployment.assignSendingMailbox (docs/deploy/README.md). Its next conversation picks it up.",
      ].join("\n\n"),
    });
    return true;
  } catch (error) {
    getLogger().error("sender missing notice", error);
    return false;
  }
}
