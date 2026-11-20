import { randomUUID } from "node:crypto";
import { nextSendWindow } from "./instantly-native-writes.js";

/**
 * A stateful stand-in for the outreach mail service (its v2 REST API and its remote MCP reads),
 * for a test backend that plays send journeys without the real account: campaigns, people and
 * mailboxes are kept in memory, and an active campaign "sends" its queued people over time, one
 * per email_gap minutes inside its sending hours, after a short pickup. Nothing leaves the
 * process. Only the requests this product makes are answered; anything else is a 404.
 */
export type InstantlyMailbox = { email: string; first_name?: string; last_name?: string };

type Row = Record<string, unknown>;
type Lead = Row & { id: string; email: string; campaign: string };
type Campaign = Row & { id: string; status: number };

const API = "/api/v2";
/** Minutes between activation and the first email: the real service often takes most of an hour. */
const PICKUP_MINUTES = 45;
const DAILY_LIMIT = 50;
const MCP_TOOLS = ["get_email", "list_emails", "reply_to_email"] as const;

export class InstantlyEmulator {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly leads = new Map<string, Lead>();
  private readonly mailboxes = new Map<string, Row>();
  private readonly emails: Row[] = [];
  /** When each active campaign may send its next email. */
  private readonly nextSend = new Map<string, number>();

  constructor(
    mailboxes: InstantlyMailbox[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const mailbox of mailboxes) this.addMailbox(mailbox);
  }

  addMailbox(mailbox: InstantlyMailbox) {
    this.mailboxes.set(mailbox.email.toLowerCase(), {
      email: mailbox.email.toLowerCase(),
      first_name: mailbox.first_name ?? "",
      last_name: mailbox.last_name ?? "",
      status: 1,
      setup_pending: false,
      warmup_status: 1,
      daily_limit: DAILY_LIMIT,
      timestamp_created: this.now().toISOString(),
    });
  }

  readonly handles = (hostname: string) =>
    hostname === "api.instantly.ai" || hostname === "mcp.instantly.ai";

  async fetch(url: URL, init?: RequestInit): Promise<Response> {
    const body = readBody(init?.body);
    if (url.hostname === "mcp.instantly.ai") return this.mcp(body);
    if (!url.pathname.startsWith(API)) return missing(url.pathname);
    this.advance();
    const method = (init?.method ?? "GET").toUpperCase();
    try {
      const result = this.rest(method, url.pathname.slice(API.length), url.searchParams, body);
      return result === undefined ? missing(url.pathname) : Response.json(result);
    } catch (error) {
      if (error instanceof Refused)
        return Response.json({ message: error.message }, { status: error.status });
      throw error;
    }
  }

  private rest(method: string, path: string, query: URLSearchParams, body: Row): unknown {
    const [, resource, id, action] = path.split("/");
    if (resource === "campaigns") return this.campaign(method, id, action, query, body);
    if (resource === "leads") return this.lead(method, id, body);
    if (resource === "accounts") return this.account(method, id, action, query, body);
    if (resource === "emails") return this.email(method, id, query, body);
    if (resource === "dfy-email-account-orders") {
      if (method === "GET") return { items: [], next_starting_after: null };
      throw new Refused(400, "Buying mailboxes is not available here.");
    }
    return undefined;
  }

  private campaign(
    method: string,
    id: string | undefined,
    action: string | undefined,
    query: URLSearchParams,
    body: Row,
  ) {
    if (!id) {
      if (method === "GET") {
        const search = (query.get("search") ?? "").toLowerCase();
        const items = [...this.campaigns.values()].filter((campaign) =>
          String(campaign.name ?? "")
            .toLowerCase()
            .includes(search),
        );
        return { items, next_starting_after: null };
      }
      if (method !== "POST") return undefined;
      const campaign: Campaign = {
        email_gap: 10,
        stop_on_reply: true,
        email_list: [],
        sequences: [],
        ...body,
        id: randomUUID(),
        status: 0,
        timestamp_created: this.now().toISOString(),
      };
      this.campaigns.set(campaign.id, campaign);
      return campaign;
    }
    if (id === "analytics" && action === "overview") return this.analytics(query);
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new Refused(404, "Campaign not found");
    if (method === "GET" && !action) return campaign;
    if (method === "PATCH" && !action) {
      Object.assign(campaign, body, { id: campaign.id, status: campaign.status });
      return campaign;
    }
    if (method === "POST" && action === "activate") {
      if (campaign.status !== 1)
        this.nextSend.set(campaign.id, this.now().getTime() + PICKUP_MINUTES * 60_000);
      campaign.status = 1;
      return campaign;
    }
    if (method === "POST" && action === "pause") {
      campaign.status = 2;
      return campaign;
    }
    return undefined;
  }

  private analytics(query: URLSearchParams) {
    const id = query.get("id") ?? query.get("campaign_id");
    const sent = this.emails.filter((email) => !id || email.campaign_id === id);
    return {
      emails_sent_count: sent.filter((email) => email.ue_type === 1).length,
      open_count_unique: 0,
      reply_count_unique: 0,
    };
  }

  private lead(method: string, id: string | undefined, body: Row) {
    if (id === "add" && method === "POST") {
      const campaign = this.campaigns.get(String(body.campaign_id ?? ""));
      if (!campaign) throw new Refused(404, "Campaign not found");
      const people = Array.isArray(body.leads) ? (body.leads as Row[]) : [];
      const created: Row[] = [];
      let skipped = 0;
      people.forEach((person, index) => {
        const email = String(person.email ?? "").toLowerCase();
        const taken = [...this.leads.values()].some(
          (lead) =>
            lead.email === email && (body.skip_if_in_workspace || lead.campaign === campaign.id),
        );
        if (!email.includes("@") || taken) {
          skipped += 1;
          return;
        }
        const { custom_variables, ...fields } = person;
        const lead: Lead = {
          ...fields,
          id: randomUUID(),
          email,
          campaign: campaign.id,
          status: 1,
          payload: { ...(custom_variables as Row | undefined) },
          timestamp_created: this.now().toISOString(),
          timestamp_last_contact: null,
          email_open_count: 0,
          email_reply_count: 0,
          email_click_count: 0,
        };
        this.leads.set(lead.id, lead);
        created.push({ index, id: lead.id, email });
      });
      return {
        status: "success",
        leads_uploaded: created.length,
        skipped_count: skipped,
        created_leads: created,
      };
    }
    if (id === "list" && method === "POST") {
      const contacts = Array.isArray(body.contacts)
        ? new Set((body.contacts as unknown[]).map((email) => String(email).toLowerCase()))
        : null;
      const all = [...this.leads.values()].filter(
        (lead) =>
          (!body.campaign || lead.campaign === body.campaign) &&
          (!contacts || contacts.has(lead.email)),
      );
      const start = body.starting_after
        ? all.findIndex((lead) => lead.id === body.starting_after) + 1
        : 0;
      const limit = Math.min(Number(body.limit) || 100, 100);
      const items = all.slice(start, start + limit);
      return {
        items,
        next_starting_after: start + limit < all.length ? items.at(-1)?.id : null,
      };
    }
    if (id === "update-interest-status" && method === "POST") {
      for (const lead of this.leads.values())
        if (lead.email === String(body.lead_email ?? "").toLowerCase())
          lead.lt_interest_status = body.interest_value;
      return { message: "Interest status update job submitted" };
    }
    const lead = id ? this.leads.get(id) : undefined;
    if (!lead) throw new Refused(404, "Lead not found");
    if (method === "GET") return lead;
    if (method === "DELETE") {
      this.leads.delete(lead.id);
      return lead;
    }
    if (method === "PATCH") {
      const { custom_variables, ...fields } = body;
      Object.assign(lead, fields, {
        payload: { ...(lead.payload as Row), ...(custom_variables as Row | undefined) },
      });
      return lead;
    }
    return undefined;
  }

  private account(
    method: string,
    id: string | undefined,
    action: string | undefined,
    query: URLSearchParams,
    body: Row,
  ) {
    if (!id) return method === "GET" ? { items: [...this.mailboxes.values()] } : undefined;
    if (id === "warmup" && action === "enable") return { status: "success" };
    if (id === "analytics" && action === "daily") {
      const day = query.get("start_date") ?? this.now().toISOString().slice(0, 10);
      return [...this.mailboxes.keys()].map((email) => ({
        date: day,
        email_account: email,
        sent: this.emails.filter(
          (row) =>
            row.ue_type === 1 &&
            row.eaccount === email &&
            String(row.timestamp_email).startsWith(day),
        ).length,
      }));
    }
    const mailbox = this.mailboxes.get(decodeURIComponent(id).toLowerCase());
    if (!mailbox) throw new Refused(404, "Account not found");
    if (method === "GET") return mailbox;
    if (method === "PATCH") {
      for (const field of ["first_name", "last_name", "daily_limit"])
        if (field in body) mailbox[field] = body[field];
      return mailbox;
    }
    return undefined;
  }

  private email(method: string, id: string | undefined, query: URLSearchParams, body: Row) {
    if (!id && method === "GET") {
      const campaign = query.get("campaign_id");
      const lead = query.get("lead")?.toLowerCase();
      const items = this.emails.filter(
        (email) => (!campaign || email.campaign_id === campaign) && (!lead || email.lead === lead),
      );
      return { items, next_starting_after: null };
    }
    if (id === "reply" && method === "POST") {
      const original = this.emails.find((email) => email.id === body.reply_to_uuid);
      if (!original) throw new Refused(404, "Email not found");
      const reply = this.sent(
        String(original.campaign_id),
        String(original.lead),
        String(body.eaccount ?? original.eaccount),
        String(body.subject ?? ""),
        String((body.body as Row | undefined)?.text ?? (body.body as Row | undefined)?.html ?? ""),
        original.thread_id as string,
      );
      return reply;
    }
    const email = this.emails.find((row) => row.id === id);
    if (!email) throw new Refused(404, "Email not found");
    return email;
  }

  /** Emails the queued people whose turn has come in every active campaign. */
  private advance() {
    const now = this.now();
    for (const campaign of this.campaigns.values()) {
      if (campaign.status !== 1) continue;
      const window = nextSendWindow(campaign, now);
      if (window && !window.now) continue;
      const gap = (Number(campaign.email_gap) > 0 ? Number(campaign.email_gap) : 10) * 60_000;
      const mailbox = Array.isArray(campaign.email_list) ? String(campaign.email_list[0]) : "";
      let next = this.nextSend.get(campaign.id) ?? now.getTime();
      for (const lead of this.leads.values()) {
        if (lead.campaign !== campaign.id || lead.timestamp_last_contact) continue;
        if (next > now.getTime()) break;
        const first = firstStep(campaign);
        const at = new Date(next).toISOString();
        this.sent(
          campaign.id,
          lead.email,
          mailbox,
          fill(first.subject, lead),
          fill(first.body, lead),
          undefined,
          at,
        );
        lead.timestamp_last_contact = at;
        next += gap;
      }
      this.nextSend.set(campaign.id, next);
    }
  }

  private sent(
    campaign: string,
    lead: string,
    eaccount: string,
    subject: string,
    text: string,
    thread?: string,
    at = this.now().toISOString(),
  ) {
    const id = randomUUID();
    const email = {
      id,
      timestamp_created: at,
      timestamp_email: at,
      message_id: `<${id}@emulated.invalid>`,
      subject,
      from_address_email: eaccount,
      to_address_email_list: lead,
      body: { text },
      campaign_id: campaign,
      lead,
      eaccount,
      ue_type: 1,
      thread_id: thread ?? `thread-${id}`,
    };
    this.emails.push(email);
    return email;
  }

  private mcp(request: Row): Response {
    const id = request.id;
    const method = String(request.method ?? "");
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize")
      return reply({
        protocolVersion: String(
          (request.params as Row | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "emulated-outreach-mail", version: "1" },
      });
    if (method === "tools/list")
      return reply({
        tools: MCP_TOOLS.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
          annotations: { readOnlyHint: name !== "reply_to_email" },
        })),
      });
    if (method !== "tools/call")
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: method } });
    this.advance();
    const params = (request.params ?? {}) as Row;
    const args = (params.arguments ?? {}) as Row;
    const query = new URLSearchParams(
      Object.entries(args).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    );
    let result: unknown;
    try {
      result =
        params.name === "list_emails"
          ? this.email("GET", undefined, query, {})
          : params.name === "get_email"
            ? this.email("GET", String(args.id ?? ""), query, {})
            : params.name === "reply_to_email"
              ? this.email("POST", "reply", query, args)
              : undefined;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return reply({ isError: true, content: [{ type: "text", text: error.message }] });
    }
    if (result === undefined)
      return reply({ isError: true, content: [{ type: "text", text: "Unknown tool" }] });
    return reply({
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
  }
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function missing(path: string) {
  return Response.json({ message: `Not found: ${path}` }, { status: 404 });
}

function readBody(body: RequestInit["body"] | undefined): Row {
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array || body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : "";
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function firstStep(campaign: Campaign) {
  const sequences = Array.isArray(campaign.sequences) ? (campaign.sequences as Row[]) : [];
  const steps = Array.isArray(sequences[0]?.steps) ? (sequences[0]!.steps as Row[]) : [];
  const variants = Array.isArray(steps[0]?.variants) ? (steps[0]!.variants as Row[]) : [];
  return { subject: String(variants[0]?.subject ?? ""), body: String(variants[0]?.body ?? "") };
}

/** Lead variables as the service fills them: {{first_name}} and the lead's own variables. */
function fill(text: string, lead: Lead) {
  const values: Row = { ...lead, ...(lead.payload as Row) };
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) =>
    values[name] == null ? "" : String(values[name]),
  );
}
