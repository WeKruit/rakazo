import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";

export function formatRelativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return t`just now`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return t`${days}d ago`;
  return date.toLocaleDateString(i18n.locale || "en", { month: "short", day: "numeric" });
}

/** A future time as "in 5m" / "in 3h", or its date and time when a day or more away. */
export function formatTimeUntil(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.ceil((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 1) return t`in a minute`;
  if (minutes < 60) return t`in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t`in ${hours}h`;
  return date.toLocaleString(i18n.locale || "en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
