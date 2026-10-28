import { RecruitingSchedulingPlanSchema, SchedulingTimeZoneSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSchedulingCall,
  schedulingBookingArguments,
  schedulingPlanHash,
  schedulingPlanReview,
} from "./recruiting-scheduling.js";

function fixture() {
  const plan = RecruitingSchedulingPlanSchema.parse({
    id: "plan",
    createdAt: "2026-10-23T00:00:00Z",
    threadId: "thread",
    roleId: "role",
    roleTitle: "Engineer",
    expectedRoleRevision: 1,
    originalEmail: {
      sourceId: "crm",
      providerMessageId: "message",
      providerThreadId: "conversation",
      campaignId: "campaign",
      eaccount: "host@example.test",
      savedRead: null,
      threadId: "thread",
      roleId: "role",
      emailId: "crm-message",
      sourceName: "CRM",
      sender: "candidate@example.test",
      subject: "Interview",
      date: null,
      snippet: false,
    },
    candidate: {
      candidateKey: "candidate",
      name: "Candidate",
      email: "candidate@example.test",
      timeZone: "America/New_York",
    },
    interviewer: { name: "Host", email: "host@example.test", timeZone: "Europe/London" },
    calendar: {
      sourceId: "calendar",
      sourceRevision: 1,
      eventTypeId: 42,
      availabilityEffectId: "slots",
      start: "2026-11-01T05:30:00Z",
      end: "2026-11-01T06:00:00Z",
      lengthInMinutes: 30,
    },
    mailSourceId: "mail",
    mailSourceRevision: 1,
    mailRead: { effectId: "read", linkedRunId: "run", messageId: null },
    bookingEffectId: null,
    confirmationEffectId: null,
    bookingStatus: null,
    confirmationStatus: null,
  });
  const route = {
    connectorId: "mcp",
    resourceId: "calendar",
    resourceRevision: 1,
    toolName: "create_booking",
  };
  const args = {
    eventTypeId: 42,
    start: plan.calendar.start,
    lengthInMinutes: 30,
    attendee: {
      name: plan.candidate.name,
      email: plan.candidate.email,
      timeZone: plan.candidate.timeZone,
    },
  };
  return { plan, route, args };
}
describe("explicit scheduling plan dispatch", () => {
  it("accepts exact booking arguments and shows independently zoned DST instants", () => {
    const f = fixture();
    expect(() => assertSchedulingCall(f.plan, "book", f.route, f.args)).not.toThrow();
    const review = schedulingPlanReview(f.plan, "book");
    expect(review).toContain("Engineer");
    expect(review).toContain("GMT-04:00");
    expect(review).toContain("GMT-05:00");
    expect(review).toContain("Europe/London");
    expect(review).toContain("actual calendar host must be verified");
  });
  it.each([
    { start: "2026-11-01T06:30:00Z" },
    { lengthInMinutes: 60 },
    { guests: ["other@example.test"] },
    { attendee: { name: "Candidate", email: "other@example.test", timeZone: "America/New_York" } },
    { attendee: { name: "Candidate", email: "candidate@example.test", timeZone: "Europe/London" } },
  ])("rejects changed booking scope %j", (patch) => {
    const f = fixture();
    expect(() => assertSchedulingCall(f.plan, "book", f.route, { ...f.args, ...patch })).toThrow();
  });
  // 2026-10-28: an agent's hand-built booking arguments were rejected twice and it gave up.
  it("books the reviewed plan's own arguments when the agent passes none", () => {
    const f = fixture();
    expect(() =>
      assertSchedulingCall(f.plan, "book", f.route, schedulingBookingArguments(f.plan)),
    ).not.toThrow();
  });
  it("uses explicit native mail source while preserving CRM origin", () => {
    const { plan } = fixture();
    const route = {
      connectorId: "mcp",
      resourceId: "mail",
      resourceRevision: 1,
      toolName: "native_instantly_reply_to_email",
    };
    const args = {
      reply_to_uuid: "message",
      eaccount: "host@example.test",
      subject: "Confirmed",
      body: { text: "Exact confirmation" },
    };
    expect(() => assertSchedulingCall(plan, "confirm", route, args)).not.toThrow();
    for (const patch of [
      { reply_to_uuid: "other" },
      { eaccount: "other@example.test" },
      { cc_address_email_list: "extra@example.test" },
    ])
      expect(() => assertSchedulingCall(plan, "confirm", route, { ...args, ...patch })).toThrow();
    expect(() =>
      assertSchedulingCall(plan, "confirm", { ...route, resourceId: "crm" }, args),
    ).toThrow();
  });
  it("hashes immutable context and bridge, not changing operation status", () => {
    const { plan } = fixture();
    const hash = schedulingPlanHash(plan);
    expect(
      schedulingPlanHash({ ...plan, bookingEffectId: "effect", bookingStatus: "completed" }),
    ).toBe(hash);
    expect(schedulingPlanHash({ ...plan, mailSourceId: "different" })).not.toBe(hash);
    expect(
      schedulingPlanHash({ ...plan, interviewer: { ...plan.interviewer, timeZone: "Asia/Tokyo" } }),
    ).not.toBe(hash);
  });
  it("rejects missing or non-IANA participant zones", () => {
    for (const zone of ["", "EST", "UTC+2", "Not/AZone"])
      expect(SchedulingTimeZoneSchema.safeParse(zone).success).toBe(false);
  });
});
