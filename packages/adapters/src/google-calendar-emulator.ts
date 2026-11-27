import { createHash, randomUUID } from "node:crypto";

/**
 * A stateful stand-in for the recruiter's own Google Calendar, at the boundary the product talks
 * to: the remote calendar MCP server (https://calendarmcp.googleapis.com/mcp/v1, tools as in
 * Google's MCP reference) and the OAuth sign-in in front of it. A test backend connects a play's
 * calendar the way a recruiter does (discovery, client registration, consent, code exchange); each
 * consent is its own calendar, so one account never reads another's events. Nothing leaves the
 * process.
 */
type Row = Record<string, unknown>;
type DateTime = { dateTime: string; timeZone: string };
type Attendee = {
  email: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  responseStatus: string;
};
export type EmulatedCalendarEvent = {
  id: string;
  status: "confirmed" | "cancelled";
  summary: string;
  description?: string;
  location?: string;
  start: DateTime;
  end: DateTime;
  attendees: Attendee[];
  organizer: { email: string; self: true };
  htmlLink: string;
  created: string;
  updated: string;
};
type Calendar = { owner: string; events: Map<string, EmulatedCalendarEvent> };

const MCP_HOST = "calendarmcp.googleapis.com";
const AUTH_HOST = "accounts.google.com";
const TOKEN_HOST = "oauth2.googleapis.com";
const RESOURCE = `https://${MCP_HOST}/mcp/v1`;
const METADATA = `https://${MCP_HOST}/.well-known/oauth-protected-resource/mcp/v1`;

const string = { type: "string" };
const attendee = {
  type: "object",
  properties: { email: string, displayName: string, optionalAttendee: { type: "boolean" } },
  required: ["email"],
};
const NOTIFICATION = {
  type: "string",
  enum: ["NOTIFICATION_LEVEL_UNSPECIFIED", "NONE", "EXTERNAL_ONLY", "ALL"],
};
const TOOLS = [
  {
    name: "list_calendars",
    description: "Lists the calendars of the signed-in user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_events",
    description: "Lists events on a calendar between startTime and endTime.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: string,
        startTime: string,
        endTime: string,
        timeZone: string,
        pageSize: { type: "integer" },
        pageToken: string,
        orderBy: string,
        fullText: string,
      },
    },
  },
  {
    name: "get_event",
    description: "Gets one event by id.",
    inputSchema: {
      type: "object",
      properties: { calendarId: string, eventId: string },
      required: ["eventId"],
    },
  },
  {
    name: "search_events",
    description: "Searches events by text.",
    inputSchema: {
      type: "object",
      properties: { calendarId: string, fullText: string, startTime: string, endTime: string },
    },
  },
  {
    name: "suggest_time",
    description: "Suggests free time periods across one or more calendars.",
    inputSchema: {
      type: "object",
      properties: {
        attendeeEmails: { type: "array", items: string },
        startTime: string,
        endTime: string,
        timeZone: string,
        durationMinutes: { type: "integer" },
        preferences: {
          type: "object",
          properties: {
            startHour: string,
            endHour: string,
            excludeWeekends: { type: "boolean" },
            pageSize: { type: "integer" },
          },
        },
      },
      required: ["attendeeEmails", "startTime", "endTime"],
    },
  },
  {
    name: "create_event",
    description: "Creates an event on the given calendar.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: string,
        summary: string,
        description: string,
        location: string,
        startTime: string,
        endTime: string,
        timeZone: string,
        attendees: { type: "array", items: attendee },
        attendeeEmails: { type: "array", items: string },
        notificationLevel: NOTIFICATION,
        addGoogleMeetUrl: { type: "boolean" },
      },
      required: ["summary", "startTime", "endTime"],
    },
  },
  {
    name: "update_event",
    description: "Updates an event.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: string,
        eventId: string,
        summary: string,
        description: string,
        location: string,
        startTime: string,
        endTime: string,
        timeZone: string,
        addedAttendees: { type: "array", items: attendee },
        removedAttendeeEmails: { type: "array", items: string },
        notificationLevel: NOTIFICATION,
      },
      required: ["eventId"],
    },
  },
  {
    name: "delete_event",
    description: "Deletes an event.",
    inputSchema: {
      type: "object",
      properties: { calendarId: string, eventId: string, notificationLevel: NOTIFICATION },
      required: ["eventId"],
    },
  },
  {
    name: "respond_to_event",
    description: "Responds to an event invitation.",
    inputSchema: {
      type: "object",
      properties: { calendarId: string, eventId: string, responseStatus: string },
      required: ["eventId", "responseStatus"],
    },
  },
];

class Refused extends Error {}

export class GoogleCalendarEmulator {
  private readonly clients = new Map<string, string[]>();
  private readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; calendar: Calendar }
  >();
  private readonly tokens = new Map<string, Calendar>();
  private readonly refreshTokens = new Map<string, Calendar>();
  private readonly calendars: Calendar[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  readonly handles = (hostname: string) =>
    hostname === MCP_HOST || hostname === AUTH_HOST || hostname === TOKEN_HOST;

  /** Every calendar's events, newest consent first, for a test to read what was booked. */
  events(): Array<EmulatedCalendarEvent & { calendar: string }> {
    return this.calendars.flatMap((calendar) =>
      [...calendar.events.values()].map((event) => ({ ...event, calendar: calendar.owner })),
    );
  }

  /**
   * The recruiter allows access on the consent screen: the redirect, with its code, that the
   * browser would follow back to the product.
   */
  consent(authorizationUrl: string, owner?: string): string {
    const url = new URL(authorizationUrl);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (
      url.hostname !== AUTH_HOST ||
      !this.clients.get(clientId)?.includes(redirectUri) ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !challenge
    )
      throw new Refused("Unknown client, redirect or code challenge");
    const calendar: Calendar = {
      owner: owner ?? `recruiter${this.calendars.length + 1}@calendar.example.test`,
      events: new Map(),
    };
    this.calendars.push(calendar);
    const code = randomUUID();
    this.codes.set(code, { clientId, redirectUri, challenge, calendar });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) back.searchParams.set("state", state);
    return back.toString();
  }

  async fetch(url: URL, init?: RequestInit): Promise<Response> {
    try {
      if (url.hostname === MCP_HOST) {
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({
            resource: RESOURCE,
            authorization_servers: [`https://${AUTH_HOST}`],
            scopes_supported: ["https://www.googleapis.com/auth/calendar.events"],
          });
        if (url.pathname.replace(/\/$/, "") === "/mcp/v1") return this.mcp(init);
        return new Response(null, { status: 404 });
      }
      if (url.hostname === AUTH_HOST) {
        if (url.pathname.startsWith("/.well-known/"))
          return Response.json({
            issuer: `https://${AUTH_HOST}`,
            authorization_endpoint: `https://${AUTH_HOST}/o/oauth2/v2/auth`,
            token_endpoint: `https://${TOKEN_HOST}/token`,
            registration_endpoint: `https://${AUTH_HOST}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (url.pathname === "/register" && init?.method === "POST") {
          const body = readJson(init.body);
          const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
          const clientId = `emulated-client-${this.clients.size + 1}`;
          this.clients.set(clientId, redirects);
          return Response.json(
            { ...body, client_id: clientId, token_endpoint_auth_method: "none" },
            { status: 201 },
          );
        }
        return new Response(null, { status: 404 });
      }
      if (url.pathname === "/token" && init?.method === "POST") return this.token(init.body);
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof Refused)
        return Response.json(
          { error: "invalid_request", error_description: error.message },
          { status: 400 },
        );
      throw error;
    }
  }

  private token(raw: RequestInit["body"] | null | undefined): Response {
    const form = new URLSearchParams(bodyText(raw));
    let calendar: Calendar | undefined;
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !code ||
        code.clientId !== form.get("client_id") ||
        code.redirectUri !== form.get("redirect_uri") ||
        createHash("sha256").update(verifier).digest("base64url") !== code.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      this.codes.delete(form.get("code")!);
      calendar = code.calendar;
    } else if (form.get("grant_type") === "refresh_token")
      calendar = this.refreshTokens.get(form.get("refresh_token") ?? "");
    if (!calendar) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const access = `emulated-calendar-access-${randomUUID()}`;
    const refresh = `emulated-calendar-refresh-${randomUUID()}`;
    this.tokens.set(access, calendar);
    this.refreshTokens.set(refresh, calendar);
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "https://www.googleapis.com/auth/calendar.events",
    });
  }

  private mcp(init?: RequestInit): Response {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const calendar = this.tokens.get(authorization.replace(/^Bearer /, ""));
    if (!calendar)
      return new Response("missing bearer token", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${METADATA}"` },
      });
    const request = readJson(init?.body);
    const id = request.id;
    const method = String(request.method ?? "");
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize")
      return rpc(id, {
        protocolVersion: String(
          (request.params as Row | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "calendar-emulator", version: "1.0.0" },
      });
    if (method === "tools/list") return rpc(id, { tools: TOOLS });
    if (method !== "tools/call")
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unhandled MCP method ${method}` },
      });
    const params = (request.params ?? {}) as Row;
    const args = (params.arguments ?? {}) as Row;
    try {
      const result = this.call(calendar, String(params.name ?? ""), args);
      return rpc(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return rpc(id, { content: [{ type: "text", text: error.message }], isError: true });
    }
  }

  private call(calendar: Calendar, tool: string, args: Row): Row {
    const live = () =>
      [...calendar.events.values()]
        .filter((event) => event.status !== "cancelled")
        .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    const find = () => {
      const event = calendar.events.get(String(args.eventId ?? ""));
      if (!event || event.status === "cancelled") throw new Refused("Event not found");
      return event;
    };
    const zone = typeof args.timeZone === "string" ? args.timeZone : "UTC";
    switch (tool) {
      case "list_calendars":
        return {
          calendars: [
            { id: calendar.owner, summary: calendar.owner, primary: true, timeZone: "UTC" },
          ],
        };
      case "list_events":
      case "search_events": {
        const from = args.startTime ? instant(String(args.startTime), zone) : -Infinity;
        const to = args.endTime ? instant(String(args.endTime), zone) : Infinity;
        const text = typeof args.fullText === "string" ? args.fullText.toLowerCase() : "";
        return {
          timeZone: "UTC",
          events: live().filter(
            (event) =>
              Date.parse(event.end.dateTime) > from &&
              Date.parse(event.start.dateTime) < to &&
              (!text || event.summary.toLowerCase().includes(text)),
          ),
        };
      }
      case "get_event":
        return find();
      case "suggest_time": {
        const emails = Array.isArray(args.attendeeEmails) ? args.attendeeEmails.map(String) : [];
        if (!emails.length || !args.startTime || !args.endTime)
          throw new Refused("attendeeEmails, startTime and endTime are required");
        const preferences = (args.preferences ?? {}) as Row;
        const minutes = Number(args.durationMinutes ?? 30);
        const limit = Number(preferences.pageSize ?? 5);
        const from = instant(String(args.startTime), zone);
        const to = instant(String(args.endTime), zone);
        const hour = (value: unknown, fallback: number) =>
          typeof value === "string" && /^\d\d:\d\d$/.test(value)
            ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
            : fallback;
        const open = hour(preferences.startHour, 0);
        const close = hour(preferences.endHour, 24 * 60);
        // Only this calendar's own events are known; other people's calendars read as free.
        const busy = live().map((event) => [
          Date.parse(event.start.dateTime),
          Date.parse(event.end.dateTime),
        ]);
        const slots: Row[] = [];
        for (
          let start = Math.ceil(from / 1_800_000) * 1_800_000;
          start + minutes * 60_000 <= to && slots.length < limit;
          start += 1_800_000
        ) {
          const end = start + minutes * 60_000;
          const local = wall(start, zone);
          const minute = local.hour * 60 + local.minute;
          if (preferences.excludeWeekends === true && (local.weekday === 0 || local.weekday === 6))
            continue;
          if (minute < open || minute + minutes > close) continue;
          if (busy.some(([a, b]) => start < b! && end > a!)) continue;
          slots.push({
            start: { dateTime: new Date(start).toISOString(), timeZone: zone },
            end: { dateTime: new Date(end).toISOString(), timeZone: zone },
          });
        }
        return { timeSlots: slots };
      }
      case "create_event": {
        if (typeof args.summary !== "string" || !args.startTime || !args.endTime)
          throw new Refused("summary, startTime and endTime are required");
        const at = this.now().toISOString();
        const id = randomUUID().replaceAll("-", "");
        const event: EmulatedCalendarEvent = {
          id,
          status: "confirmed",
          summary: args.summary,
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.location === "string" ? { location: args.location } : {}),
          start: { dateTime: iso(String(args.startTime), zone), timeZone: zone },
          end: { dateTime: iso(String(args.endTime), zone), timeZone: zone },
          attendees: [
            { email: calendar.owner, organizer: true, self: true, responseStatus: "accepted" },
            ...guests(args.attendees, args.attendeeEmails),
          ],
          organizer: { email: calendar.owner, self: true },
          htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
          created: at,
          updated: at,
        };
        if (Date.parse(event.end.dateTime) <= Date.parse(event.start.dateTime))
          throw new Refused("The event must end after it starts");
        calendar.events.set(id, event);
        return event;
      }
      case "update_event": {
        const event = find();
        const removed = new Set(
          (Array.isArray(args.removedAttendeeEmails) ? args.removedAttendeeEmails : []).map(
            (email) => String(email).toLowerCase(),
          ),
        );
        const next: EmulatedCalendarEvent = {
          ...event,
          ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.location === "string" ? { location: args.location } : {}),
          ...(args.startTime
            ? { start: { dateTime: iso(String(args.startTime), zone), timeZone: zone } }
            : {}),
          ...(args.endTime
            ? { end: { dateTime: iso(String(args.endTime), zone), timeZone: zone } }
            : {}),
          attendees: [
            ...event.attendees.filter((guest) => !removed.has(guest.email.toLowerCase())),
            ...guests(args.addedAttendees, undefined).filter(
              (guest) =>
                !event.attendees.some(
                  (known) => known.email.toLowerCase() === guest.email.toLowerCase(),
                ),
            ),
          ],
          updated: this.now().toISOString(),
        };
        calendar.events.set(event.id, next);
        return next;
      }
      case "delete_event": {
        const event = find();
        calendar.events.set(event.id, {
          ...event,
          status: "cancelled",
          updated: this.now().toISOString(),
        });
        return {};
      }
      case "respond_to_event": {
        const event = find();
        for (const guest of event.attendees)
          if (guest.self) guest.responseStatus = String(args.responseStatus);
        return event;
      }
      default:
        throw new Refused(`Unknown tool ${tool}`);
    }
  }
}

function guests(attendees: unknown, emails: unknown): Attendee[] {
  const rows = [
    ...(Array.isArray(attendees) ? attendees : []),
    ...(Array.isArray(emails) ? emails.map((email) => ({ email })) : []),
  ];
  return rows.flatMap((row) => {
    const value = row as Row;
    return typeof value?.email === "string"
      ? [
          {
            email: value.email,
            ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
            responseStatus: "needsAction",
          },
        ]
      : [];
  });
}

/** A time with an offset is that instant; one without is wall time in the request's zone. */
function instant(value: string, zone: string): number {
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  const guess = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (!Number.isFinite(guess)) throw new Refused(`Invalid time ${value}`);
  const offset = (at: number) => {
    const local = wall(at, zone);
    return (
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - at
    );
  };
  return guess - offset(guess - offset(guess));
}

function iso(value: string, zone: string) {
  return new Date(instant(value, zone)).toISOString();
}

function wall(at: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)),
  };
}

/** The backend's pinned fetch hands bodies over as bytes; the SDK's own fetch as strings or forms. */
function bodyText(body: RequestInit["body"] | null | undefined): string {
  if (typeof body === "string" || body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return new TextDecoder().decode(body);
  return "";
}

function readJson(body: RequestInit["body"] | null | undefined): Row {
  const text = bodyText(body);
  return text ? (JSON.parse(text) as Row) : {};
}

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}
