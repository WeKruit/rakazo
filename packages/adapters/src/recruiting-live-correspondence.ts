import { randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { RecruitingCorrespondenceSchema } from "@rakazo/contracts";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, listRecruitingSchedulingPlans } from "@rakazo/db";
import { readInstantlyEmail } from "./instantly-reply.js";
import { htmlToPlainText } from "./keyless-http-web.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
type Source = {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  secretId: string | null;
  provider: { kind: string; tools: string[] } | null;
  assignments: { botId: string; allowAllTools: boolean; allowedTools: unknown }[];
};
const allows = (permission: Source["assignments"][number], tool: string) =>
  permission.allowAllTools ||
  (Array.isArray(permission.allowedTools) && permission.allowedTools.includes(tool));
// ponytail: a 30-second in-process cache bounds provider reads; permissions are checked before and after every use.
const calendarCache = new Map<string, { expires: number; value: unknown }>();

export async function refreshRecruitingCorrespondence(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    signal?: AbortSignal;
    stillAuthorized?: () => Promise<boolean>;
  },
  actor: Actor,
  scope: {
    threadId: string;
    roleId: string;
    view: "inbox" | "interview" | "contacts";
    pageEnd?: number;
    contactEmails?: readonly string[];
  },
  sources: Source[],
  output: RecruitingCorrespondence,
) {
  if (
    scope.view === "contacts" ||
    (scope.view === "inbox" &&
      !sources.some(
        (source) =>
          source.enabled &&
          source.provider?.kind === "instantly" &&
          source.assignments.some((permission) => allows(permission, "list_emails")),
      ))
  )
    return;
  const execute = async (source: Source, tool: string, args: Record<string, unknown>) => {
    const permission = source.assignments.find((permission) => allows(permission, tool));
    if (!permission || !source.enabled) return undefined;
    const fence = async () => {
      if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
      const assignment = await deps.prisma.botMcpServer.findFirst({
        where: {
          botId: permission.botId,
          serverId: source.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          server: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            enabled: true,
            revision: source.revision,
          },
        },
        select: { botId: true, allowAllTools: true, allowedTools: true },
      });
      if (!assignment || !allows(assignment, tool)) throw new IsolationError();
      const thread = await deps.prisma.thread.findFirst({
        where: {
          id: scope.threadId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          activeRecruitingRoleId: scope.roleId,
        },
        select: { id: true },
      });
      if (!thread) throw new IsolationError();
    };
    await fence();
    const cacheKey = JSON.stringify([
      actor.userId,
      actor.spaceId,
      permission.botId,
      source.id,
      source.revision,
      tool,
      args,
    ]);
    const cached = scope.view === "interview" ? calendarCache.get(cacheKey) : undefined;
    if (cached && cached.expires > Date.now()) {
      await fence();
      return cached.value;
    }
    const context: AdapterContext = {
      operationId: randomUUID(),
      traceId: randomUUID(),
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: permission.botId,
      signal: deps.signal ?? AbortSignal.timeout(30_000),
    };
    let result: unknown;
    for await (const event of deps.connectors.execute(
      {
        tool,
        route: {
          connectorId: "mcp",
          resourceId: source.id,
          resourceRevision: source.revision,
          toolName: tool,
        },
        args,
        executionId: randomUUID(),
      },
      context,
    )) {
      if (event.type === "error") throw new Error("Provider read failed");
      if (event.type === "result") {
        const raw = record(event.data);
        if (raw?.isError || raw?.error) throw new Error("Provider read failed");
        const structured = record(raw?.structuredContent);
        result = structured?.result ?? mcpObject(event.data) ?? structured;
      }
    }
    if (result === undefined) throw new Error("Provider returned no records");
    await fence();
    if (scope.view === "interview") {
      for (const [key, value] of calendarCache)
        if (value.expires <= Date.now()) calendarCache.delete(key);
      if (calendarCache.size >= 500) calendarCache.delete(calendarCache.keys().next().value!);
      calendarCache.set(cacheKey, { expires: Date.now() + 30_000, value: result });
    }
    return result;
  };
  const emails = new Map(output.emails.map((email) => [email.id, email]));
  const events = new Map(output.events.map((event) => [event.id, event]));
  const contactEmails = new Set(
    [
      ...(scope.contactEmails ?? []),
      ...output.contacts.flatMap((contact) =>
        contact.emails.map((email) => email.address.toLowerCase()),
      ),
    ].map((email) => email.toLowerCase()),
  );
  const campaignBindings = await deps.prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      status: "completed",
      idempotencyKey: { endsWith: `:${scope.roleId}`, startsWith: "instantly-role-campaign:" },
    },
    select: { idempotencyKey: true, result: true },
  });
  for (const binding of campaignBindings)
    for (const value of Object.values(record(record(binding.result)?.leads) ?? {})) {
      const email = record(value)?.email;
      if (typeof email === "string") contactEmails.add(email.toLowerCase());
    }
  const plans =
    scope.view === "interview"
      ? await listRecruitingSchedulingPlans(deps.prisma, actor, { threadId: scope.threadId })
      : { plans: [], partial: false };
  const bookingIds = new Set<string>();
  const planBookingIds = new Map<string, string>();
  const proofIds = plans.plans.flatMap((plan) =>
    plan.bookingStatus === "completed" && plan.bookingEffectId ? [plan.bookingEffectId] : [],
  );
  if (proofIds.length) {
    const proofs = await deps.prisma.externalEffect.findMany({
      where: {
        id: { in: proofIds },
        spaceId: actor.spaceId,
        status: "completed",
        run: { userId: actor.userId, spaceId: actor.spaceId, threadId: scope.threadId },
      },
      select: { id: true, result: true },
    });
    for (const proof of proofs) {
      const plan = plans.plans.find((plan) => plan.bookingEffectId === proof.id);
      const body = mcpObject(proof.result);
      const uid = record(body?.data)?.uid;
      if (plan && typeof uid === "string") {
        const eventId = `${plan.calendar.sourceId}:booking:${uid}`;
        bookingIds.add(eventId);
        planBookingIds.set(`plan:${plan.id}`, eventId);
      }
    }
  }
  for (const plan of plans.plans) {
    contactEmails.add(plan.candidate.email.toLowerCase());
    const event = RecruitingCorrespondenceSchema.shape.events.element.parse({
      id: `plan:${plan.id}`,
      roleAssociation: "booking",
      kind: "event",
      title: `${plan.candidate.name} · ${plan.roleTitle}`,
      start: plan.calendar.start,
      end: plan.calendar.end,
      timeZone: plan.candidate.timeZone,
      attendees: [plan.candidate.email, plan.interviewer.email],
      status: plan.bookingStatus === "completed" ? "booked" : (plan.bookingStatus ?? "planned"),
      location: null,
      url: null,
    });
    // Plans remain visible as plans; only a proven provider booking replaces its plan row.
    events.set(event.id, event);
  }
  output.partial ||= plans.partial;
  for (const source of sources) {
    const tool =
      scope.view === "interview"
        ? source.provider?.kind === "cal"
          ? "get_bookings"
          : source.provider?.kind === "calendar"
            ? "list_events"
            : null
        : source.provider?.kind === "instantly"
          ? "list_emails"
          : null;
    if (
      !tool ||
      !source.enabled ||
      !source.assignments.some((permission) => allows(permission, tool))
    )
      continue;
    try {
      if (scope.view === "inbox") {
        for (const binding of campaignBindings) {
          if (binding.idempotencyKey !== `instantly-role-campaign:${source.id}:${scope.roleId}`)
            continue;
          const campaignId = record(binding.result)?.campaignId;
          if (typeof campaignId !== "string") continue;
          let cursor: string | undefined;
          let fetched = 0;
          const seenCursors = new Set<string>();
          do {
            const body = record(
              await execute(source, tool, {
                campaign_id: campaignId,
                limit: 100,
                ...(cursor ? { starting_after: cursor } : {}),
              }),
            );
            if (!Array.isArray(body?.items)) throw new Error("Invalid mail page");
            fetched += body.items.length;
            for (const value of body.items) {
              const email = readInstantlyEmail(value);
              if (!email || email.campaign_id !== campaignId) {
                output.partial = true;
                continue;
              }
              const text =
                email.body.text ??
                (email.body.html
                  ? htmlToPlainText(email.body.html)
                  : (email.content_preview ?? ""));
              const row = RecruitingCorrespondenceSchema.shape.emails.element.parse({
                id: `${source.id}:${email.id}`,
                sourceId: source.id,
                sourceName: source.name,
                providerMessageId: email.id,
                providerThreadId: email.thread_id ?? null,
                campaignId,
                eaccount: email.eaccount,
                savedRead: null,
                direction: email.ue_type === 2 ? "received" : email.ue_type === 1 ? "sent" : null,
                sender: email.from_address_email ?? null,
                recipients: [email.to_address_email_list],
                subject: email.subject,
                body: text.slice(0, 50000),
                snippet: !!email.body_fallback_reason,
                date: email.timestamp_email,
                url: null,
              });
              emails.set(row.id, row);
            }
            cursor =
              typeof body.next_starting_after === "string" ? body.next_starting_after : undefined;
            if (cursor) {
              if (!body.items.length || seenCursors.has(cursor))
                throw new Error("Invalid mail continuation");
              seenCursors.add(cursor);
            }
          } while (cursor && fetched <= (scope.pageEnd ?? 200));
          output.partial ||= !!cursor;
          output.status = "ready";
        }
      } else {
        const day = Math.floor(Date.now() / 86400000) * 86400000;
        const from = new Date(day - 30 * 86400000).toISOString();
        const to = new Date(day + 90 * 86400000).toISOString();
        let skip = 0;
        let pageToken: string | undefined;
        const seenTokens = new Set<string>();
        const seenEvents = new Set<string>();
        for (;;) {
          const args =
            tool === "get_bookings"
              ? { take: 100, skip }
              : {
                  calendarId: "primary",
                  timeMin: from,
                  timeMax: to,
                  maxResults: 200,
                  singleEvents: true,
                  orderBy: "startTime",
                  ...(pageToken ? { pageToken } : {}),
                };
          const raw = await execute(source, tool, args);
          const body = record(raw);
          if (tool === "get_bookings" && body?.status !== "success")
            throw new Error("Calendar read failed");
          const rows = tool === "get_bookings" ? body?.data : body?.items;
          if (!Array.isArray(rows)) throw new Error("Invalid calendar page");
          let newEvents = 0;
          for (const value of rows) {
            const row = record(value);
            const google = tool === "list_events";
            const providerId = google ? row?.id : row?.uid;
            if (!row || typeof providerId !== "string" || !providerId.trim()) {
              output.partial = true;
              continue;
            }
            const id = google ? `${source.id}:${providerId}` : `${source.id}:booking:${providerId}`;
            if (!seenEvents.has(id)) newEvents += 1;
            seenEvents.add(id);
            const attendees = Array.isArray(row.attendees)
              ? row.attendees.flatMap((value) =>
                  typeof record(value)?.email === "string" ? [record(value)!.email as string] : [],
                )
              : [];
            if (!attendees.some((email) => contactEmails.has(email.toLowerCase()))) continue;
            const start = google ? record(row.start)?.dateTime : row.start;
            const end = google ? record(row.end)?.dateTime : row.end;
            const event = RecruitingCorrespondenceSchema.shape.events.element.safeParse({
              id,
              roleAssociation: !google && bookingIds.has(id) ? "booking" : "contact",
              kind: "event",
              title: google ? (row.summary ?? null) : (row.title ?? null),
              start,
              end: end ?? null,
              timeZone: google ? (record(row.start)?.timeZone ?? null) : null,
              attendees,
              status: row.status ?? null,
              location: typeof row.location === "string" ? row.location : null,
              url: google ? (row.htmlLink ?? null) : null,
            });
            if (event.success) events.set(event.data.id, event.data);
            else output.partial = true;
          }
          if (tool === "get_bookings") {
            const more = record(body?.pagination)?.hasNextPage;
            if (more !== true) {
              output.partial ||= more !== false;
              break;
            }
            if (!rows.length || !newEvents) throw new Error("Invalid calendar continuation");
            skip += rows.length;
          } else {
            const next = body?.nextPageToken;
            if (next === undefined || next === null) break;
            if (typeof next !== "string" || !next || seenTokens.has(next))
              throw new Error("Invalid calendar continuation");
            seenTokens.add(next);
            pageToken = next;
          }
        }
        output.status = "ready";
      }
      output.checkedAt = new Date().toISOString();
    } catch (error) {
      if (error instanceof IsolationError) throw error;
      output.partial = true;
      const connection = output.connections.find((connection) => connection.name === source.name);
      if (connection)
        connection.checkIssue = { status: "failed", checkedAt: new Date().toISOString() };
      output.status = "failed";
    }
  }
  output.emails = [...emails.values()].sort(
    (a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.id.localeCompare(a.id),
  );
  for (const [planId, bookingId] of planBookingIds)
    if (events.has(bookingId)) events.delete(planId);
  output.events = [...events.values()].sort(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  );
  if (output.events.length || output.emails.length) output.status = "ready";
  else if (output.status === "ready") output.status = "empty";
}
