import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const RecruitingAnalyticsInputSchema = z
  .strictObject({
    since: IsoDate,
    until: IsoDate,
    roleId: Id.optional(),
  })
  .refine((value) => Date.parse(value.since) < Date.parse(value.until), {
    message: "End must follow start",
    path: ["until"],
  });
export type RecruitingAnalyticsInput = z.infer<typeof RecruitingAnalyticsInputSchema>;

export const RecruitingAnalyticsOutputSchema = z.strictObject({
  roles: z.array(z.strictObject({ id: Id, title: z.string(), groupId: Id.nullable() })),
  trend: z.array(
    z.strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      contacted: z.number().int().nonnegative(),
      replied: z.number().int().nonnegative(),
    }),
  ),
  groups: z.array(
    z.strictObject({
      roleId: Id,
      title: z.string(),
      contacted: z.number().int().nonnegative().nullable(),
      replied: z.number().int().nonnegative().nullable(),
    }),
  ),
  observedShortlistedPeople: z.number().int().nonnegative(),
  shortlistDateUnknownPeople: z.number().int().nonnegative(),
  observedContactedPeople: z.number().int().nonnegative().nullable(),
  observedRepliedPeople: z.number().int().nonnegative().nullable(),
  firstContactedPeople: z.null(),
  replyRate: z.null(),
  coverage: z.literal("partial"),
  sources: z.strictObject({
    storedCrmMessages: z.enum(["observed", "unavailable"]),
    nativeCorrespondence: z.literal("not_included"),
    importedCorrespondence: z.literal("not_included"),
    firstSendHistory: z.literal("unknown"),
    replyClassification: z.literal("unknown"),
    identityResolution: z.literal("partial"),
    shortlistHistory: z.literal("unknown"),
  }),
});
export type RecruitingAnalyticsOutput = z.infer<typeof RecruitingAnalyticsOutputSchema>;

export const RecruitingAnalyticsPeopleInputSchema = RecruitingAnalyticsInputSchema.safeExtend({
  metric: z.enum(["contacted", "replied", "shortlisted"]),
  cursor: z.string().min(1).max(1600).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const RecruitingAnalyticsPeopleOutputSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      linkedinUrl: z.string().nullable(),
      contactedAt: IsoDate.nullable(),
      repliedAt: IsoDate.nullable(),
      shortlistedAt: IsoDate.nullable(),
      roles: z.array(z.strictObject({ id: Id, title: z.string() })),
    }),
  ),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  coverage: z.literal("partial"),
});
export type RecruitingAnalyticsPeopleInput = z.infer<typeof RecruitingAnalyticsPeopleInputSchema>;
export type RecruitingAnalyticsPeopleOutput = z.infer<typeof RecruitingAnalyticsPeopleOutputSchema>;
