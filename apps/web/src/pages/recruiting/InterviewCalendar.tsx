import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarTimeIssue, InterviewCalendarEvent } from "./interviewCalendarModel";
import {
  calendarDay,
  calendarInstant,
  calendarMinute,
  calendarWeek,
  layoutCalendarEvents,
  shiftCalendarDay,
  validCalendarZone,
} from "./interviewCalendarModel";

const MINUTE_HEIGHT = 0.8;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Saved calendar records only. Selection and navigation never create or change a booking. */
export function InterviewCalendar({
  events,
  timeZone,
  initialDate,
  contextLabel,
  now,
}: {
  events: readonly InterviewCalendarEvent[];
  /** Display timezone; defaults to the browser's named timezone, with UTC as a safe fallback. */
  timeZone?: string;
  initialDate?: Date;
  contextLabel?: string;
  now?: Date;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const [clock, setClock] = useState(() => new Date());
  const currentTime = now ?? clock;
  const localZone = validCalendarZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";
  const [zone, setZone] = useState(() =>
    timeZone ? validCalendarZone(timeZone) || "UTC" : localZone,
  );
  const [anchor, setAnchor] = useState(() => calendarDay(initialDate ?? currentTime, zone));
  const [dayIndex, setDayIndex] = useState(() => calendarWeek(anchor).indexOf(anchor));
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scroll = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const rail = useRef<HTMLElement>(null);
  const restoreEvent = useRef<string | null>(null);
  const dayButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const today = calendarDay(currentTime, zone);
  const currentMinute = calendarMinute(currentTime, zone);
  const days = calendarWeek(anchor);
  const weekKey = days[0]!;
  const selectedDay = days[dayIndex]!;
  const zones = [
    ...new Set([
      zone,
      localZone,
      "UTC",
      ...events.flatMap((event) => validCalendarZone(event.timeZone) || []),
    ]),
  ];
  const statuses = [...new Set(events.flatMap((event) => (event.status ? [event.status] : [])))];
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          status === "all" ||
          (status === "missing" ? !event.status : event.status === status.slice(2)),
      ),
    [events, status],
  );
  const layout = useMemo(
    () => layoutCalendarEvents(filtered, calendarWeek(anchor), zone),
    [filtered, anchor, zone],
  );
  const selected = filtered.find((event) => event.id === selectedId);
  const weekEvents = [
    ...new Map(layout.segments.map(({ event }) => [event.id, event])).values(),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  useEffect(() => {
    if (now) return;
    const timer = setInterval(() => setClock(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [now]);
  useEffect(() => {
    if (timeZone) setZone(validCalendarZone(timeZone) || "UTC");
  }, [timeZone]);
  useEffect(() => {
    if (
      status !== "all" &&
      !events.some((event) =>
        status === "missing" ? !event.status : event.status === status.slice(2),
      )
    ) {
      setStatus("all");
    }
  }, [events, status]);
  useEffect(() => {
    // Start near the first visible record, while keeping every hour available by scrolling.
    const visible = layout.segments.filter((row) => row.day === selectedDay);
    const first = visible.length ? Math.min(...visible.map((row) => row.startMinute)) : 8 * 60;
    if (scroll.current) scroll.current.scrollTop = Math.max(0, first - 60) * MINUTE_HEIGHT;
  }, [weekKey, selectedDay, zone]);
  useEffect(() => {
    const button = dayButtons.current[dayIndex];
    const selector = button?.parentElement;
    if (!button || !selector) return;
    const bounds = selector.getBoundingClientRect();
    const selectedBounds = button.getBoundingClientRect();
    // Scroll only this selector. scrollIntoView can also move the surrounding page or panel.
    if (selectedBounds.left < bounds.left) {
      selector.scrollLeft += selectedBounds.left - bounds.left;
    } else if (selectedBounds.right > bounds.right) {
      selector.scrollLeft += selectedBounds.right - bounds.right;
    }
  }, [dayIndex, weekKey]);
  useEffect(() => {
    if (selected || !restoreEvent.current) return;
    const target = opener.current?.isConnected
      ? opener.current
      : [
          ...(rail.current?.querySelectorAll<HTMLButtonElement>("[data-saved-event-id]") ?? []),
        ].find((button) => button.dataset.savedEventId === restoreEvent.current);
    restoreEvent.current = null;
    target?.focus({ preventScroll: true });
  }, [selected]);

  const dayLabel = (day: string, weekday: "short" | "long" = "short") =>
    new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday,
      month: "short",
      day: "numeric",
    }).format(new Date(`${day}T12:00:00Z`));
  const time = (value: string) => {
    const instant = calendarInstant(value);
    return instant
      ? new Intl.DateTimeFormat(locale, {
          timeZone: zone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(instant)
      : value;
  };
  const fullTime = (value: string) => {
    const instant = calendarInstant(value);
    return instant
      ? new Intl.DateTimeFormat(locale, {
          timeZone: zone,
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(instant)
      : value;
  };
  const title = (event: InterviewCalendarEvent) =>
    event.title || (event.kind === "availability" ? t`Available time` : t`Calendar event`);
  const issueLabel = (issue: CalendarTimeIssue) =>
    ({
      date_only: t`Date only; time not supplied`,
      invalid_start: t`Start time unavailable`,
      missing_end: t`End not recorded`,
      invalid_end: t`End time unavailable`,
      clock_change: t`Clock change; see source times`,
    })[issue];
  const moveWeek = (offset: number) => {
    setAnchor(shiftCalendarDay(weekKey, offset * 7));
    setSelectedId(null);
  };
  const moveDay = (index: number) => {
    setDayIndex(index);
    dayButtons.current[index]?.focus({ preventScroll: true });
  };

  return (
    <section
      aria-label={t`Calendar`}
      className="@container/interview min-w-0 space-y-3 rounded-xl border bg-card p-3"
      data-testid="interview-calendar"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">
            <Trans>Calendar</Trans>
          </h3>
          {contextLabel ? (
            <p className="break-words text-sm text-muted-foreground">{contextLabel}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t`Previous week`}
            onClick={() => moveWeek(-1)}
          >
            <ChevronLeft size={16} aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAnchor(today);
              setDayIndex(calendarWeek(today).indexOf(today));
              setSelectedId(null);
            }}
          >
            <Trans>Today</Trans>
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t`Next week`}
            onClick={() => moveWeek(1)}
          >
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p
          className="min-w-0 basis-full text-sm font-medium @3xl/interview:flex-1"
          aria-live="polite"
        >
          {dayLabel(days[0]!)} – {dayLabel(days[6]!)}
        </p>
        <NativeSelect
          className="max-w-full"
          size="sm"
          aria-label={t`Event status`}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setSelectedId(null);
          }}
        >
          <NativeSelectOption value="all">{t`All statuses`}</NativeSelectOption>
          {statuses.map((value) => (
            <NativeSelectOption key={value} value={`s:${value}`}>
              {value}
            </NativeSelectOption>
          ))}
          {events.some((event) => !event.status) ? (
            <NativeSelectOption value="missing">{t`Status not recorded`}</NativeSelectOption>
          ) : null}
        </NativeSelect>
        <NativeSelect
          className="max-w-full"
          size="sm"
          aria-label={t`Display timezone`}
          value={zone}
          onChange={(event) => {
            setZone(event.target.value);
            setSelectedId(null);
          }}
        >
          {zones.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <fieldset
        className="flex min-w-0 gap-1 overflow-x-auto @3xl/interview:hidden"
        aria-label={t`Choose day`}
      >
        {days.map((day, index) => (
          <Button
            key={day}
            ref={(element) => {
              dayButtons.current[index] = element;
            }}
            size="sm"
            variant={index === dayIndex ? "secondary" : "ghost"}
            aria-pressed={index === dayIndex}
            tabIndex={index === dayIndex ? 0 : -1}
            onClick={() => setDayIndex(index)}
            onKeyDown={(event) => {
              let next: number | null = null;
              if (event.key === "ArrowRight") next = (index + 1) % 7;
              if (event.key === "ArrowLeft") next = (index + 6) % 7;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = 6;
              if (next !== null) {
                event.preventDefault();
                moveDay(next);
              }
            }}
          >
            {dayLabel(day)}
          </Button>
        ))}
      </fieldset>
      <div className="grid min-w-0 gap-3 @5xl/interview:grid-cols-[minmax(0,1fr)_18.75rem]">
        <div className="min-w-0 overflow-hidden rounded-lg border">
          <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] border-b bg-card @3xl/interview:grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
            <span className="p-2 text-xs text-muted-foreground">
              {zone === "UTC" ? "UTC" : t`Time`}
            </span>
            {days.map((day, index) => (
              <h4
                key={day}
                className={`${index === dayIndex ? "block" : "hidden"} min-w-0 border-s px-1 py-2 text-center text-xs @3xl/interview:block ${day === today ? "bg-muted font-semibold" : "font-normal"}`}
              >
                <time dateTime={day}>{dayLabel(day)}</time>
              </h4>
            ))}
          </div>
          {!layout.segments.length ? (
            <div
              className="space-y-1 border-b bg-muted/40 px-4 py-5"
              data-testid="calendar-empty-guidance"
            >
              <p className="text-sm font-medium">
                <Trans>No timed events in this week.</Trans>
              </p>
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Change the week or status to review saved records. Empty space does not confirm
                  availability.
                </Trans>
              </p>
            </div>
          ) : null}
          <section
            ref={scroll}
            className={`rk-scroll ${layout.segments.length ? "max-h-[34rem]" : "max-h-64"} overflow-y-auto focus-visible:outline-2 focus-visible:outline-ring`}
            data-testid="calendar-hours"
            aria-label={t`Calendar hours`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus and scroll the calendar hours.
            tabIndex={0}
          >
            <div
              className="grid grid-cols-[3.5rem_minmax(0,1fr)] @3xl/interview:grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
              style={{ height: 1440 * MINUTE_HEIGHT }}
            >
              <div aria-hidden className="relative text-right text-xs text-muted-foreground">
                {HOURS.map((hour) => (
                  <span
                    key={hour}
                    className="absolute inset-x-0 pe-2"
                    style={{ top: hour * 60 * MINUTE_HEIGHT }}
                  >
                    {String(hour).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              {days.map((day, index) => (
                <section
                  key={day}
                  aria-label={dayLabel(day, "long")}
                  className={`${index === dayIndex ? "block" : "hidden"} relative min-w-0 border-s @3xl/interview:block`}
                >
                  {HOURS.map((hour) => (
                    <span
                      key={hour}
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 border-t border-border"
                      style={{ top: hour * 60 * MINUTE_HEIGHT }}
                    />
                  ))}
                  {day === today ? (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-20 border-t border-primary"
                      style={{ top: currentMinute * MINUTE_HEIGHT }}
                      data-testid="calendar-current-time"
                    >
                      <time
                        dateTime={currentTime.toISOString()}
                        className="absolute end-0 -translate-y-full rounded-t bg-primary px-1 text-[10px] text-primary-foreground"
                      >
                        <span className="sr-only">
                          <Trans>Current time</Trans>{" "}
                        </span>
                        {time(currentTime.toISOString())}
                      </time>
                    </div>
                  ) : null}
                  {layout.segments
                    .filter((row) => row.day === day)
                    .map((row) => (
                      <button
                        key={row.key}
                        type="button"
                        data-event-id={row.event.id}
                        className={`absolute min-h-6 overflow-hidden rounded-md border px-1 py-0.5 text-start text-xs focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-ring ${row.event.kind === "availability" ? "border-dashed bg-muted text-muted-foreground" : "border-primary/20 bg-secondary text-foreground"} ${selectedId === row.event.id ? "z-10 ring-2 ring-ring" : ""}`}
                        style={{
                          top: row.startMinute * MINUTE_HEIGHT,
                          left: `${(row.lane / row.lanes) * 100}%`,
                          width: `${100 / row.lanes}%`,
                          ...(row.endMinute !== null && row.endMinute > row.startMinute
                            ? {
                                height: Math.max(
                                  24,
                                  (row.endMinute - row.startMinute) * MINUTE_HEIGHT,
                                ),
                              }
                            : {}),
                        }}
                        aria-label={`${title(row.event)} · ${fullTime(row.event.start)}${row.event.end ? ` – ${fullTime(row.event.end)}` : ` · ${t`End not recorded`}`}`}
                        aria-pressed={selectedId === row.event.id}
                        onClick={(click) => {
                          opener.current = click.currentTarget;
                          setSelectedId(row.event.id);
                        }}
                      >
                        <span className="block truncate font-medium">
                          {row.continuesBefore ? "← " : ""}
                          {title(row.event)}
                          {row.continuesAfter ? " →" : ""}
                        </span>
                        <span className="block truncate">
                          {row.continuesBefore ? "00:00" : time(row.event.start)}
                          {row.endMinute !== null
                            ? `–${row.continuesAfter ? "24:00" : time(row.event.end!)}`
                            : ""}
                        </span>
                        {row.issue ? (
                          <span className="block truncate">{issueLabel(row.issue)}</span>
                        ) : null}
                        {row.event.kind === "availability" ? (
                          <span className="block truncate">
                            <Trans>Available time</Trans>
                          </span>
                        ) : null}
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </section>
        </div>
        {selected ? (
          <aside
            ref={rail}
            aria-label={t`Event details`}
            aria-live="polite"
            className="min-w-0 space-y-3 rounded-lg border bg-card p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <h4 className="min-w-0 break-words font-semibold">{title(selected)}</h4>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t`Close event details`}
                onClick={() => {
                  restoreEvent.current = selected.id;
                  setSelectedId(null);
                }}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1">
              <Badge variant="secondary">
                {selected.kind === "availability" ? t`Available time` : t`Calendar event`}
              </Badge>
              {selected.status ? <Badge variant="outline">{selected.status}</Badge> : null}
            </div>
            <dl className="space-y-2">
              <div>
                <dt className="text-xs text-muted-foreground">
                  <Trans>Start</Trans>
                </dt>
                <dd className="break-words">
                  <time dateTime={selected.start}>{fullTime(selected.start)}</time>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  <Trans>End</Trans>
                </dt>
                <dd className="break-words">
                  {selected.end ? (
                    <time dateTime={selected.end}>{fullTime(selected.end)}</time>
                  ) : (
                    <Trans>End not recorded</Trans>
                  )}
                </dd>
              </div>
              {selected.location ? (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    <Trans>Location</Trans>
                  </dt>
                  <dd className="break-words">{selected.location}</dd>
                </div>
              ) : null}
              {selected.attendees.length ? (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    <Trans>Attendees</Trans>
                  </dt>
                  <dd className="break-words">{selected.attendees.join(", ")}</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    <Trans>Attendees</Trans>
                  </dt>
                  <dd>
                    <Trans>Not recorded</Trans>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-foreground">
                  <Trans>Candidate link</Trans>
                </dt>
                <dd>
                  <Trans>Not recorded in this source</Trans>
                </dd>
              </div>
            </dl>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Source times</Trans>
              </summary>
              <dl className="mt-2 space-y-1 break-all">
                <div>
                  <dt>
                    <Trans>Start</Trans>
                  </dt>
                  <dd>{selected.start}</dd>
                </div>
                <div>
                  <dt>
                    <Trans>End</Trans>
                  </dt>
                  <dd>{selected.end || t`Not recorded`}</dd>
                </div>
                <div>
                  <dt>
                    <Trans>Source timezone</Trans>
                  </dt>
                  <dd>{selected.timeZone || t`Not recorded`}</dd>
                </div>
              </dl>
            </details>
            {selected.url && /^https?:\/\//i.test(selected.url) ? (
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="inline-block underline"
              >
                <Trans>Open calendar event</Trans>
              </a>
            ) : null}
          </aside>
        ) : (
          <aside
            ref={rail}
            aria-label={t`Saved calendar events`}
            className="min-w-0 rounded-lg border bg-card p-3 text-sm"
          >
            <h4 className="font-semibold">
              <Trans>Saved events</Trans>
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>
                Select an event to see its source details. Candidate links are not included in these
                calendar records.
              </Trans>
            </p>
            {weekEvents.length ? (
              <ul className="mt-3 divide-y">
                {weekEvents.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      data-saved-event-id={event.id}
                      className="w-full space-y-1 rounded-md py-3 text-start focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={(click) => {
                        opener.current = click.currentTarget;
                        setSelectedId(event.id);
                      }}
                    >
                      <span className="block break-words font-medium">{title(event)}</span>
                      <time className="block text-xs text-muted-foreground" dateTime={event.start}>
                        {fullTime(event.start)}
                      </time>
                      <span className="flex flex-wrap gap-1">
                        <Badge variant="secondary">
                          {event.kind === "availability" ? t`Available time` : t`Calendar event`}
                        </Badge>
                        {event.status ? <Badge variant="outline">{event.status}</Badge> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">
                <Trans>No saved events to show for this week and status.</Trans>
              </p>
            )}
          </aside>
        )}
      </div>
      {layout.unplaced.length ? (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            <Trans>Events without usable start times</Trans> ({layout.unplaced.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {layout.unplaced.map(({ event, issue }, index) => (
              <li key={`${index}:${event.id}`}>
                <button
                  type="button"
                  className="text-start underline"
                  onClick={(click) => {
                    opener.current = click.currentTarget;
                    setSelectedId(event.id);
                  }}
                >
                  {title(event)}
                </button>
                <p className="break-words text-xs text-muted-foreground">
                  {issueLabel(issue)} · {event.start}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
