import * as z from "zod";

const Text = z.string().trim().min(1);

const EmploymentYear = z.number().int().min(1).max(9999);
const EmploymentMonth = z.number().int().min(1).max(12);
export const RecruitingEmploymentDaySchema = z
  .strictObject({
    precision: z.literal("day"),
    year: EmploymentYear,
    month: EmploymentMonth,
    day: z.number().int().min(1).max(31),
  })
  .refine(
    (date) => {
      const calendar = new Date(0);
      calendar.setUTCFullYear(date.year, date.month - 1, date.day);
      return calendar.getUTCMonth() === date.month - 1;
    },
    { message: "Employment day must be a valid calendar date" },
  )
  .readonly();
export const RecruitingEmploymentDateSchema = z.discriminatedUnion("precision", [
  z.strictObject({ precision: z.literal("year"), year: EmploymentYear }).readonly(),
  z
    .strictObject({ precision: z.literal("month"), year: EmploymentYear, month: EmploymentMonth })
    .readonly(),
  RecruitingEmploymentDaySchema,
]);
export type RecruitingEmploymentDate = z.infer<typeof RecruitingEmploymentDateSchema>;
export type RecruitingEmploymentDay = z.infer<typeof RecruitingEmploymentDaySchema>;

export const RecruitingEmploymentRuleSchema = z
  .strictObject({
    minimumMonths: z.number().int().nonnegative(),
    countingRule: z.literal("complete_calendar_months"),
    qualificationDefinition: Text,
    cutoff: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("fixed"), date: RecruitingEmploymentDaySchema }).readonly(),
      // The server freezes the UTC calendar day at the start of assessment execution.
      z.strictObject({ kind: z.literal("assessment_date") }).readonly(),
    ]),
  })
  .readonly();
export type RecruitingEmploymentRule = z.infer<typeof RecruitingEmploymentRuleSchema>;
