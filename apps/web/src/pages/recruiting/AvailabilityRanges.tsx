import { useLingui } from "@lingui/react/macro";
import type { AvailabilitySlot } from "../../lib/availability-ranges";
import { mergeAvailability } from "../../lib/availability-ranges";

function zoneOption(timeZone: string | null) {
  if (!timeZone) return {};
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return { timeZone };
  } catch {
    return {};
  }
}

/** Saved availability as merged ranges per day, with each time zone named once. */
export function AvailabilityRanges({ slots }: { slots: readonly AvailabilitySlot[] }) {
  const { t } = useLingui();
  const groups = mergeAvailability(slots);
  if (!groups.length) return null;
  return (
    <section className="rounded-lg border border-border p-3 text-sm" aria-label={t`Available time`}>
      {groups.map(({ timeZone, days }) => {
        const zone = zoneOption(timeZone);
        const dayLabel = new Intl.DateTimeFormat(undefined, {
          ...zone,
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        const time = new Intl.DateTimeFormat(undefined, {
          ...zone,
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div key={timeZone ?? ""} className="space-y-1 [&+&]:mt-3">
            <strong className="block">
              {t`Available time`}
              {timeZone ? <span className="font-normal text-muted-foreground"> · {timeZone}</span> : null}
            </strong>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {days.map(({ day, ranges }) => (
                <div key={day} className="contents">
                  <dt className="text-muted-foreground">{dayLabel.format(ranges[0]!.start)}</dt>
                  <dd>
                    {ranges.map((range, index) => (
                      <span key={range.start}>
                        {index ? ", " : null}
                        <time dateTime={new Date(range.start).toISOString()}>
                          {time.format(range.start)}
                        </time>
                        {range.end > range.start ? (
                          <>
                            {"–"}
                            <time dateTime={new Date(range.end).toISOString()}>
                              {time.format(range.end)}
                            </time>
                          </>
                        ) : null}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </section>
  );
}
