import { createHash } from "node:crypto";
import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { z } from "zod";
import { catalogExecuteToolName, catalogIdForRoute } from "./approval-effect.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";

const Snapshot = z
  .object({
    uid: z.string().min(1),
    title: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    eventTypeId: z.number().int().positive(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    status: z.enum(["accepted", "pending"]),
    attendees: z.array(z.record(z.string(), z.unknown())).min(1),
    hosts: z.array(z.record(z.string(), z.unknown())).min(1),
    location: z.unknown().optional(),
    meetingUrl: z.unknown().optional(),
    bookingFieldsResponses: z.unknown().optional(),
    metadata: z.unknown().optional(),
    recurringEventId: z.unknown().optional(),
  })
  .refine((value) => Date.parse(value.end) > Date.parse(value.start));
export const CalendarApprovalEvidenceSchema = z.strictObject({
  kind: z.literal("cal_booking_original"),
  version: z.literal(1),
  route: z.strictObject({
    connectorId: z.literal("mcp"),
    resourceId: z.string().min(1),
    resourceRevision: z.number().int(),
    toolName: z.enum(["reschedule_booking", "cancel_booking"]),
  }),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: Snapshot,
});
/** Presentation-only catalog labels are not provider source identity. */
export const calendarApprovalRoute = (route: ConnectorRoute) => ({
  connectorId: route.connectorId,
  resourceId: route.resourceId,
  resourceRevision: route.resourceRevision,
  toolName: route.toolName,
});
export type CalendarApprovalEvidence = z.infer<typeof CalendarApprovalEvidenceSchema>;
export const calendarEvidenceHash = (value: unknown) =>
  createHash("sha256").update(stableJsonValue(value)).digest("hex");

export async function readCalBookingSnapshot(input: {
  connector: ConnectorProvider;
  context: AdapterContext;
  route: ConnectorRoute;
  bookingUid: string;
  authorize: (route: ConnectorRoute) => Promise<void>;
}) {
  if (!input.route.resourceId || typeof input.route.resourceRevision !== "number")
    throw new Error("Calendar source identity unavailable");
  const route = {
    connectorId: "mcp",
    resourceId: input.route.resourceId,
    resourceRevision: input.route.resourceRevision,
    toolName: "get_booking",
  };
  const args = { bookingUid: input.bookingUid };
  const same = (value: ConnectorRoute | undefined) =>
    value?.connectorId === route.connectorId &&
    value.resourceId === route.resourceId &&
    value.resourceRevision === route.resourceRevision &&
    value.toolName === route.toolName;
  await input.authorize(input.route);
  await input.authorize(route);
  const tools = await input.connector.discoverTools(input.context);
  const direct = tools.find((tool) => same(tool.route));
  const resolved = direct
    ? {
        tool: direct,
        call: {
          tool: direct.name,
          route,
          args,
          executionId: `${input.context.operationId}:calendar-original`,
        },
      }
    : await input.connector.resolveCall?.(
        {
          tool: catalogExecuteToolName("mcp"),
          route: { connectorId: "mcp", toolName: CATALOG_EXECUTE },
          args: { id: catalogIdForRoute(route), arguments: args },
          executionId: `${input.context.operationId}:calendar-original`,
        },
        input.context,
      );
  if (
    !resolved ||
    !same(resolved.tool.route) ||
    !same(resolved.call.route) ||
    stableJsonValue(resolved.call.args) !== stableJsonValue(args)
  )
    throw new Error("Exact booking read unavailable");
  const properties = resolved.tool.inputSchema.properties;
  if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, "bookingUid"))
    throw new Error("Exact booking read schema unavailable");
  assertConnectorToolArgs(resolved.tool.inputSchema, args);
  await input.authorize(route);
  const results: unknown[] = [];
  for await (const event of input.connector.execute(resolved.call, input.context)) {
    if (event.type === "error") throw new Error("Original booking read failed");
    if (event.type === "result") results.push(event.data);
  }
  await input.authorize(route);
  await input.authorize(input.route);
  if (results.length !== 1) throw new Error("Original booking read incomplete");
  const envelope = results[0] as Record<string, unknown> | null;
  if (envelope && (envelope.isError === true || "error" in envelope))
    throw new Error("Original booking read failed");
  const body = mcpObject(results[0]);
  if (body?.status !== "success") throw new Error("Original booking receipt unsupported");
  const snapshot = Snapshot.parse(body.data);
  if (snapshot.uid !== input.bookingUid) throw new Error("Original booking identity changed");
  return snapshot;
}
