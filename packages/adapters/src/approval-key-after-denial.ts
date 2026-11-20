import type { PrismaClient } from "@rakazo/db";

/**
 * A denied card stands until the recruiter writes again. After that, the same call in the same
 * run is a new request and gets its own card: deny-then-change-and-send 11-20, the recruiter
 * cancelled a send card and gave a new subject; Kruit saved it, but the send call had the same
 * arguments, so it matched the denied card and was refused as "denied, do not retry".
 */
export async function approvalKeyAfterDenial(
  prisma: Pick<PrismaClient, "externalEffect" | "message">,
  key: string,
  latestHumanMessageId: string | null | undefined,
): Promise<string> {
  if (!latestHumanMessageId) return key;
  const denied = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: key },
    select: { status: true, updatedAt: true },
  });
  if (denied?.status !== "denied") return key;
  const message = await prisma.message.findFirst({
    where: { id: latestHumanMessageId },
    select: { createdAt: true },
  });
  return message && message.createdAt > denied.updatedAt
    ? `${key}:after:${latestHumanMessageId}`
    : key;
}
