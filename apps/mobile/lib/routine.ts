import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { dateLocaleForUi, t } from "./i18n";

export function routineStatusLine(routine: Routine, now = new Date()): string {
  const triggers = [
    ...routine.crons.map(formatCron),
    ...(routine.webhookEnabled ? [t("Webhook")] : []),
    ...(routine.githubEnabled ? [t("Git event")] : []),
    ...(routine.messageProvider === "slack"
      ? [t("Slack message")]
      : routine.messageProvider === "teams"
        ? [t("Teams message")]
        : routine.messageProvider
          ? [t("Message event")]
          : []),
  ].join(", ");
  const next =
    routine.active && routine.nextRunAt ? nextRunLabel(new Date(routine.nextRunAt), now) : "";
  return [routine.active ? t("Active") : t("Paused"), triggers, routine.timezone, next]
    .filter(Boolean)
    .join(" · ");
}

function nextRunLabel(date: Date, now: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.ceil((date.getTime() - now.getTime()) / 60_000);
  if (minutes < 60) return t("Next in {minutes}m", { minutes: Math.max(1, minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("Next in {hours}h", { hours });
  const when = date.toLocaleString(dateLocaleForUi(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return t("Next {when}", { when });
}
