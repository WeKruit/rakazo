import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { Routine } from "@rakazo/contracts";

/** When an active scheduled routine runs next, in the reader's locale and time zone. */
export function routineNextRun(routine: Routine, now = new Date()): string | null {
  if (!routine.active || !routine.nextRunAt) return null;
  const next = new Date(routine.nextRunAt);
  if (Number.isNaN(next.getTime())) return null;
  const sameDay = next.toDateString() === now.toDateString();
  const when = next.toLocaleString(i18n.locale || "en", {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  return t`Next ${when}`;
}
