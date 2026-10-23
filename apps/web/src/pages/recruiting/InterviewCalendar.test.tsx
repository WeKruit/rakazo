// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { InterviewCalendar } from "./InterviewCalendar";
import type { InterviewCalendarEvent } from "./interviewCalendar";

const now = new Date("2026-10-21T12:00:00Z");
const source = (extra: Partial<InterviewCalendarEvent> = {}): InterviewCalendarEvent => ({
  id: "interview",
  kind: "event",
  title: "Synthetic candidate discussion",
  start: "2026-10-20T09:00:00Z",
  end: "2026-10-20T10:00:00Z",
  timeZone: "America/New_York",
  status: "confirmed",
  location: "Video room",
  attendees: ["candidate@example.test"],
  url: "https://calendar.example.test/event",
  ...extra,
});
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const mount = (
  events: InterviewCalendarEvent[],
  props: Partial<Parameters<typeof InterviewCalendar>[0]> = {},
) =>
  act(async () =>
    root.render(<InterviewCalendar events={events} timeZone="UTC" now={now} {...props} />),
  );
const button = (label: string) =>
  [...element.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  )!;
const change = async (label: string, value: string) =>
  act(async () => {
    const select = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

it("renders only source events and opens their time, attendee, status and location context", async () => {
  await mount([source()]);
  const trigger = element.querySelector<HTMLButtonElement>('[data-event-id="interview"]')!;
  expect(trigger.textContent).toContain("09:00–10:00");
  await act(async () => trigger.click());
  const details = element.querySelector('aside[aria-label="Event details"]')!;
  expect(details.textContent).toContain("candidate@example.test");
  expect(details.textContent).toContain("Video room");
  expect(details.textContent).toContain("confirmed");
  expect(details.textContent).toContain("America/New_York");
  expect(details.querySelector("a")?.href).toBe("https://calendar.example.test/event");
  await act(async () => button("Close event details").click());
  expect(document.activeElement).toBe(trigger);
});
it("filters by exact source status and keeps availability visibly distinct", async () => {
  await mount([
    source(),
    source({ id: "available", kind: "availability", title: "Open slot", status: null }),
    source({ id: "cancelled", status: "cancelled" }),
  ]);
  expect(element.querySelector('[data-event-id="available"]')?.textContent).toContain(
    "Available time",
  );
  await change("Event status", "s:confirmed");
  expect(element.querySelectorAll("[data-event-id]")).toHaveLength(1);
  await change("Event status", "missing");
  expect(element.querySelectorAll("[data-event-id]")).toHaveLength(1);
  expect(element.querySelector("[data-event-id]")?.getAttribute("data-event-id")).toBe("available");
});
it("navigates weeks and Today without modifying source records", async () => {
  await mount([source()]);
  await act(async () => button("Next week").click());
  expect(element.querySelector("[data-event-id]")).toBeNull();
  expect(element.textContent).toContain("No timed events in this week.");
  await act(async () => button("Previous week").click());
  expect(element.querySelector("[data-event-id]")).not.toBeNull();
  await act(async () => button("Previous week").click());
  await act(async () => button("Today").click());
  expect(element.querySelector("[data-event-id]")).not.toBeNull();
});
it("names the actual display timezone and converts the same event when it changes", async () => {
  await mount([source()]);
  await change("Display timezone", "America/New_York");
  expect(element.querySelector('[data-event-id="interview"]')?.textContent).toContain(
    "05:00–06:00",
  );
  expect(
    element.querySelector<HTMLSelectElement>('select[aria-label="Display timezone"]')?.value,
  ).toBe("America/New_York");
});
it("provides roving keyboard day navigation for the compact view", async () => {
  await mount([source()]);
  const days = [
    ...element.querySelectorAll<HTMLButtonElement>('fieldset[aria-label="Choose day"] button'),
  ];
  expect(days[2]?.tabIndex).toBe(0);
  await act(async () =>
    days[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(days[3]?.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(days[3]);
  await act(async () =>
    days[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
  );
  expect(document.activeElement).toBe(days[0]);
  await act(async () =>
    days[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
  );
  expect(document.activeElement).toBe(days[6]);
});
it("keeps unknown duration and invalid source times visible without inventing a block length", async () => {
  await mount([
    source({ end: null }),
    source({ id: "bad", title: "Undated record", start: "invalid", end: null }),
    source({ id: "date-only", title: "Date-only record", start: "2026-10-21", end: "2026-10-22" }),
  ]);
  const marker = element.querySelector<HTMLElement>('[data-event-id="interview"]')!;
  expect(marker.style.height).toBe("");
  expect(marker.textContent).toContain("End not recorded");
  expect(element.querySelector('[data-event-id="bad"]')).toBeNull();
  expect(element.textContent).toContain("Start time unavailable");
  expect(element.textContent).toContain("Date only; time not supplied");
  await act(async () => button("Undated record").click());
  expect(element.querySelector("aside")?.textContent).toContain("invalid");
});
it("clears selected details when an asynchronous source update removes the record", async () => {
  await mount([source()]);
  await act(async () => element.querySelector<HTMLButtonElement>("[data-event-id]")!.click());
  expect(element.querySelector('aside[aria-label="Event details"]')).not.toBeNull();
  await mount([]);
  expect(element.querySelector('aside[aria-label="Event details"]')).toBeNull();
  expect(element.querySelector('aside[aria-label="Saved calendar events"]')).not.toBeNull();
});
it("keeps a source-event rail visible and restores focus after inspecting a saved event", async () => {
  await mount([
    source(),
    source({ id: "future", title: "Next week", start: "2026-10-28T10:00:00Z", end: null }),
  ]);
  const rail = element.querySelector('aside[aria-label="Saved calendar events"]')!;
  expect(rail.textContent).toContain("Synthetic candidate discussion");
  expect(rail.textContent).not.toContain("Next week");
  expect(rail.textContent).toContain("Candidate links are not included");
  await act(async () => rail.querySelector<HTMLButtonElement>("button")!.click());
  expect(element.querySelector('aside[aria-label="Event details"]')?.textContent).toContain(
    "Not recorded in this source",
  );
  await act(async () => button("Close event details").click());
  expect(document.activeElement?.getAttribute("data-saved-event-id")).toBe("interview");
});
it("shows empty-week guidance inside the calendar before its scrolling hours", async () => {
  await mount([]);
  const guidance = element.querySelector('[data-testid="calendar-empty-guidance"]')!;
  const hours = element.querySelector('[data-testid="calendar-hours"]')!;
  expect(guidance.parentElement).toBe(hours.parentElement);
  expect(guidance.compareDocumentPosition(hours) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(guidance.textContent).toContain("Empty space does not confirm availability.");
  expect(element.querySelector('aside[aria-label="Saved calendar events"]')).not.toBeNull();
});
it("places the current-time line on the actual day and minute in the selected timezone", async () => {
  await mount([source()], { now: new Date("2026-10-21T02:30:00Z") });
  let line = element.querySelector<HTMLElement>('[data-testid="calendar-current-time"]')!;
  expect(line.style.top).toBe("120px");
  expect(line.closest("section")?.getAttribute("aria-label")).toContain("Wednesday");
  await change("Display timezone", "America/New_York");
  line = element.querySelector<HTMLElement>('[data-testid="calendar-current-time"]')!;
  expect(line.style.top).toBe("1080px");
  expect(line.closest("section")?.getAttribute("aria-label")).toContain("Tuesday");
  expect(line.textContent).toContain("22:30");
  await act(async () => button("Next week").click());
  expect(element.querySelector('[data-testid="calendar-current-time"]')).toBeNull();
});
it("resets a status filter that is absent after an asynchronous source update", async () => {
  await mount([source()]);
  await change("Event status", "s:confirmed");
  await mount([source({ status: "cancelled" })]);
  expect(element.querySelector<HTMLSelectElement>('select[aria-label="Event status"]')?.value).toBe(
    "all",
  );
  expect(element.querySelectorAll("[data-event-id]")).toHaveLength(1);
});
it("advances the actual current-time line each minute when no fixture clock is supplied", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
  await mount([source()], { now: undefined });
  const line = () => element.querySelector('[data-testid="calendar-current-time"]');
  expect(line()?.textContent).toContain("08:00");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(line()?.textContent).toContain("08:01");
  expect(line()?.querySelector("time")?.dateTime).toBe("2026-10-21T08:01:00.000Z");
});
it("keeps the selected compact day visible on open, keyboard navigation and week change without scrolling ancestors", async () => {
  const pageScroll = vi.spyOn(window, "scrollTo");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute("aria-label") === "Choose day") return new DOMRect(0, 500, 340, 32);
    if (this.parentElement?.getAttribute("aria-label") === "Choose day") {
      const index = [...this.parentElement.children].indexOf(this);
      return new DOMRect(index * 100 - this.parentElement.scrollLeft, 500, 80, 32);
    }
    return new DOMRect();
  });
  await mount([source()], { now: new Date("2026-10-23T12:00:00Z") });
  const selector = element.querySelector<HTMLElement>('fieldset[aria-label="Choose day"]')!;
  expect(selector.scrollLeft).toBe(140);
  selector.scrollTop = 27;
  const days = [...selector.querySelectorAll("button")];
  const focus = vi.spyOn(days[6]!, "focus");
  await act(async () =>
    days[4]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(selector.scrollLeft).toBe(340);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  selector.scrollLeft = 0;
  await act(async () => button("Next week").click());
  expect(selector.scrollLeft).toBe(340);
  expect(selector.scrollTop).toBe(27);
  expect(pageScroll).not.toHaveBeenCalled();
});
