import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { RecruitingHistoryImportSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** A backoffice import retains real source records, not simulated provider calls or approvals. */
export async function readRecruitingImportedCorrespondence(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string },
) {
  const current = async () => {
    const thread = await prisma.thread.findFirst({
      where: {
        id: input.threadId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        activeRecruitingRoleId: input.roleId,
        activeRecruitingRole: {
          id: input.roleId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          archivedAt: null,
        },
      },
      select: { id: true },
    });
    if (!thread) throw new IsolationError();
  };
  await current();
  const imports = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      kind: "recruiting_history_import",
      status: "completed",
      request: { path: ["roleId"], equals: input.roleId },
      run: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        trigger: "tool_background",
        status: "completed",
        initialRecruitingRoleRevision: { roleId: input.roleId },
        thread: { userId: actor.userId, spaceId: actor.spaceId },
        bot: { userId: actor.userId, spaceId: actor.spaceId },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, result: true },
  });
  const emails = new Map<string, RecruitingCorrespondence["emails"][number]>();
  const events = new Map<string, RecruitingCorrespondence["events"][number]>();
  const history = new Map<string, NonNullable<RecruitingCorrespondence["history"]>[number]>();
  const contacts = new Map<string, RecruitingCorrespondence["contacts"][number]>();
  let checkedAt: string | null = null;
  for (const entry of imports) {
    const saved = RecruitingHistoryImportSchema.parse(entry.result);
    if (saved.roleId !== input.roleId) throw new IsolationError();
    for (const email of saved.emails) {
      if (email.savedRead || email.crm)
        throw new Error("Imported mail has live provider authority");
      emails.set(email.id, { ...email, imported: true });
    }
    for (const contact of saved.contacts) contacts.set(contact.candidateKey, contact);
    for (const event of saved.events) events.set(event.id, event);
    for (const item of saved.history ?? []) history.set(item.id, item);
    if (!checkedAt || saved.importedAt > checkedAt) checkedAt = saved.importedAt;
  }
  await current();
  return imports.length
    ? {
        checkedAt,
        emails: [...emails.values()],
        events: [...events.values()],
        contacts: [...contacts.values()],
        history: [...history.values()],
      }
    : null;
}
