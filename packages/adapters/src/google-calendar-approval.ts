import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { catalogExecuteToolName, catalogIdForRoute } from "./approval-effect.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";

/** The recruiter's own Google Calendar event tools whose card the reads below fill in. */
export const GOOGLE_CALENDAR_EVENT_WRITES = ["create_event", "update_event", "delete_event"];

type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

/** One read on the same calendar source as the write, through the tools the bot holds. */
async function readSameCalendar(
  input: {
    connector: ConnectorProvider;
    context: AdapterContext;
    route: ConnectorRoute;
    authorize: (route: ConnectorRoute) => Promise<void>;
  },
  toolName: string,
  args: Row,
): Promise<Row> {
  if (!input.route.resourceId || typeof input.route.resourceRevision !== "number")
    throw new Error("Calendar source identity unavailable");
  const route = {
    connectorId: "mcp",
    resourceId: input.route.resourceId,
    resourceRevision: input.route.resourceRevision,
    toolName,
  };
  const same = (value: ConnectorRoute | undefined) =>
    value?.connectorId === route.connectorId &&
    value.resourceId === route.resourceId &&
    value.resourceRevision === route.resourceRevision &&
    value.toolName === route.toolName;
  await input.authorize(route);
  const executionId = `${input.context.operationId}:calendar-${toolName}`;
  const direct = (await input.connector.discoverTools(input.context)).find((tool) =>
    same(tool.route),
  );
  const resolved = direct
    ? { tool: direct, call: { tool: direct.name, route, args, executionId } }
    : await input.connector.resolveCall?.(
        {
          tool: catalogExecuteToolName("mcp"),
          route: { connectorId: "mcp", toolName: CATALOG_EXECUTE },
          args: { id: catalogIdForRoute(route), arguments: args },
          executionId,
        },
        input.context,
      );
  if (
    !resolved ||
    !same(resolved.tool.route) ||
    !same(resolved.call.route) ||
    stableJsonValue(resolved.call.args) !== stableJsonValue(args)
  )
    throw new Error("Calendar read unavailable");
  assertConnectorToolArgs(resolved.tool.inputSchema, args);
  const results: unknown[] = [];
  for await (const event of input.connector.execute(resolved.call, input.context)) {
    if (event.type === "error") throw new Error("Calendar read failed");
    if (event.type === "result") results.push(event.data);
  }
  const envelope = record(results[0]);
  const body = record(mcpObject(results[0]));
  if (results.length !== 1 || !body || envelope?.isError === true || "error" in (envelope ?? {}))
    throw new Error("Calendar read failed");
  return body;
}

const dateTime = (value: unknown) => {
  const at = record(value)?.dateTime;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : undefined;
};

/**
 * What the recruiter needs on a Google Calendar card that the request itself does not say: the
 * event a move or cancellation changes (null when it could not be read), and the recruiter's own
 * events already in the new time (null when the calendar could not be checked). A busy time is
 * shown on the card for the recruiter to decide; it never blocks the request.
 */
export async function googleCalendarApprovalFacts(input: {
  connector: ConnectorProvider;
  context: AdapterContext;
  route: ConnectorRoute;
  args: Row;
  authorize: (route: ConnectorRoute) => Promise<void>;
}): Promise<Row> {
  const { args } = input;
  const calendarId = typeof args.calendarId === "string" ? { calendarId: args.calendarId } : {};
  const facts: Row = {};
  let original: Row | undefined;
  if (input.route.toolName !== "create_event") {
    try {
      if (typeof args.eventId !== "string" || !args.eventId) throw new Error("No event id");
      const event = await readSameCalendar(input, "get_event", {
        eventId: args.eventId,
        ...calendarId,
      });
      const start = dateTime(event.start);
      if (event.id !== args.eventId || !start) throw new Error("Event read changed");
      original = event;
      facts.originalEvent = {
        summary: typeof event.summary === "string" ? event.summary : null,
        start,
        end: dateTime(event.end) ?? null,
        timeZone: record(event.start)?.timeZone ?? null,
        attendees: Array.isArray(event.attendees) ? event.attendees : [],
      };
    } catch {
      facts.originalEvent = null;
    }
  }
  if (input.route.toolName === "delete_event" || (!args.startTime && !args.endTime)) return facts;
  try {
    const startTime = args.startTime ?? dateTime(original?.start);
    const endTime = args.endTime ?? dateTime(original?.end);
    if (typeof startTime !== "string" || typeof endTime !== "string")
      throw new Error("Interval unknown");
    const page = await readSameCalendar(input, "list_events", {
      ...calendarId,
      startTime,
      endTime,
      ...(typeof args.timeZone === "string" ? { timeZone: args.timeZone } : {}),
      pageSize: 50,
    });
    if (!Array.isArray(page.events) || page.nextPageToken)
      throw new Error("Calendar page incomplete");
    facts.calendarConflicts = page.events.flatMap((value) => {
      const event = record(value);
      const start = dateTime(event?.start);
      const end = dateTime(event?.end);
      // The event being moved, a cancelled one and one marked free do not make the time busy.
      if (
        !event ||
        !start ||
        !end ||
        event.id === args.eventId ||
        event.status === "cancelled" ||
        event.availability === "AVAILABILITY_FREE" ||
        event.transparency === "transparent"
      )
        return [];
      return [{ start, end }];
    });
  } catch {
    facts.calendarConflicts = null;
  }
  return facts;
}
