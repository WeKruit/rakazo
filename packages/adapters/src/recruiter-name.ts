import type { PrismaClient } from "@rakazo/db";

// Sign-up falls back to the email's local part or "User" when no name was typed.
export function signingName(user: { name: string; email: string } | null): string | undefined {
  const name = user?.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60 || /[@\d_]/.test(name)) return undefined;
  const local = user?.email.split("@")[0]?.toLowerCase();
  if (name.toLowerCase() === local || /^user$/i.test(name)) return undefined;
  return name;
}

export const recruiterNameNote = (name: string) =>
  `The recruiter's account name is ${name}: sign emails and templates with it (or their saved signature) unless they give another name; never ask which name to sign with.`;

export async function recruiterSigningNote(
  prisma: PrismaClient,
  userId: string,
): Promise<string | undefined> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  const name = signingName(user);
  return name ? recruiterNameNote(name) : undefined;
}
