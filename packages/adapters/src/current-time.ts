/**
 * Models have no clock. Without an explicit anchor they infer "now" from training data
 * or from timestamps that happen to appear in the conversation, and then reason about
 * deadlines, recency and scheduling from a stale date. Every turn states the real present
 * moment on the user message so that never has to be guessed; it stays out of the system
 * prompt so the cacheable prefix does not change every call.
 *
 * The week ahead is listed with its dates: given only "Thursday", a model mapped a candidate's
 * "Tuesday or Wednesday" to the days just gone and wrote that the times had passed (plays
 * 11-26, candidate-conversation). A weekday is then a lookup, not date arithmetic.
 */
export function formatCurrentTimeInstruction(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const weekday = (at: Date) =>
    new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(at);
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now.getTime() + (index + 1) * 86_400_000);
    return `${weekday(day)} ${day.toISOString().slice(0, 10)}`;
  });
  return [
    `Current date and time: ${weekday(now)}, ${iso} (UTC).`,
    `The next seven days: ${week.join(", ")}.`,
    "Treat this as the present moment for everything you say and do.",
    "Use it to judge what is past, upcoming, or overdue, convert it to the user's time zone when one is known, and write absolute dates rather than relative ones; a weekday someone offers without a date is the next one after the day they wrote.",
    "Never infer today's date from your training data or from timestamps quoted in the conversation.",
  ].join(" ");
}
