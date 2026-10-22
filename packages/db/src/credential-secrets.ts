import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type CredentialSecretClient = Pick<
  PrismaClient,
  "secret" | "userModelCredential" | "userVoiceCredential"
>;

export async function deleteUnreferencedCredentialSecret(
  prisma: CredentialSecretClient,
  input: {
    credentialKind: "model" | "voice";
    credentialId: string;
    secretId: string;
  },
): Promise<void> {
  const [modelReferences, voiceReferences] = await Promise.all([
    prisma.userModelCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "model" ? { id: { not: input.credentialId } } : {}),
      },
    }),
    prisma.userVoiceCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "voice" ? { id: { not: input.credentialId } } : {}),
      },
    }),
  ]);
  if (modelReferences + voiceReferences === 0) {
    await prisma.secret.deleteMany({ where: { id: input.secretId } });
  }
}

export async function lockModelCredentialSecret(
  tx: Prisma.TransactionClient,
  input: { userId: string; provider: string; credentialId?: string; secretId: string },
) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  const [credential] = await tx.$queryRaw<Array<{ id: string; secretId: string }>>(Prisma.sql`
    SELECT id, "secretId" FROM user_model_credentials
    WHERE "userId" = ${input.userId} AND provider = ${input.provider}
      AND "secretId" = ${input.secretId}
      ${input.credentialId ? Prisma.sql`AND id = ${input.credentialId}` : Prisma.empty}
    ORDER BY id FOR UPDATE
  `);
  if (!credential) return undefined;
  const [secret] = await tx.$queryRaw<Array<{ id: string; ciphertext: string }>>(Prisma.sql`
    SELECT id, ciphertext FROM secrets WHERE id = ${credential.secretId}
      AND "userId" = ${input.userId} AND "spaceId" IS NULL AND kind = 'model' FOR UPDATE
  `);
  return secret ? { credential, secret } : undefined;
}

/** Caller already holds the credential/secret locks; do not open another transaction. */
export async function retireModelCredentialInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    credentialId: string;
    secretId?: string;
    matchesFailedSecret?: (secret: {
      id: string;
      ciphertext: string;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  const credential = await tx.userModelCredential.findFirst({
    where: { id: input.credentialId, userId: input.userId },
  });
  if (!credential || (input.secretId && credential.secretId !== input.secretId)) return false;
  if (input.matchesFailedSecret) {
    const secret = await tx.secret.findFirst({
      where: { id: credential.secretId, userId: input.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (secret && !(await input.matchesFailedSecret(secret))) return false;
  }
  await tx.spaceModelPreference.deleteMany({
    where: { userId: input.userId, credentialId: credential.id },
  });
  await tx.userModelCredential.delete({ where: { id: credential.id } });
  await deleteUnreferencedCredentialSecret(tx, {
    credentialKind: "model",
    credentialId: credential.id,
    secretId: credential.secretId,
  });
  return true;
}

/**
 * Drop a model credential whose stored OAuth material is dead, along with the
 * secret row nothing else references. The provider then reports `disconnected`
 * through the existing catalog auth machinery.
 *
 * Two guards keep a stale failure from deleting newer material:
 * - `secretId`: a reconnect swaps the credential to a fresh secret row, so a
 *   mismatch means the retired material is already gone — leave it alone.
 * - `matchesFailedSecret`: a concurrent successful refresh rewrites the SAME
 *   secret row in place, leaving `secretId` unchanged. The predicate reads a DB snapshot
 *   outside the transaction; the serializable delete rechecks its pointer and
 *   ciphertext. A mismatch means a newer credential won the race and the
 *   delete is skipped. When the secret row itself is already gone there is
 *   nothing newer to protect, so the credential is still deleted.
 */
export async function retireModelCredential(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    userId: string;
    credentialId: string;
    secretId?: string;
    matchesFailedSecret?: (secret: {
      id: string;
      ciphertext: string;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  if (!input.credentialId) return false;
  return withTransactionRetry(async () => {
    const checked = input.matchesFailedSecret
      ? await prisma.$transaction(async (tx) => {
          const credential = await tx.userModelCredential.findFirst({
            where: { id: input.credentialId, userId: input.userId },
          });
          if (!credential || (input.secretId && credential.secretId !== input.secretId))
            return undefined;
          return {
            credential,
            secret: await tx.secret.findFirst({
              where: { id: credential.secretId },
              select: { id: true, ciphertext: true },
            }),
          };
        })
      : undefined;
    if (
      input.matchesFailedSecret &&
      (!checked || (checked.secret && !(await input.matchesFailedSecret(checked.secret))))
    )
      return false;
    return prisma.$transaction(
      async (tx) => {
        const credential = await tx.userModelCredential.findFirst({
          where: { id: input.credentialId, userId: input.userId },
        });
        if (!credential || (input.secretId && credential.secretId !== input.secretId)) return false;
        if (input.matchesFailedSecret) {
          const secret = await tx.secret.findFirst({
            where: { id: credential.secretId },
            select: { id: true, ciphertext: true },
          });
          if (
            credential.secretId !== checked?.credential.secretId ||
            secret?.ciphertext !== checked?.secret?.ciphertext
          )
            return false;
        }
        return retireModelCredentialInTransaction(tx, {
          userId: input.userId,
          credentialId: input.credentialId,
          secretId: input.secretId,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
}
