import * as z from "zod";

const identifier = z.string().trim().min(1).max(512);
export const InboxThreadIdentitySchema = z.object({
  sourceId: identifier,
  threadId: identifier,
  mailbox: identifier,
  organizationId: identifier.nullable(),
});
export type InboxThreadIdentity = z.infer<typeof InboxThreadIdentitySchema>;
const observedTime = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) <= Date.now(), "Incoming time cannot be in the future");
export const InboxThreadEvidenceSchema = InboxThreadIdentitySchema.extend({
  latestIncomingAt: observedTime.nullable(),
});
export const ListRecruitingInboxInputSchema = z.object({
  threads: z.array(InboxThreadEvidenceSchema).max(200),
});
export const MarkRecruitingInboxInputSchema = z.object({
  thread: InboxThreadIdentitySchema,
  observedIncomingAt: observedTime,
  unread: z.boolean(),
});
export type ListRecruitingInboxInput = z.infer<typeof ListRecruitingInboxInputSchema>;
export type MarkRecruitingInboxInput = z.infer<typeof MarkRecruitingInboxInputSchema>;
export const RecruitingInboxReadStateSchema = z.object({
  initializedAt: z.iso.datetime({ offset: true }),
  items: z
    .array(
      z.object({
        key: z.string(),
        lastReadAt: z.iso.datetime({ offset: true }).nullable(),
        unread: z.boolean(),
      }),
    )
    .max(200),
});
export type RecruitingInboxReadState = z.infer<typeof RecruitingInboxReadStateSchema>;

export function inboxThreadKey(thread: InboxThreadIdentity) {
  return JSON.stringify([thread.sourceId, thread.organizationId, thread.mailbox, thread.threadId]);
}

/** Missing incoming evidence remains unknown; sent mail never supplies this timestamp. */
export function inboxThreadUnread(
  latestIncomingAt: string | null,
  lastReadAt: string | null,
  initializedAt: string,
): boolean | null {
  const incoming = Date.parse(latestIncomingAt ?? "");
  const cursor = Date.parse(lastReadAt ?? initializedAt);
  return Number.isFinite(incoming) && Number.isFinite(cursor) ? incoming > cursor : null;
}
