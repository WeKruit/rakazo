import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { preflightCalBooking } from "./calendar-preflight.js";

function fixture() {
  const route = {
    connectorId: "mcp",
    resourceId: "cal",
    resourceRevision: 3,
    toolName: "create_booking",
  };
  const args = { eventTypeId: 42, start: "2026-11-01T05:30:00Z", lengthInMinutes: 30 };
  const tool = {
    name: "availability",
    route: { ...route, toolName: "get_availability" },
    readOnly: true,
    description: "Available intervals",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventTypeId: { type: "integer" },
        start: { type: "string" },
        end: { type: "string" },
        timeZone: { type: "string" },
        duration: { type: "integer" },
        format: { const: "range" },
      },
      required: ["eventTypeId", "start", "end", "timeZone", "duration", "format"],
    },
  };
  let data: unknown = {
    status: "success",
    data: { "2026-11-01": [{ start: args.start, end: "2026-11-01T06:00:00Z" }] },
  };
  const connector = {
    discoverTools: vi.fn(async () => [tool]),
    execute: vi.fn(async function* (_call?: { args: object }) {
      yield { type: "result" as const, data: { structuredContent: data } };
    }),
  };
  const authorize = vi.fn(async () => {});
  const check = (override = {}) =>
    preflightCalBooking({
      connector: connector as unknown as ConnectorProvider,
      context: { operationId: "approved", signal: new AbortController().signal } as AdapterContext,
      route,
      args,
      authorize,
      ...override,
    });
  return {
    route,
    args,
    tool,
    connector,
    authorize,
    check,
    setData: (value: unknown) => {
      data = value;
    },
  };
}
it("freshly checks exact event type and explicit interval without changing approved arguments", async () => {
  const f = fixture();
  const original = structuredClone(f.args);
  expect(await f.check()).toBeUndefined();
  expect(f.args).toEqual(original);
  expect(f.connector.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      args: {
        eventTypeId: 42,
        start: original.start,
        end: "2026-11-01T06:00:00.000Z",
        duration: 30,
        timeZone: "UTC",
        format: "range",
      },
    }),
    expect.anything(),
  );
  expect(f.authorize).toHaveBeenCalledTimes(5);
});
it.each([
  {},
  { status: "success", data: {} },
  {
    status: "success",
    data: { day: [{ start: "2026-11-01T06:30:00Z", end: "2026-11-01T07:00:00Z" }] },
  },
])("does not authorize a missing/conflicting slot: %j", async (data) => {
  const f = fixture();
  f.setData(data);
  expect(await f.check()).toMatchObject({ dispatched: false });
});
it.each([
  { lengthInMinutes: undefined },
  { eventTypeId: undefined },
  { start: "2026-11-01T01:30:00" },
  { instant: true },
  { routing: {} },
])("rejects unknown or unsupported approved interval %j", async (patch) => {
  const f = fixture();
  expect(await f.check({ args: { ...f.args, ...patch } })).toMatchObject({
    code: "CALENDAR_PREFLIGHT_UNAVAILABLE",
  });
  expect(f.connector.execute).not.toHaveBeenCalled();
});
it("rejects a tool schema without explicit interval fields", async () => {
  const f = fixture();
  f.tool.inputSchema = { type: "object" } as typeof f.tool.inputSchema;
  expect(await f.check()).toMatchObject({ dispatched: false });
  expect(f.connector.execute).not.toHaveBeenCalled();
});
it.each([1, 4, 5])("rejects grant or source changes at authorization check %s", async (at) => {
  const f = fixture();
  let calls = 0;
  f.authorize.mockImplementation(async () => {
    if (++calls === at) throw new Error("scope changed");
  });
  expect(await f.check()).toMatchObject({
    code: "CALENDAR_PREFLIGHT_UNAVAILABLE",
    dispatched: false,
  });
});
it("rejects same-name tool from another source", async () => {
  const f = fixture();
  f.tool.route.resourceId = "other";
  expect(await f.check()).toMatchObject({ dispatched: false });
  expect(f.connector.execute).not.toHaveBeenCalled();
});
it.each(["reschedule_booking", "cancel_booking"])(
  "does not invent approved original-event evidence for %s",
  async (toolName) => {
    const f = fixture();
    expect(await f.check({ route: { ...f.route, toolName } })).toMatchObject({ dispatched: false });
    expect(f.connector.execute).not.toHaveBeenCalled();
  },
);

it("books a fixed-length event type without a duration when a slot starts at the approved time", async () => {
  const f = fixture();
  const { lengthInMinutes: _, ...args } = f.args;
  f.tool.inputSchema.required = ["eventTypeId", "start", "end", "timeZone", "format"];
  expect(await f.check({ args })).toBeUndefined();
  expect(f.connector.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      args: {
        eventTypeId: 42,
        start: args.start,
        end: "2026-11-01T06:30:00.000Z",
        timeZone: "UTC",
        format: "range",
      },
    }),
    expect.anything(),
  );
  f.setData({
    status: "success",
    data: { "2026-11-01": [{ start: "2026-11-01T06:00:00Z", end: "2026-11-01T06:30:00Z" }] },
  });
  expect(await f.check({ args })).toMatchObject({ code: "CALENDAR_SLOT_CONFLICT" });
});

it("tells the agent to drop the length when a fixed-length event is open at that time", async () => {
  const f = fixture();
  f.tool.inputSchema.required = ["eventTypeId", "start", "end", "timeZone", "format"];
  const open = { "2026-11-01": [{ start: f.args.start, end: "2026-11-01T06:00:00Z" }] };
  f.connector.execute.mockImplementation(async function* (call: { args: object }) {
    yield {
      type: "result" as const,
      data: {
        structuredContent: { status: "success", data: "duration" in call.args ? {} : open },
      },
    };
  });
  expect(await f.check()).toMatchObject({ code: "CALENDAR_LENGTH_UNSUPPORTED" });
  f.connector.execute.mockImplementation(async function* () {
    yield { type: "result" as const, data: { structuredContent: { status: "success", data: {} } } };
  });
  expect(await f.check()).toMatchObject({ code: "CALENDAR_SLOT_CONFLICT" });
});
