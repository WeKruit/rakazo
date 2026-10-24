import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { catalogExecuteToolName, catalogIdForRoute } from "./approval-effect.js";
import {
  CalendarApprovalEvidenceSchema,
  calendarApprovalRoute,
  readCalBookingSnapshot,
} from "./calendar-approval.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { mcpObject } from "./recruiting-research.js";

/** Only the documented explicit-duration Cal.com booking form is supported. */
export async function preflightCalBooking(input: {
  connector: ConnectorProvider;
  context: AdapterContext;
  route: ConnectorRoute;
  args: Record<string, unknown>;
  originalEvidence?: unknown;
  authorize: (route: ConnectorRoute) => Promise<void>;
}) {
  const unavailable = (reason: string) => ({
    error: `Calendar action blocked: ${reason}. No calendar change was dispatched; the approved request is preserved.`,
    code: "CALENDAR_PREFLIGHT_UNAVAILABLE",
    dispatched: false,
  });
  let original: ReturnType<typeof CalendarApprovalEvidenceSchema.parse> | undefined;
  if (input.route.toolName !== "create_booking") {
    try {
      original = CalendarApprovalEvidenceSchema.parse(input.originalEvidence);
      if (
        stableJsonValue(original.route) !== stableJsonValue(calendarApprovalRoute(input.route)) ||
        original.snapshot.uid !== input.args.bookingUid ||
        input.args.cancelSubsequentBookings === true
      )
        return unavailable(
          "the approved original booking identity or operation scope is unsupported",
        );
      const fresh = await readCalBookingSnapshot({ ...input, bookingUid: original.snapshot.uid });
      if (stableJsonValue(fresh) !== stableJsonValue(original.snapshot))
        return unavailable(
          "the original booking changed after approval; prepare a new proposal and approval",
        );
      if (input.route.toolName === "cancel_booking") return undefined;
    } catch {
      return unavailable(
        "the approved original booking evidence is missing, changed or unreadable",
      );
    }
  }
  const { start, lengthInMinutes } = input.args;
  const eventTypeId = original?.snapshot.eventTypeId ?? input.args.eventTypeId;
  if (
    !Number.isSafeInteger(eventTypeId) ||
    Number(eventTypeId) <= 0 ||
    typeof start !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(start) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isSafeInteger(lengthInMinutes) ||
    Number(lengthInMinutes) <= 0
  )
    return unavailable(
      "the approved booking needs an explicit eventTypeId, UTC start and lengthInMinutes",
    );
  // Non-standard routing/conflict overrides cannot be verified by a regular event-type slot read.
  if (
    ["instant", "routing", "allowConflicts", "allowBookingOutOfBounds", "skipBookingLimits"].some(
      (key) => input.args[key] !== undefined && input.args[key] !== false,
    )
  )
    return unavailable("this booking uses options outside the verified availability contract");
  const endMs = Date.parse(start) + Number(lengthInMinutes) * 60_000;
  if (!Number.isFinite(endMs) || Math.abs(endMs) > 8.64e15)
    return unavailable("booking interval is invalid");
  const readArgs = {
    eventTypeId,
    start,
    end: new Date(endMs).toISOString(),
    timeZone: "UTC",
    duration: lengthInMinutes,
    format: "range",
    ...(original ? { bookingUidToReschedule: original.snapshot.uid } : {}),
  };
  if (!input.route.resourceId || typeof input.route.resourceRevision !== "number")
    return unavailable("the approved calendar source identity is incomplete");
  const route = {
    ...input.route,
    resourceId: input.route.resourceId,
    resourceRevision: input.route.resourceRevision,
    toolName: "get_availability",
  };
  const same = (candidate: ConnectorRoute | undefined) =>
    candidate?.connectorId === route.connectorId &&
    candidate.resourceId === route.resourceId &&
    candidate.resourceRevision === route.resourceRevision &&
    candidate.toolName === route.toolName;
  try {
    await input.authorize(input.route);
    await input.authorize(route);
    const discovered = await input.connector.discoverTools(input.context);
    const direct = discovered.find((tool) => same(tool.route));
    const resolved = direct
      ? {
          tool: direct,
          call: {
            tool: direct.name,
            route,
            args: readArgs,
            executionId: `${input.context.operationId}:calendar-preflight`,
          },
        }
      : await input.connector.resolveCall?.(
          {
            tool: catalogExecuteToolName("mcp"),
            route: { connectorId: "mcp", toolName: CATALOG_EXECUTE },
            args: { id: catalogIdForRoute(route), arguments: readArgs },
            executionId: `${input.context.operationId}:calendar-preflight`,
          },
          input.context,
        );
    if (
      !resolved ||
      !same(resolved.tool.route) ||
      !same(resolved.call.route) ||
      stableJsonValue(resolved.call.args) !== stableJsonValue(readArgs)
    )
      return unavailable("the assigned availability tool or its exact route is unavailable");
    const properties = resolved.tool.inputSchema.properties;
    if (
      !properties ||
      typeof properties !== "object" ||
      Object.keys(readArgs).some((key) => !Object.hasOwn(properties, key))
    )
      return unavailable(
        "the availability schema does not expose the required documented interval fields",
      );
    assertConnectorToolArgs(resolved.tool.inputSchema, readArgs);
    await input.authorize(route);
    const results: unknown[] = [];
    for await (const event of input.connector.execute(resolved.call, input.context)) {
      if (event.type === "error") return unavailable("the availability read failed");
      if (event.type === "result") results.push(event.data);
    }
    await input.authorize(route);
    await input.authorize(input.route);
    if (results.length !== 1) return unavailable("the availability response is incomplete");
    const envelope = results[0] as Record<string, unknown> | null;
    if (
      envelope &&
      typeof envelope === "object" &&
      (envelope.isError === true || "error" in envelope)
    )
      return unavailable("the availability read returned an error");
    const body = mcpObject(results[0]);
    if (
      body?.status !== "success" ||
      !body.data ||
      typeof body.data !== "object" ||
      Array.isArray(body.data)
    )
      return unavailable("the availability response is unsupported");
    const days = Object.values(body.data);
    if (!days.every(Array.isArray)) return unavailable("availability coverage is malformed");
    const slots = days.flat() as unknown[];
    if (
      !slots.every(
        (slot) =>
          slot &&
          typeof slot === "object" &&
          typeof (slot as Record<string, unknown>).start === "string" &&
          typeof (slot as Record<string, unknown>).end === "string" &&
          ["start", "end"].every((key) => {
            const value = (slot as Record<string, string>)[key]!;
            return /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
          }),
      )
    )
      return unavailable("availability lacks exact interval coverage");
    const available = slots.some((slot) => {
      const value = slot as { start: string; end: string };
      return Date.parse(value.start) === Date.parse(start) && Date.parse(value.end) === endMs;
    });
    if (!available)
      return {
        ...unavailable(
          "the approved slot is no longer available; prepare a new proposal and approval",
        ),
        code: "CALENDAR_SLOT_CONFLICT",
      };
    return undefined;
  } catch {
    return unavailable("availability authorization, source or schema changed, or the read failed");
  }
}
