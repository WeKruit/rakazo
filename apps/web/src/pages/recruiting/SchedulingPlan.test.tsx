import "../../lib/query.test-support";
// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
const candidates = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: { schedulingPlans: list, saveSchedulingPlan: save, roleCandidates: candidates },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { SchedulingPlanForm, SchedulingPlanHistory } from "./SchedulingPlan";

const originalEmail = {
  threadId: "thread-1",
  roleId: "role-1",
  emailId: "mail-1",
  sourceId: "mail-source",
  sourceName: "Mailbox",
  providerMessageId: "provider-mail",
  providerThreadId: "provider-thread",
  campaignId: null,
  eaccount: "recruiter@example.test",
  savedRead: { messageId: "read-message", linkedRunId: "read-run", effectId: "read-effect" },
  sender: "candidate@example.test",
  subject: "Original interview reply",
  date: "2026-10-23T10:00:00Z",
  snippet: false,
};
const person = {
  candidateKey: "candidate-1",
  name: "Candidate Example",
  email: "candidate@example.test",
};
const slot = {
  sourceId: "calendar-source",
  sourceRevision: 2,
  eventTypeId: 42,
  availabilityEffectId: "availability-effect",
  start: "2026-11-01T05:30:00Z",
  end: "2026-11-01T06:00:00Z",
  lengthInMinutes: 30,
  observedAt: "2026-10-23T11:00:00Z",
};
const review = vi.fn();
const check = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  list.mockResolvedValue({
    plans: [],
    slots: [slot, { ...slot, start: "2026-11-01T06:30:00Z", end: "2026-11-01T07:00:00Z" }],
    partial: false,
  });
  save.mockImplementation(async (input) => ({
    ...input,
    id: "saved-plan",
    createdAt: "2026-10-23T12:00:00Z",
    roleTitle: "Engineering",
    mailSourceId: "mail-source",
    mailSourceRevision: 3,
    mailRead: originalEmail.savedRead,
    bookingEffectId: null,
    confirmationEffectId: null,
    bookingStatus: null,
    confirmationStatus: null,
  }));
  candidates.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(proof = true) {
  await act(async () =>
    root.render(
      <SchedulingPlanForm
        originalEmail={{ ...originalEmail, savedRead: proof ? originalEmail.savedRead : null }}
        roleRevision={2}
        candidate={person}
        onReview={review}
        onCheck={check}
        onClose={() => {}}
      />,
    ),
  );
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function complete() {
  await fill("Candidate time zone", "America/New_York");
  await fill("Interviewer time zone", "Europe/London");
  await fill("Requested interviewer name", "Recruiter Example");
  await fill("Requested interviewer email", "recruiter@example.test");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
}
it("reviews both explicit zones and date-specific DST offsets, saves exact proof, and hands off only on request", async () => {
  await render();
  expect(button("Review plan").disabled).toBe(true);
  await complete();
  expect(host.textContent).toContain("GMT-04:00");
  expect(host.textContent).toContain("GMT-05:00");
  expect(host.textContent).toContain("Europe/London");
  await act(async () => button("Review plan").click());
  expect(save).not.toHaveBeenCalled();
  await act(async () => button("Save plan").click());
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      originalEmail,
      roleId: "role-1",
      threadId: "thread-1",
      expectedRoleRevision: 2,
      candidate: { ...person, timeZone: "America/New_York" },
      interviewer: {
        name: "Recruiter Example",
        email: "recruiter@example.test",
        timeZone: "Europe/London",
      },
      calendar: {
        sourceId: slot.sourceId,
        sourceRevision: 2,
        eventTypeId: 42,
        availabilityEffectId: slot.availabilityEffectId,
        start: slot.start,
        end: slot.end,
        lengthInMinutes: 30,
      },
    }),
  );
  expect(review).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Booking and sending still require approval.");
  await act(async () => button("Review in role chat").click());
  expect(review).toHaveBeenCalledWith({
    plan: expect.objectContaining({ id: "saved-plan" }),
    text: expect.stringContaining("Do not book or send before approval"),
  });
  expect(review.mock.calls[0]![0].text).not.toMatch(/saved-plan|read-effect|calendar-source/);
});
it("requires both named zones and never accepts a fixed-offset guess", async () => {
  await render();
  await complete();
  await fill("Candidate time zone", "-04:00");
  expect(button("Review plan").disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
  await fill("Candidate time zone", "America/Unknown");
  expect(button("Review plan").disabled).toBe(true);
});
it("gates CRM-only original rows on a real native mail read without creating a plan", async () => {
  await render(false);
  expect(list).not.toHaveBeenCalled();
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  await act(async () => button("Read original conversation").click());
  expect(check).toHaveBeenCalledWith(expect.stringContaining("Do not send or book"));
  expect(save).not.toHaveBeenCalled();
});
it("offers an actual calendar check instead of inventing missing intervals", async () => {
  list.mockResolvedValue({ plans: [], slots: [], partial: true });
  await render();
  expect(host.textContent).toContain("No supported future interval");
  expect(host.textContent).toContain("Only part of the saved availability");
  expect(button("Review plan").disabled).toBe(true);
  await act(async () => button("Check availability in role chat").click());
  expect(check).toHaveBeenCalledWith(expect.stringContaining("Do not book or send"));
});
it("keeps failed attempts distinct from successful bookings and filters other role plans", async () => {
  const plan = {
    threadId: "thread-1",
    roleId: "role-1",
    candidate: { ...person, timeZone: "America/New_York" },
    interviewer: { name: "Recruiter", email: "recruiter@example.test", timeZone: "Europe/London" },
    calendar: slot,
    id: "plan",
    originalEmail,
    roleTitle: "Engineering",
    bookingStatus: "failed",
    confirmationStatus: null,
  };
  list.mockResolvedValue({
    plans: [plan, { ...plan, id: "other", roleId: "other-role" }],
    slots: [],
    partial: false,
  });
  await act(async () =>
    root.render(<SchedulingPlanHistory threadId="thread-1" roleId="role-1" onReview={review} />),
  );
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect(host.textContent).toContain("Failed");
  expect(host.textContent).not.toContain("Completed");
});

it.each([
  ["uncertain", null, "Check outcome", "Do not rebook or resend"],
  ["completed", null, "Review in role chat", "Do not create another booking"],
  ["pending", null, "Review in role chat", "existing pending approval"],
  ["completed", "completed", "Review in role chat", "existing booking and confirmation records"],
])(
  "keeps %s booking / %s confirmation handoff action-aware",
  async (bookingStatus, confirmationStatus, label, instruction) => {
    list.mockResolvedValue({
      plans: [
        {
          threadId: "thread-1",
          roleId: "role-1",
          id: "plan",
          originalEmail,
          roleTitle: "Engineering",
          candidate: { ...person, timeZone: "America/New_York" },
          interviewer: {
            name: "Recruiter",
            email: "recruiter@example.test",
            timeZone: "Europe/London",
          },
          calendar: slot,
          bookingStatus,
          confirmationStatus,
        },
      ],
      slots: [],
      partial: false,
    });
    await act(async () =>
      root.render(<SchedulingPlanHistory threadId="thread-1" roleId="role-1" onReview={review} />),
    );
    await act(async () => button(label!).click());
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(instruction!) }),
    );
    expect(review.mock.calls[0]![0].text).not.toContain("prepare the exact booking");
    expect(host.textContent).toContain(originalEmail.subject);
  },
);

it("does not hide incomplete history when the recent records contain no plan", async () => {
  list.mockResolvedValue({ plans: [], slots: [], partial: true });
  await act(async () => {
    root.render(<SchedulingPlanHistory threadId="thread-1" roleId="role-1" />);
  });
  expect(host.textContent).toContain("Earlier plans may be missing");
});
