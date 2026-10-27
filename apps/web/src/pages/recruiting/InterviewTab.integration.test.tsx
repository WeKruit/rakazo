import "../../lib/query.test-support";
// @vitest-environment jsdom
import type { RecruitingCorrespondence } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const correspondence = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { correspondence } } }));
vi.mock("../../lib/read-retry", () => ({
  retryTransientRead: (read: () => Promise<unknown>) => read(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { InterviewTab } from "./InterviewTab";

const props = {
  roleId: "role-1",
  spaceId: "space-1",
  conversation: { groupId: "group-1" },
  crmTarget: null,
};
const saved: RecruitingCorrespondence = {
  roleId: "role-1",
  status: "ready",
  checkedAt: "2026-10-21T08:00:00Z",
  connectionChanged: false,
  connections: [],
  emails: [],
  contacts: [],
  partial: false,
  nextCursor: null,
  events: [
    {
      id: "candidate-event",
      kind: "event",
      title: "Synthetic interview",
      start: "2026-10-21T09:00:00Z",
      end: "2026-10-21T10:00:00Z",
      timeZone: "UTC",
      status: "confirmed",
      attendees: ["candidate@example.test"],
      location: "Video room",
      url: null,
    },
    {
      id: "other-event",
      kind: "event",
      title: "Other candidate",
      start: "2026-10-21T11:00:00Z",
      end: "2026-10-21T12:00:00Z",
      timeZone: "UTC",
      status: "confirmed",
      attendees: ["other@example.test"],
      location: null,
      url: null,
    },
  ],
};
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
  correspondence.mockResolvedValue(saved);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = (extra: Partial<Parameters<typeof InterviewTab>[0]> = {}) =>
  act(async () => root.render(<InterviewTab {...props} {...extra} />));

it("renders the actual calendar from the existing interview read and preserves candidate filtering", async () => {
  await render({ candidateId: "candidate", candidateEmail: "candidate@example.test" });
  expect(correspondence).toHaveBeenCalledWith({ groupId: "group-1", view: "interview" });
  expect(element.querySelector('[data-testid="interview-calendar"]')).not.toBeNull();
  expect(element.querySelector('[data-event-id="candidate-event"]')).not.toBeNull();
  expect(element.querySelector('[data-event-id="other-event"]')).toBeNull();
  expect(element.textContent).toContain("Calendar last checked");
  const calendar = element.querySelector('[data-testid="interview-calendar"]')!;
  const candidates = element.querySelector('details[aria-label="Candidate interview status"]')!;
  expect(
    calendar.compareDocumentPosition(candidates) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it.each([
  ["not_checked", "Calendar records have not been checked yet."],
  ["unsupported", "Saved calendar records are unavailable from this source."],
  ["failed", "Could not load saved calendar records. Try refreshing."],
] as const)("keeps %s distinct from an empty calendar", async (status, message) => {
  correspondence.mockResolvedValue({ ...saved, status, events: [] });
  await render();
  expect(element.textContent).toContain(message);
  expect(element.querySelector('[data-testid="interview-calendar"]')).toBeNull();
  expect(element.textContent).not.toContain("No timed events");
});

it("shows a checked empty week without claiming that free slots are available", async () => {
  correspondence.mockResolvedValue({ ...saved, status: "empty", events: [] });
  await render();
  expect(element.querySelector('[data-testid="interview-calendar"]')).not.toBeNull();
  expect(element.textContent).toContain("No timed events in this week.");
  expect(element.textContent).not.toContain("Available time");
});

it("preserves partial, changed-connection and access status with saved records", async () => {
  correspondence.mockResolvedValue({
    ...saved,
    partial: true,
    connectionChanged: true,
    connections: [
      {
        name: "Synthetic calendar",
        status: "needs_access",
        checkIssue: { status: "failed", checkedAt: saved.checkedAt },
      },
    ],
  });
  await render();
  expect(element.textContent).toContain("Some saved records could not be displayed.");
  expect(element.textContent).toContain("These saved records may be out of date.");
  expect(element.textContent).toContain("Synthetic calendar · Needs access · Failed");
  expect(element.querySelector('[data-event-id="candidate-event"]')).not.toBeNull();
});

it("shows a read failure and ignores a late response for a previous role", async () => {
  let oldResponse!: (value: RecruitingCorrespondence) => void;
  correspondence.mockReturnValueOnce(
    new Promise((resolve) => {
      oldResponse = resolve;
    }),
  );
  await render();
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  correspondence.mockRejectedValueOnce(new Error("read failed"));
  await render({ roleId: "role-2", conversation: { groupId: "group-2" } });
  await act(async () => oldResponse(saved));
  expect(element.textContent).toContain("Could not load saved calendar records. Try refreshing.");
  expect(element.querySelector('[data-event-id="candidate-event"]')).toBeNull();
});

it("shows failed and uncertain replies separately while the booked event stays confirmed", async () => {
  const operations: NonNullable<RecruitingCorrespondence["operations"]> = [
    {
      id: "failed-reply",
      kind: "reply",
      outcome: "failed",
      checkedAt: "2026-10-21T08:00:00Z",
      sourceName: "Existing mail",
      sourceId: "mail",
      providerMessageId: "original",
    },
    {
      id: "uncertain-reply",
      kind: "reply",
      outcome: "uncertain",
      checkedAt: "2026-10-21T08:01:00Z",
      sourceName: "Existing mail",
      sourceId: "mail",
      providerMessageId: "another-original",
    },
  ];
  correspondence.mockResolvedValue({ ...saved, operations });
  await render();
  const outcomes = element.querySelector('[aria-label="Reply outcomes"]');
  expect(outcomes?.textContent).toContain("Reply failed");
  expect(outcomes?.textContent).toContain("Reply outcome unknown");
  expect(outcomes?.textContent).toContain("not linked to a specific calendar event");
  expect(outcomes?.textContent).not.toMatch(/original|failed-reply|delivered/i);
  expect(element.querySelector('[data-event-id="candidate-event"]')).not.toBeNull();
  expect(saved.events[0]!.status).toBe("confirmed");
  await render({ candidateId: "candidate", candidateEmail: "candidate@example.test" });
  expect(element.querySelector('[aria-label="Reply outcomes"]')).toBeNull();
});
