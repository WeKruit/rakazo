import * as z from "zod";
import { Id } from "./ids.js";
import { RecruitingCorrespondenceSchema, RecruitingRoleCandidateSchema } from "./recruiting.js";
import { RecruitingAccountRoleSchema } from "./recruiting-account.js";

export const GlobalRecruitingInboxInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  roleId: z.string().min(1).max(512).optional(),
  sourceId: z.string().min(1).max(512).optional(),
  unreadOnly: z.boolean().optional(),
  thread: z
    .strictObject({
      roleId: z.string().min(1).max(512),
      key: z.string().min(1).max(8192),
      emailId: Id.optional(),
    })
    .optional(),
  cursor: z
    .string()
    .min(1)
    .max(3000)
    .refine((value) => {
      try {
        const parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
        return (
          typeof parsed.id === "string" &&
          parsed.id.length > 0 &&
          parsed.id.length <= 128 &&
          (parsed.at === null ||
            (typeof parsed.at === "string" && Number.isFinite(Date.parse(parsed.at))))
        );
      } catch {
        return false;
      }
    }, "Invalid mail cursor")
    .optional(),
  /** Threads to skip, to open a numbered page. Not combined with `cursor`. */
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(50).default(30),
});
export type GlobalRecruitingInboxInput = z.infer<typeof GlobalRecruitingInboxInputSchema>;
export const GlobalRecruitingInboxOutputSchema = z.strictObject({
  roles: z.array(RecruitingAccountRoleSchema),
  items: z.array(
    z.strictObject({
      key: z.string(),
      roleId: z.string(),
      latestIncomingAt: z.iso.datetime().nullable(),
      email: RecruitingCorrespondenceSchema.shape.emails.element,
      person: RecruitingRoleCandidateSchema.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  /** Threads matching the filters; null when read from a cursor. */
  total: z.number().int().nonnegative().nullable(),
  unread: z.strictObject({
    count: z.number().int().nonnegative(),
    unknownThreads: z.number().int().nonnegative(),
    scope: z.literal("indexed_stored_mail"),
  }),
  coverage: z.strictObject({
    importsComplete: z.boolean(),
    crmComplete: z.boolean(),
    native: z.literal("observed"),
    providerComplete: z.literal(false),
    checkedAt: z.iso.datetime(),
  }),
});
export type GlobalRecruitingInboxOutput = z.infer<typeof GlobalRecruitingInboxOutputSchema>;

export const GlobalRecruitingInboxSummaryOutputSchema = GlobalRecruitingInboxOutputSchema.pick({
  unread: true,
  coverage: true,
});
export type GlobalRecruitingInboxSummary = z.infer<typeof GlobalRecruitingInboxSummaryOutputSchema>;
