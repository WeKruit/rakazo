import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorProvider,
  JobPublisher,
} from "@rakazo/adapter-kit";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { RecruitingCorrespondenceSchema } from "@rakazo/contracts";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, listRecruitingSchedulingPlans } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { saveEmailAttachments } from "./email-attachments.js";
import { readInstantlyEmail } from "./instantly-reply.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import { hasPlatformMcpCredential } from "./mcp-connector.js";

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
  endpoint: string | null;
  transport: string;
  provider: { kind: string; tools: string[] } | null;
  assignments: { botId: string; allowAllTools: boolean; allowedTools: unknown }[];
};
const allows = (permission: Source["assignments"][number], tool: string) =>
  permission.allowAllTools ||
  (Array.isArray(permission.allowedTools) && permission.allowedTools.includes(tool));
const bindingKey = (serverId: string, roleId: string) =>
  `instantly-role-campaign:${serverId}:${roleId}`;
// ponytail: an in-process cache bounds provider reads; permissions are checked before and after every use.
// The calendar is the account's, so every role of the account shares one read (and one failure)
// instead of reading the same calendar again for each role. A read older than CALENDAR_FRESH_MS is
// still served at once while a fresh one replaces it in the background, so a page never waits on
// the provider for a calendar it read in the last CALENDAR_KEEP_MS. A failure is kept only briefly.
export const CALENDAR_FRESH_MS = 30_000;
export const CALENDAR_KEEP_MS = 10 * 60_000;
type CalendarEntry = {
  fetchedAt: number;
  expires: number;
  value: Promise<unknown>;
  refreshing?: boolean;
};
const calendarCache = new Map<string, CalendarEntry>();

export async function refreshRecruitingCorrespondence(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    jobs?: JobPublisher;
    artifacts?: ArtifactStore;
    signal?: AbortSignal;
    stillAuthorized?: () => Promise<boolean>;
  },
  actor: Actor,
  scope: {
    threadId: string;
    roleId: string;
    view: "inbox" | "interview" | "contacts";
    pageEnd?: number;
    message?: RecruitingCorrespondence["emails"][number];
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
          source.assignments.some((permission) =>
            allows(permission, scope.message ? "get_email" : "list_emails"),
          ),
      ))
  )
    return;
  // Saved files open at once; a file not saved yet is saved behind the read and shows next time.
  let groupId: Promise<string | null> | undefined;
  const inboxAttachments = async (
    source: Source,
    email: NonNullable<ReturnType<typeof readInstantlyEmail>>,
  ) => {
    const botId = source.assignments.find((permission) =>
      allows(permission, scope.message ? "get_email" : "list_emails"),
    )?.botId;
    if (!deps.artifacts || !botId || !email.attachment_json?.files.length) return [];
    groupId ??= deps.prisma.thread
      .findFirst({
        where: { id: scope.threadId, userId: actor.userId, spaceId: actor.spaceId },
        select: { groupId: true },
      })
      .then((thread) => thread?.groupId ?? null);
    const owner = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      groupId: await groupId,
      sourceId: source.id,
    };
    const store = { prisma: deps.prisma, artifacts: deps.artifacts };
    const saved = await saveEmailAttachments(store, owner, email, { download: false });
    if (saved.length < email.attachment_json.files.length)
      void saveEmailAttachments(store, owner, email, { download: true }).catch(() => undefined);
    return saved;
  };
  const execute = async (
    source: Source,
    tool: string,
    args: Record<string, unknown>,
    onStart?: (startedAt: string, botId: string, operationId: string) => void,
  ) => {
    const assignedTool = tool === "native_instantly_get_email" ? "get_email" : tool;
    const permission = source.assignments.find((permission) => allows(permission, assignedTool));
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
      if (!assignment || !allows(assignment, assignedTool)) throw new IsolationError();
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
      source.id,
      source.revision,
      tool,
      args,
    ]);
    const read = async (signal: AbortSignal) => {
      const context: AdapterContext = {
        operationId: randomUUID(),
        traceId: randomUUID(),
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: permission.botId,
        signal,
      };
      let result: unknown;
      onStart?.(new Date().toISOString(), permission.botId, context.operationId);
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
      return result;
    };
    const remember = (value: Promise<unknown>, signal: AbortSignal | undefined) => {
      for (const [key, entry] of calendarCache)
        if (entry.expires <= Date.now()) calendarCache.delete(key);
      if (calendarCache.size >= 500) calendarCache.delete(calendarCache.keys().next().value!);
      const fetchedAt = Date.now();
      const entry: CalendarEntry = { fetchedAt, expires: fetchedAt + CALENDAR_KEEP_MS, value };
      value.catch(() => {
        if (calendarCache.get(cacheKey) !== entry) return;
        // A request that was closed must not hand its cancelled read to other requests.
        if (signal?.aborted) calendarCache.delete(cacheKey);
        else entry.expires = Math.min(entry.expires, fetchedAt + CALENDAR_FRESH_MS);
      });
      calendarCache.set(cacheKey, entry);
      return entry;
    };
    const cached = scope.view === "interview" ? calendarCache.get(cacheKey) : undefined;
    if (cached && cached.expires > Date.now()) {
      if (!cached.refreshing && Date.now() - cached.fetchedAt >= CALENDAR_FRESH_MS) {
        cached.refreshing = true;
        // The refresh outlives this request, so it gets its own deadline, not the page's signal.
        const next = read(AbortSignal.timeout(30_000));
        next.then(
          () => {
            if (calendarCache.get(cacheKey) === cached) remember(next, undefined);
          },
          () => {
            cached.refreshing = false;
          },
        );
      }
      const value = await cached.value;
      await fence();
      return value;
    }
    const value = read(deps.signal ?? AbortSignal.timeout(30_000));
    if (scope.view === "interview") remember(value, deps.signal);
    const result = await value;
    await fence();
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
  // Exact keys use the unique index; a prefix or suffix match reads every effect in the table.
  const campaignBindings = sources.length
    ? await deps.prisma.externalEffect.findMany({
        where: {
          spaceId: actor.spaceId,
          status: "completed",
          idempotencyKey: {
            in: sources.flatMap((source) => [
              bindingKey(source.id, scope.roleId),
              `${bindingKey(source.id, scope.roleId)}:history`,
            ]),
          },
        },
        select: { idempotencyKey: true, result: true },
      })
    : [];
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
          ? scope.message
            ? "get_email"
            : "list_emails"
          : null;
    // A source without a credential is not connected yet; reading it only fails unauthenticated.
    if (
      !tool ||
      !source.enabled ||
      (!source.secretId && !hasPlatformMcpCredential(source)) ||
      !source.assignments.some((permission) => allows(permission, tool))
    )
      continue;
    // With nobody to match, the calendar cannot hold one of this role's interviews.
    if (scope.view === "interview" && !contactEmails.size) {
      output.status = "ready";
      output.checkedAt = new Date().toISOString();
      continue;
    }
    try {
      if (scope.view === "inbox") {
        for (const binding of campaignBindings) {
          const key = bindingKey(source.id, scope.roleId);
          if (binding.idempotencyKey !== key && binding.idempotencyKey !== `${key}:history`)
            continue;
          const campaignId = record(binding.result)?.campaignId;
          if (
            typeof campaignId !== "string" ||
            (scope.message && campaignId !== scope.message.campaignId)
          )
            continue;
          let cursor: string | undefined;
          let fetched = 0;
          const seenCursors = new Set<string>();
          do {
            const read: { value?: { observedAt: string; botId: string; operationId: string } } = {};
            const body = record(
              await execute(
                source,
                scope.message ? "native_instantly_get_email" : tool,
                scope.message
                  ? { id: scope.message.providerMessageId }
                  : {
                      campaign_id: campaignId,
                      limit: 100,
                      ...(cursor ? { starting_after: cursor } : {}),
                    },
                (observedAt, botId, operationId) => {
                  read.value = { observedAt, botId, operationId };
                },
              ),
            );
            const values = scope.message ? [body] : body?.items;
            if (!Array.isArray(values)) throw new Error("Invalid mail page");
            fetched += values.length;
            const observed: RecruitingCorrespondence["emails"] = [];
            for (const value of values) {
              const email = readInstantlyEmail(value);
              if (
                !email ||
                email.campaign_id !== campaignId ||
                (scope.message &&
                  (email.id !== scope.message.providerMessageId ||
                    email.thread_id !== scope.message.providerThreadId ||
                    !email.eaccount ||
                    email.eaccount.trim().toLowerCase() !==
                      scope.message.eaccount?.trim().toLowerCase()))
              ) {
                output.partial = true;
                continue;
              }
              const text =
                email.body.text ||
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
                body: text,
                snippet:
                  !!email.body_fallback_reason ||
                  !(email.body.text || email.body.html) ||
                  (!scope.message && text.length > 50000),
                date: email.timestamp_email,
                url: null,
              });
              if (!scope.message) row.body = row.body.slice(0, 50000);
              const attachments = await inboxAttachments(source, email);
              if (attachments.length) row.attachments = attachments;
              emails.set(row.id, row);
              observed.push(row);
            }
            const checked = read.value;
            if (deps.jobs && checked && observed.length) {
              // Only this page's verified rows are durable input; publishing never holds the role read.
              for (let offset = 0; offset < observed.length; offset += 100)
                void deps.jobs
                  .enqueue({
                    name: "recruiting_inbox.project",
                    payload: {
                      observation: {
                        threadId: scope.threadId,
                        roleId: scope.roleId,
                        sourceId: source.id,
                        sourceRevision: source.revision,
                        botId: checked.botId,
                        campaignId,
                        observedAt: checked.observedAt,
                        emails: observed.slice(offset, offset + 100),
                      },
                    },
                    replaceKey: `recruiting_inbox.project:${checked.operationId}:${offset}`,
                    keepExisting: true,
                  })
                  .catch((error) =>
                    getLogger().warn("recruiting.inbox_observation_enqueue_failed", {
                      error: error instanceof Error ? error.name : "Unknown error",
                    }),
                  );
            }
            cursor =
              !scope.message && typeof body?.next_starting_after === "string"
                ? body.next_starting_after
                : undefined;
            if (cursor) {
              if (!values.length || seenCursors.has(cursor))
                throw new Error("Invalid mail continuation");
              seenCursors.add(cursor);
            }
          } while (cursor && fetched <= (scope.pageEnd ?? 200));
          output.partial ||= !!cursor;
          output.status = "ready";
        }
        // Instantly was checked: a role without a campaign has no replies, not an unknown count.
        if (output.status === "not_checked") output.status = "ready";
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
              : // Google Calendar MCP's list_events: primary calendar by default, events in `events`.
                {
                  startTime: from,
                  endTime: to,
                  pageSize: 250,
                  orderBy: "startTime",
                  ...(pageToken ? { pageToken } : {}),
                };
          const raw = await execute(source, tool, args);
          const body = record(raw);
          if (tool === "get_bookings" && body?.status !== "success")
            throw new Error("Calendar read failed");
          const rows = tool === "get_bookings" ? body?.data : (body?.events ?? []);
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
