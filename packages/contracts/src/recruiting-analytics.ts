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
