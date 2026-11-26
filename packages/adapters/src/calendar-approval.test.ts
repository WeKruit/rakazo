import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { calendarEvidenceHash, readCalBookingSnapshot } from "./calendar-approval.js";
import { preflightCalBooking } from "./calendar-preflight.js";
import { googleCalendarApprovalFacts } from "./google-calendar-approval.js";

function fixture(toolName = "reschedule_booking") {
  const route = { connectorId: "mcp", resourceId: "cal", resourceRevision: 3, toolName };
  const original = {
    uid: "old",
    title: "Interview",
    eventTypeId: 42,
    start: "2026-11-01T05:00:00Z",
    end: "2026-11-01T05:30:00Z",
    status: "accepted",
    attendees: [{ email: "candidate@example.test" }],
    hosts: [{ email: "host@example.test" }],
    location: "Room A",
  };
  let current = structuredClone(original);
  const args =
    toolName === "cancel_booking"
      ? { bookingUid: "old" }
      : { bookingUid: "old", start: "2026-11-01T06:30:00Z", lengthInMinutes: 30 };
  const booking = {
    name: "booking",
    description: "Read original",
    route: { ...route, toolName: "get_booking" },
    inputSchema: {
      type: "object",
      properties: { bookingUid: { type: "string" } },
      required: ["bookingUid"],
    },
  };
  const availability = {
    name: "availability",
    description: "Slots",
    route: { ...route, toolName: "get_availability" },
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        [
          "eventTypeId",
          "start",
          "end",
          "duration",
          "format",
          "timeZone",
          "bookingUidToReschedule",
        ].map((key) => [key, {}]),
      ),
    },
  };
  let slots: unknown[] = [{ start: "2026-11-01T06:30:00Z", end: "2026-11-01T07:00:00Z" }];
  const execute = vi.fn(async function* (call: { route?: { toolName: string } }) {
    yield {
      type: "result" as const,
      data: {
        structuredContent: {
          status: "success",
          data: call.route?.toolName === "get_booking" ? current : { day: slots },
        },
      },
    };
  });
  const connector = {
    discoverTools: async () => [booking, availability],
    execute,
  } as unknown as ConnectorProvider;
  const authorize = vi.fn(async () => {});
  const context = { operationId: "change", signal: new AbortController().signal } as AdapterContext;
  const evidence = {
    kind: "cal_booking_original",
    version: 1,
    route,
    requestHash: calendarEvidenceHash(args),
    snapshot: original,
  };
  return {
    original,
    evidence,
    execute,
    authorize,
    args,
    change: (patch: object) => {
      current = { ...current, ...patch };
    },
    conflict: () => {
      slots = [];
    },
    capture: () =>
      readCalBookingSnapshot({ connector, context, route, bookingUid: "old", authorize }),
    check: (override = {}) =>
      preflightCalBooking({
        connector,
        context,
        route,
        args,
        originalEvidence: evidence,
        authorize,
        ...override,
      }),
  };
}
it("captures exact original state then verifies it and the new reschedule interval", async () => {
  const f = fixture();
  expect(await f.capture()).toEqual(f.original);
  expect(await f.check()).toBeUndefined();
  expect(f.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: expect.objectContaining({ bookingUidToReschedule: "old", duration: 30 }),
    }),
    expect.anything(),
  );
});
it("cancels only the unchanged original without checking unrelated availability", async () => {
  const f = fixture("cancel_booking");
  expect(await f.check()).toBeUndefined();
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it.each([
  { title: "Changed" },
  { start: "2026-11-01T06:00:00Z" },
  { attendees: [{ email: "other@example.test" }] },
  { hosts: [{ email: "other@example.test" }] },
  { location: "Other" },
  { status: "cancelled" },
  { uid: "other" },
])("rejects changed approved original %j", async (patch) => {
  const f = fixture();
  f.change(patch);
  expect(await f.check()).toMatchObject({ dispatched: false });
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("rejects a changed slot without changing the original approved request", async () => {
  const f = fixture();
  const before = structuredClone(f.args);
  f.conflict();
  expect(await f.check()).toMatchObject({ code: "CALENDAR_SLOT_CONFLICT" });
  expect(f.args).toEqual(before);
});
it("keeps the original length when a reschedule names none", async () => {
  const f = fixture();
  expect(
    await f.check({ args: { bookingUid: "old", start: "2026-11-01T06:30:00Z" } }),
  ).toBeUndefined();
  f.conflict();
  expect(
    await f.check({ args: { bookingUid: "old", start: "2026-11-01T06:30:00Z" } }),
  ).toMatchObject({ code: "CALENDAR_SLOT_CONFLICT" });
});
it("rejects an unreadable original without creating a new approval", async () => {
  const f = fixture();
  f.execute.mockImplementation(async function* () {
    yield* [];
    throw new Error("timeout");
  });
  expect(await f.check()).toMatchObject({ dispatched: false });
});

it("preserves exact authorization identity when a catalog presentation label is present", async () => {
  const f = fixture("cancel_booking");
  expect(
    await f.check({ route: { ...f.evidence.route, catalogGroup: "Calendar" } }),
  ).toBeUndefined();
});

function googleCalendar(events: unknown[], options: { failList?: boolean } = {}) {
  const route = { connectorId: "mcp", resourceId: "gcal", resourceRevision: 2 };
  const tool = (toolName: string, properties: string[]) => ({
    name: toolName,
    description: toolName,
    route: { ...route, toolName },
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(properties.map((key) => [key, {}])),
    },
  });
  const execute = vi.fn(async function* (call: {
    route?: { toolName: string };
    args: Record<string, unknown>;
  }) {
    if (call.route?.toolName === "list_events" && options.failList) {
      yield { type: "error" as const, error: "unavailable" };
      return;
    }
    const data =
      call.route?.toolName === "get_event"
        ? (events as { id: string }[]).find((event) => event.id === call.args.eventId)
        : { events };
    yield { type: "result" as const, data: { structuredContent: data } };
  });
  return {
    route,
    connector: {
      discoverTools: async () => [
        tool("get_event", ["eventId", "calendarId"]),
        tool("list_events", ["calendarId", "startTime", "endTime", "timeZone", "pageSize"]),
      ],
      execute,
    } as unknown as ConnectorProvider,
    context: { operationId: "gcal", signal: new AbortController().signal } as AdapterContext,
  };
}

const interview = {
  id: "event-1",
  status: "confirmed",
  summary: "Interview",
  start: { dateTime: "2026-12-01T20:00:00.000Z", timeZone: "America/Chicago" },
  end: { dateTime: "2026-12-01T20:30:00.000Z", timeZone: "America/Chicago" },
  attendees: [{ email: "ethan@candidate.example.test" }],
};

it("reads what a Google Calendar move would collide with, leaving the moved event out", async () => {
  const lunch = {
    id: "lunch",
    status: "confirmed",
    start: { dateTime: "2026-12-02T20:15:00.000Z" },
    end: { dateTime: "2026-12-02T21:00:00.000Z" },
  };
  const free = { ...lunch, id: "focus", availability: "AVAILABILITY_FREE" };
  const calendar = googleCalendar([interview, lunch, free]);
  const facts = await googleCalendarApprovalFacts({
    ...calendar,
    route: { ...calendar.route, toolName: "update_event" },
    args: {
      eventId: "event-1",
      startTime: "2026-12-02T20:00:00Z",
      endTime: "2026-12-02T20:30:00Z",
    },
    authorize: async () => {},
  });
  expect(facts).toEqual({
    originalEvent: {
      summary: "Interview",
      start: "2026-12-01T20:00:00.000Z",
      end: "2026-12-01T20:30:00.000Z",
      timeZone: "America/Chicago",
      attendees: interview.attendees,
    },
    calendarConflicts: [{ start: "2026-12-02T20:15:00.000Z", end: "2026-12-02T21:00:00.000Z" }],
  });
});

it("marks a Google Calendar card unchecked when the calendar cannot be read, without blocking it", async () => {
  const calendar = googleCalendar([], { failList: true });
  const facts = await googleCalendarApprovalFacts({
    ...calendar,
    route: { ...calendar.route, toolName: "create_event" },
    args: {
      summary: "Interview",
      startTime: "2026-12-01T20:00:00Z",
      endTime: "2026-12-01T20:30:00Z",
    },
    authorize: async () => {},
  });
  expect(facts).toEqual({ calendarConflicts: null });
  const unknownEvent = await googleCalendarApprovalFacts({
    ...calendar,
    route: { ...calendar.route, toolName: "delete_event" },
    args: { eventId: "missing" },
    authorize: async () => {},
  });
  expect(unknownEvent).toEqual({ originalEvent: null });
});
