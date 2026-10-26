import { emailAllowed, isMessagingEmail } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { generateId } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import type { AuthEnv } from "./index.js";
import { resolveSignupPolicy } from "./index.js";

export class OwnerAccountError extends Error {
  constructor(readonly reason: "closed" | "not_allowed" | "exists") {
    super(
      reason === "closed"
        ? "Registration is closed"
        : reason === "not_allowed"
          ? "Email is not allowed to register"
          : "An account with this email already exists",
    );
  }
}

/**
 * The deployment owner adds an allowlisted person directly, for deployments that cannot send a
 * verification email. The owner vouches for the address, so it counts as verified; the person
 * signs in with the starting password and gets their own Space on the first sign-in.
 */
export async function createOwnerVouchedAccount(
  prisma: PrismaClient,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
  input: { email: string; name: string; password: string },
): Promise<{ userId: string }> {
  const email = input.email.trim().toLowerCase();
  const policy = await resolveSignupPolicy(prisma, env);
  if (!policy.enabled) throw new OwnerAccountError("closed");
  if (isMessagingEmail(email) || !emailAllowed(email, policy.allowlist))
    throw new OwnerAccountError("not_allowed");
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) throw new OwnerAccountError("exists");
  const userId = generateId();
  const password = await hashPassword(input.password);
  await prisma.$transaction([
    prisma.user.create({
      data: { id: userId, email, name: input.name.trim() || email, emailVerified: true },
    }),
    prisma.account.create({
      data: { id: generateId(), accountId: userId, providerId: "credential", userId, password },
    }),
  ]);
  return { userId };
}
