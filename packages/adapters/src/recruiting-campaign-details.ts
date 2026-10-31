import type { RecruitingCampaignDetails } from "@rakazo/contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown) => (typeof value === "string" ? value : null);
const entries = <T>(value: unknown, project: (value: Record<string, unknown>) => T) =>
  Array.isArray(value)
    ? value.map((item) => {
        const object = record(item);
        return object ? project(object) : null;
      })
    : null;

/** Shapes already written by Instantly campaignBody; no guesses about missing provider fields. */
export function campaignObservedDetails(
  campaign: Record<string, unknown>,
): RecruitingCampaignDetails {
  return {
    schedules: entries(record(campaign.campaign_schedule)?.schedules, (schedule) => {
      const timing = record(schedule.timing);
      const days = record(schedule.days);
      return {
        name: text(schedule.name),
        from: text(timing?.from),
        to: text(timing?.to),
        timezone: text(schedule.timezone),
        days:
          days &&
          Object.entries(days).every(
            ([key, value]) => /^[0-6]$/.test(key) && typeof value === "boolean",
          )
            ? (days as Record<string, boolean>)
            : null,
      };
    }),
    sequences: entries(campaign.sequences, (sequence) => ({
      steps: entries(sequence.steps, (step) => ({
        type: text(step.type),
        delay:
          typeof step.delay === "number" && Number.isFinite(step.delay) && step.delay >= 0
            ? step.delay
            : null,
        delayUnit: text(step.delay_unit),
        variants: entries(step.variants, (variant) => ({
          subject: text(variant.subject),
          body: text(variant.body),
        })),
      })),
    })),
  };
}
