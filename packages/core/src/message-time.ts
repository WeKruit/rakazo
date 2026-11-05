// Keyed by the constructor too, so a replaced Intl (tests, polyfills) is honoured.
const formatsByIntl = new WeakMap<object, Map<string, Intl.DateTimeFormat>>();

/** One formatter per locale and options: building one is costly and transcripts format often. */
export function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let formats = formatsByIntl.get(Intl.DateTimeFormat);
  if (!formats) {
    formats = new Map();
    formatsByIntl.set(Intl.DateTimeFormat, formats);
  }
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/**
 * Message timestamp label: time only for today, otherwise prefixed with a short date
 * (and the year when it differs) so older messages are not mistaken for recent ones.
 */
export function formatMessageTime(
  createdAt: string | Date,
  locale: string,
  now: Date = new Date(),
): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return dateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  return dateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
