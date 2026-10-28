import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import type { FoundEmail } from "./contact-lookup.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import { savedContactEmails } from "./recruiting-research.js";

/**
 * Local REST-backed Instantly campaign/lead tools (official v2 API, https://developer.instantly.ai).
 * Approval classes live in @rakazo/core action-approval: non-sending writes are internal
 * record-keeping; activate_campaign (the only call that starts sending) is an explicit one-time card.
 */
const API = "https://api.instantly.ai/api/v2";
const Uuid = z.uuid();
const Email = z.email().max(254);
const Step = z.strictObject({
  subject: z.string().min(1).max(500),
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe('Plain text: a blank line between paragraphs, "• " to start a bullet.'),
  delay_days: z
    .number()
    .int()
    .min(0)
    .max(366)
    .default(0)
    .describe("Days to wait before this step."),
});
const CampaignSetup = {
  eaccount: Email.describe("Your connected Instantly sending mailbox. Never a contact address."),
  steps: z.array(Step).min(1).max(10).optional().describe("Email sequence; first item is email 1."),
  timezone: z.string().max(64).default("America/Chicago").describe("Instantly schedule timezone."),
  send_hours: z
    .enum(["weekdays_9_to_5", "any_time"])
    .optional()
    .describe("When emails may go out; new campaigns default to weekdays_9_to_5."),
};
const CreateCampaignInput = z.strictObject({ name: z.string().min(1).max(200), ...CampaignSetup });
const Lead = z.strictObject({
  email: Email,
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  company_name: z.string().max(200).optional(),
});
const AddLeadsInput = z.strictObject({
  campaign_id: Uuid,
  leads: z.array(Lead).min(1).max(100),
  skip_if_in_workspace: z.boolean().default(false),
});
const ListLeadsInput = z.strictObject({
  campaign_id: Uuid.optional(),
  email: Email.optional().describe("Exact lead email; returns the lead id(s) for it."),
  limit: z.number().int().min(1).max(100).default(50),
  starting_after: z.string().max(1600).optional(),
});
const UpdateLeadInterestInput = z.strictObject({
  lead_email: Email,
  campaign_id: Uuid.optional(),
  interest_value: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .or(z.union([z.literal(-1), z.literal(-2), z.literal(-3), z.literal(-4)]))
    .nullable()
    .describe(
      "1 Interested, 2 Meeting booked, 3 Meeting completed, 4 Won, 0 Out of office, -1 Not interested, -2 Wrong person, -3 Lost, -4 No show, null resets to Lead.",
    ),
});
const CampaignIdInput = z.strictObject({ campaign_id: Uuid });
const RoleId = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe("Recruiting role id; omit inside a role conversation (its linked role is used).");
const ActivateCampaignInput = z.strictObject({
  campaign_id: Uuid.optional().describe(
    "Omit inside a role conversation to activate the role's own campaign (created if needed).",
  ),
});
const EnsureRoleCampaignInput = z.strictObject({
  role_id: RoleId,
  eaccount: CampaignSetup.eaccount
    .optional()
    .describe("Sending mailbox; omit to use the last-used or first connected Instantly account."),
  steps: CampaignSetup.steps,
  timezone: CampaignSetup.timezone,
  send_hours: CampaignSetup.send_hours.describe(
    "Change when emails may go out; an active campaign is paused for the change and needs activate_campaign again.",
  ),
});
const AddShortlistLeadsInput = z.strictObject({
  role_id: RoleId,
  candidates: z
    .array(
      z.strictObject({
        candidate_key: z.string().min(1).max(500),
        email: Email.nullable()
          .optional()
          .describe("Verified email from enrichment. Omit when unknown; never guess."),
        first_name: z.string().max(200).optional(),
        last_name: z.string().max(200).optional(),
        company_name: z.string().max(200).optional(),
        email_type: z
          .enum(["work", "personal"])
          .optional()
          .describe("Which kind of address the lookup found; the send card shows it."),
        personalization: z
          .string()
          .max(1000)
          .optional()
          .describe(
            "This person's own opening line, sent where the sequence has {{personalization}}.",
          ),
      }),
    )
    .min(1)
    .max(100),
});

const EmailIdInput = z.strictObject({
  id: Uuid.describe(
    "Provider email id from list_mailbox_emails, search_contact_emails or get_thread_history.",
  ),
});
const ReplyToEmailInput = z.strictObject({
  reply_to_uuid: Uuid.describe(
    "Provider id of the email being answered (from list_mailbox_emails, search_contact_emails or get_thread_history).",
  ),
  eaccount: Email.optional().describe(
    "Your connected mailbox that sends the reply; omit to use the mailbox that holds the original email.",
  ),
  subject: z.string().min(1).max(500).optional().describe('Omit for "Re: <original subject>".'),
  body: z.strictObject({
    text: z.string().min(1).max(20_000),
    html: z.string().min(1).max(50_000).optional(),
  }),
});

const LOCAL = "Local native REST integration for the existing authorized Instantly connection.";
const tool = (name: string, schema: z.ZodType, readOnly: boolean, description: string) => ({
  name,
  toolName: `native_instantly_${name}`,
  inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
  readOnly,
  description: `${LOCAL} ${description}`,
});
export const nativeInstantlyWrites = [
  tool(
    "create_campaign",
    CreateCampaignInput,
    false,
    "Creates a draft (not sending) campaign from one of your connected mailboxes with stop-on-reply on. Prefer ensure_role_campaign for a recruiting role.",
  ),
  tool(
    "add_leads",
    AddLeadsInput,
    false,
    "Adds leads to a draft or paused campaign (refused while it is active, since that would send). Returns created lead ids.",
  ),
  tool(
    "list_leads",
    ListLeadsInput,
    true,
    "Lists leads of a campaign and/or one exact email, with lead id, status and interest.",
  ),
  tool(
    "get_campaign",
    CampaignIdInput,
    true,
    "Reads one campaign's name, status (0 draft, 1 active, 2 paused, 3 completed), stop_on_reply, send hours, the sending mailbox and the recipients (its leads).",
  ),
  tool(
    "update_lead_interest",
    UpdateLeadInterestInput,
    false,
    "Sets a lead's interest status (provider runs it as a background job).",
  ),
  tool(
    "activate_campaign",
    ActivateCampaignInput,
    false,
    "Sends the campaign's first email to its leads by activating it (also resumes a paused one); the campaign needs its email saved first (ensure_role_campaign steps). This is the only way to send a campaign email; it shows the native confirmation card — call it and let the human confirm, do not refuse or ask for a thread.",
  ),
  tool("pause_campaign", CampaignIdInput, false, "Pauses a campaign; stops further sends."),
  tool(
    "get_email",
    EmailIdInput,
    true,
    "Reads one email (subject, sender, recipients, mailbox, thread, body) by its provider id.",
  ),
  tool(
    "reply_to_email",
    ReplyToEmailInput,
    false,
    "Sends a reply in the existing thread of one received email from your connected mailbox. This is the only way to answer a candidate's email; it shows the native confirmation card and nothing is sent until the human confirms — call it, never refuse or say there is no approval flow.",
  ),
  tool(
    "ensure_role_campaign",
    EnsureRoleCampaignInput,
    false,
    "Returns the one Instantly campaign bound to a recruiting role, creating it (draft, stop-on-reply on, default mailbox) only if none exists. Idempotent; needs no arguments inside a role conversation. Pass steps to save the email sequence on a campaign it created: a draft that has sent nothing takes new copy in place of the old, a paused one only its first; other copy is kept and comes back as currentEmail. hasEmail says whether the campaign has an email to send. Pass send_hours any_time when the recruiter wants it sent now or outside weekday 9-5. Also returns candidate_key -> lead id mappings.",
  ),
  tool(
    "add_shortlist_leads",
    AddShortlistLeadsInput,
    false,
    "Adds the role's candidates the recruiter asked to contact to its campaign as leads (ensuring the campaign first); no shortlist is needed. Pass each person's email, email_type, first_name, company_name and personalization (their own opening line for {{personalization}} in the sequence); a person passed without an email gets the one an earlier contact lookup saved. Skips people with no email, on hold or passed for the role, or already in the campaign; records candidate_key -> lead id.",
  ),
];
const TOOL_NAMES = new Set(nativeInstantlyWrites.map((entry) => entry.toolName));
export const isNativeInstantlyWrite = (toolName: string) => TOOL_NAMES.has(toolName);

export type InstantlyRest = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;

export class InstantlyRestError extends Error {
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

/** "HTTP 400: <provider message>", so the agent can correct its arguments. */
function providerError(status: number, text: string) {
  let message = text;
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    message = String(body.message ?? body.error ?? text);
  } catch {}
  message = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
}

// The provider accepts only its own zone list; these common zones map to a listed zone with the
// same offsets and daylight-saving rules.
const PROVIDER_ZONE: Record<string, string> = {
  "America/New_York": "America/Detroit",
  "America/Toronto": "America/Detroit",
  "America/Indiana/Indianapolis": "America/Detroit",
  "US/Eastern": "America/Detroit",
  "America/Denver": "America/Boise",
  "US/Mountain": "America/Boise",
  "America/Phoenix": "America/Creston",
  "US/Central": "America/Chicago",
};
export const providerTimezone = (zone: string) => PROVIDER_ZONE[zone] ?? zone;

export function instantlyRest(
  fetch: (url: URL, init: RequestInit) => Promise<Response>,
  key: string,
  signal: AbortSignal,
): InstantlyRest {
  return async (method, path, body) => {
    signal.throwIfAborted();
    const response = await fetch(new URL(`${API}${path}`), {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const { text, truncated } = await readBoundedText(response, 1_000_000);
    if (!response.ok)
      throw new InstantlyRestError(response.status, providerError(response.status, text));
    if (truncated) throw new Error("Instantly response exceeded its bound");
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Instantly response is not an object");
    return value as Record<string, unknown>;
  };
}

// Instantly campaign status: 0 draft, 1 active, 2 paused, 3 completed. Enrolling into an active
// campaign starts sending, so leads only go into draft/paused ones; activation is the card.
const ENROLLABLE = new Set([0, 2]);
const ACTIVE = 1;
const DRAFT = 0;
async function requireEnrollable(rest: InstantlyRest, campaignId: string) {
  const campaign = await rest("GET", `/campaigns/${campaignId}`);
  if (!ENROLLABLE.has(campaign.status as number))
    throw new Error(
      `Campaign status ${String(campaign.status)} is not draft/paused; pause it before adding leads, then activate it (confirmation required).`,
    );
}

async function requireOwnMailbox(rest: InstantlyRest, eaccount: string) {
  try {
    await rest("GET", `/accounts/${encodeURIComponent(eaccount)}`);
  } catch (error) {
    if (error instanceof InstantlyRestError && error.status === 404)
      throw new Error(`${eaccount} is not one of your connected Instantly mailboxes`);
    throw error;
  }
}

/**
 * The provider stores a body containing "&" as blank, even an encoded entity, and drops text that
 * is not inside a paragraph, so every body is sent as plain-text paragraphs: HTML is read as text
 * (a list becomes bullet lines) and "&" and the characters that would need an entity become their
 * full-width forms.
 */
function bodyHtml(body: string) {
  const text = /<[a-z][^>]*>/i.test(body)
    ? htmlToPlainText(
        body
          .replace(/<\/?[ou]l\b[^>]*>/gi, "<br /><br />")
          .replace(/<li\b[^>]*>/gi, "<br />• ")
          .replace(/<\/li>/gi, ""),
      )
    : body;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "＆")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function sequences(steps: z.output<typeof Step>[]) {
  return [
    {
      steps: steps.map((step) => ({
        type: "email",
        delay: step.delay_days,
        delay_unit: "days",
        variants: [{ subject: step.subject.replace(/&/g, "＆"), body: bodyHtml(step.body) }],
      })),
    },
  ];
}
/** The first step's first variant, or null when the campaign has no email with visible text yet. */
function firstEmail(campaign: Record<string, unknown> | undefined) {
  const list = Array.isArray(campaign?.sequences) ? campaign.sequences : [];
  const steps = (list[0] as { steps?: unknown } | undefined)?.steps;
  const step = Array.isArray(steps) ? (steps[0] as { variants?: unknown }) : undefined;
  const variant = Array.isArray(step?.variants)
    ? (step.variants[0] as { subject?: unknown; body?: unknown })
    : undefined;
  return typeof variant?.subject === "string" &&
    typeof variant.body === "string" &&
    htmlToPlainText(variant.body).trim() !== ""
    ? { subject: variant.subject, body: variant.body }
    : null;
}

function campaignSchedule(hours: "weekdays_9_to_5" | "any_time", zone: string) {
  const anyTime = hours === "any_time";
  return {
    schedules: [
      {
        name: anyTime ? "Any time" : "Weekdays",
        timing: anyTime ? { from: "00:00", to: "23:59" } : { from: "09:00", to: "17:00" },
        // ponytail: "1".."5" assumed Mon-Fri (docs do not define the day index); adjust in UI if off.
        days: { "0": anyTime, "1": true, "2": true, "3": true, "4": true, "5": true, "6": anyTime },
        timezone: providerTimezone(zone),
      },
    ],
  };
}

function campaignBody(name: string, setup: z.output<typeof CreateCampaignInput>) {
  return {
    name,
    campaign_schedule: campaignSchedule(setup.send_hours ?? "weekdays_9_to_5", setup.timezone),
    ...(setup.steps ? { sequences: sequences(setup.steps) } : {}),
    email_list: [setup.eaccount],
    // Instantly has no per-lead stop; the campaign flag is the only native stop on reply.
    stop_on_reply: true,
    stop_on_auto_reply: true,
  };
}

async function createCampaign(rest: InstantlyRest, input: z.output<typeof CreateCampaignInput>) {
  await requireOwnMailbox(rest, input.eaccount);
  return rest("POST", "/campaigns", campaignBody(input.name, input));
}

/** The provider can store a body as blank (it drops one containing "&"), so read it back. */
async function requireSavedEmail(rest: InstantlyRest, campaignId: unknown) {
  if (firstEmail(await rest("GET", `/campaigns/${String(campaignId)}`))) return;
  throw new Error(
    "The mail service saved the email with a blank body; rewrite the body in plain words and save the steps again",
  );
}

type RoleBinding = {
  campaignId: string;
  campaignName: string;
  eaccount: string;
  leads: Record<string, { leadId: string; email: string; emailType?: "work" | "personal" }>;
  /** True only when this product created the campaign; adopted or older bindings never get copy. */
  created?: boolean;
};
const bindingKey = (serverId: string, roleId: string) =>
  `instantly-role-campaign:${serverId}:${roleId}`;

/** The recruiting role linked to this run's conversation, if any. */
async function activeRoleId(prisma: PrismaClient, context: AdapterContext) {
  if (!context.runId) return null;
  const run = await prisma.run.findFirst({
    where: { id: context.runId, spaceId: context.spaceId, userId: context.userId },
    select: { thread: { select: { activeRecruitingRoleId: true } } },
  });
  return run?.thread.activeRecruitingRoleId ?? null;
}

async function requireRole(prisma: PrismaClient, context: AdapterContext, roleId?: string) {
  const id = roleId ?? (await activeRoleId(prisma, context));
  if (!id) throw new Error("Pass role_id: this conversation has no linked recruiting role");
  const role = await prisma.recruitingRole.findFirst({
    where: { id, spaceId: context.spaceId, userId: context.userId },
    select: { id: true, title: true },
  });
  if (!role) throw new IsolationError("Recruiting role not found");
  return role;
}

/** The mailbox this space last bound a role campaign to on this Instantly connection. */
export async function lastUsedMailbox(
  prisma: Pick<PrismaClient, "externalEffect">,
  spaceId: string,
  serverId: string,
) {
  const effect = await prisma.externalEffect.findFirst({
    where: {
      spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      request: { path: ["serverId"], equals: serverId },
    },
    orderBy: { updatedAt: "desc" },
    select: { result: true },
  });
  const eaccount = (effect?.result as Partial<RoleBinding> | null)?.eaccount;
  return typeof eaccount === "string" ? eaccount : null;
}

/** Default sender: the last-used mailbox if still connected, else the first connected one. */
async function defaultMailbox(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
) {
  const accounts = await rest("GET", "/accounts?limit=100");
  const emails = (Array.isArray(accounts.items) ? (accounts.items as { email?: unknown }[]) : [])
    .map((item) => item.email)
    .filter((email): email is string => typeof email === "string");
  const last = await lastUsedMailbox(prisma, context.spaceId, serverId);
  const picked = emails.find((email) => last && sameAddress(email, last)) ?? emails[0];
  if (!picked) throw new Error("No Instantly mailbox is connected; connect one in Instantly first");
  return picked;
}
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const INSTANTLY_CAMPAIGN_STATUS: Record<number, string> = {
  0: "Draft",
  1: "Active",
  2: "Paused",
  3: "Completed",
};
export type InstantlyActivationDisplay = {
  campaignName: string | null;
  status: string | null;
  mailbox: string | null;
  recipients: {
    name: string | null;
    email: string;
    emailType?: "work" | "personal";
    personalization?: string;
  }[];
  /** null when the leads could not be read; the list itself is capped at 100. */
  recipientCount: number | null;
  stopOnReply: boolean | null;
  schedule: string | null;
  /** The first email; null when the campaign has none, omitted when it could not be read. */
  firstEmail?: { subject: string; body: string } | null;
};
export const EMPTY_ACTIVATION_DISPLAY: InstantlyActivationDisplay = {
  campaignName: null,
  status: null,
  mailbox: null,
  recipients: [],
  recipientCount: null,
  stopOnReply: null,
  schedule: null,
};
/** "Weekdays 09:00-17:00 America/Chicago" from Instantly's campaign_schedule, or null. */
function describeSchedule(campaign: Record<string, unknown> | undefined) {
  const schedules = (campaign?.campaign_schedule as { schedules?: unknown } | undefined)?.schedules;
  const first = Array.isArray(schedules) ? (schedules[0] as Record<string, unknown>) : undefined;
  if (!first) return null;
  const timing = first.timing as { from?: unknown; to?: unknown } | undefined;
  return (
    [
      typeof first.name === "string" ? first.name : null,
      typeof timing?.from === "string" && typeof timing.to === "string"
        ? `${timing.from}-${timing.to}`
        : null,
      typeof first.timezone === "string" ? first.timezone : null,
    ]
      .filter(Boolean)
      .join(" ") || null
  );
}
/** Role-campaign binding for a role, read without a run (approval cards, API). */
export async function readRoleCampaignBinding(
  prisma: Pick<PrismaClient, "externalEffect">,
  spaceId: string,
  serverId: string,
  roleId: string,
) {
  const effect = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: bindingKey(serverId, roleId) },
  });
  if (!effect || effect.spaceId !== spaceId || effect.status !== "completed") return null;
  const binding = effect.result as Partial<RoleBinding> | null;
  return typeof binding?.campaignId === "string" ? (binding as RoleBinding) : null;
}
/**
 * What the activate_campaign approval card shows: live name, status, lead count (up to 100) and
 * sending mailbox, read through the read-only native tools. Reads that fail leave fields null.
 */
export async function describeCampaignActivation(
  read: (
    tool: "native_instantly_get_campaign" | "native_instantly_list_leads",
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>,
  campaignId: string,
  fallbackMailbox: string | null = null,
  bindingLeads: RoleBinding["leads"] = {},
): Promise<InstantlyActivationDisplay> {
  const types = new Map(
    Object.values(bindingLeads).flatMap((lead) =>
      lead.emailType ? [[lead.email.toLowerCase(), lead.emailType] as const] : [],
    ),
  );
  const [campaign, leads] = await Promise.all([
    read("native_instantly_get_campaign", { campaign_id: campaignId }).catch(() => undefined),
    read("native_instantly_list_leads", { campaign_id: campaignId, limit: 100 }).catch(
      () => undefined,
    ),
  ]);
  const emails = Array.isArray(campaign?.email_list) ? campaign.email_list : [];
  const items = Array.isArray(leads?.items) ? (leads.items as Record<string, unknown>[]) : null;
  const recipients = (items ?? []).flatMap((lead) => {
    if (typeof lead.email !== "string") return [];
    const name = [lead.first_name, lead.last_name]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ");
    const emailType = types.get(lead.email.toLowerCase());
    const personalization =
      typeof lead.personalization === "string" && lead.personalization.trim()
        ? lead.personalization.trim()
        : undefined;
    return [
      {
        name: name || null,
        email: lead.email,
        ...(emailType ? { emailType } : {}),
        ...(personalization ? { personalization } : {}),
      },
    ];
  });
  return {
    campaignName: typeof campaign?.name === "string" ? campaign.name : null,
    status:
      typeof campaign?.status === "number"
        ? (INSTANTLY_CAMPAIGN_STATUS[campaign.status] ?? String(campaign.status))
        : null,
    mailbox: typeof emails[0] === "string" ? emails[0] : fallbackMailbox,
    recipients,
    recipientCount: items ? recipients.length : null,
    stopOnReply: typeof campaign?.stop_on_reply === "boolean" ? campaign.stop_on_reply : null,
    schedule: describeSchedule(campaign),
    ...(campaign ? { firstEmail: firstEmail(campaign) } : {}),
  };
}

export type InstantlyReplyDisplay = {
  to: string | null;
  from: string | null;
  subject: string;
  inReplyTo: string | null;
  body: string;
};
/** Vendor-free facts for the reply confirmation card; the original is read with the native get_email tool. */
export async function describeReplyToEmail(
  read: (
    tool: "native_instantly_get_email",
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>,
  args: Record<string, unknown>,
): Promise<InstantlyReplyDisplay> {
  const input = ReplyToEmailInput.safeParse(args);
  const original =
    input.success && typeof args.reply_to_uuid === "string"
      ? await read("native_instantly_get_email", { id: args.reply_to_uuid }).catch(() => undefined)
      : undefined;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  const originalSubject = text(original?.subject);
  const wanted = input.success ? input.data : undefined;
  return {
    to: text(original?.from_address_email),
    from: text(wanted?.eaccount) ?? text(original?.eaccount),
    subject:
      text(wanted?.subject) ??
      (originalSubject ? `Re: ${originalSubject.replace(/^(re:\s*)+/iu, "")}` : "unknown"),
    inReplyTo: original
      ? [originalSubject ?? "(no subject)", text(original.timestamp_email)]
          .filter(Boolean)
          .join(", ")
      : null,
    body: input.success ? input.data.body.text : "",
  };
}

async function readEmail(rest: InstantlyRest, id: string) {
  const email = await rest("GET", `/emails/${id}`);
  if (email.id !== id) throw new Error("The provider returned a different email");
  return email;
}

async function replyToEmail(rest: InstantlyRest, input: z.output<typeof ReplyToEmailInput>) {
  const original = await readEmail(rest, input.reply_to_uuid);
  const eaccount =
    input.eaccount ?? (typeof original.eaccount === "string" ? original.eaccount : "");
  if (!eaccount) throw new Error("The original email names no mailbox; pass eaccount");
  await requireOwnMailbox(rest, eaccount);
  if (typeof original.eaccount === "string" && !sameAddress(original.eaccount, eaccount))
    throw new Error(`${input.reply_to_uuid} is not in the ${eaccount} mailbox`);
  const subject =
    input.subject ??
    (typeof original.subject === "string" && original.subject.trim()
      ? `Re: ${original.subject.replace(/^(re:\s*)+/iu, "")}`
      : "Re:");
  return rest("POST", "/emails/reply", {
    reply_to_uuid: input.reply_to_uuid,
    eaccount,
    subject,
    body: input.body,
  });
}

async function readBinding(prisma: PrismaClient, context: AdapterContext, key: string) {
  const effect = await prisma.externalEffect.findUnique({ where: { idempotencyKey: key } });
  if (!effect) return undefined;
  if (effect.spaceId !== context.spaceId) throw new IsolationError();
  return { effect, binding: effect.result as RoleBinding };
}

async function ensureRoleCampaign(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  input: z.output<typeof EnsureRoleCampaignInput>,
) {
  const role = await requireRole(prisma, context, input.role_id);
  const key = bindingKey(serverId, role.id);
  const existing = await readBinding(prisma, context, key);
  let stale: string | null = null;
  if (existing) {
    const mappedId = existing.binding.campaignId;
    let campaign: Record<string, unknown> | null = null;
    try {
      campaign = await rest("GET", `/campaigns/${mappedId}`);
    } catch (error) {
      if (!(error instanceof InstantlyRestError && error.status === 404)) throw error;
    }
    // Repair: a deleted mapping, or an empty one beside a same-title campaign that has the leads.
    const better =
      campaign && (await hasLeads(rest, mappedId))
        ? undefined
        : (await sameTitleCampaigns(prisma, context, rest, role)).find(
            (entry) => entry.campaign.id !== mappedId && (!campaign || entry.leads),
          );
    if (campaign && !better) {
      const patched = campaign.stop_on_reply !== true;
      const current = firstEmail(campaign);
      // Copy goes only onto a campaign this product created: a draft (nothing sent yet) takes
      // replacement copy, a paused one only its first; an active one keeps what is sending, and an
      // adopted one keeps the copy someone else wrote.
      const writeSteps =
        Boolean(input.steps) &&
        existing.binding.created === true &&
        (campaign.status === DRAFT ||
          (ENROLLABLE.has(campaign.status as number) && current === null));
      // The provider edits only draft or paused campaigns, so a live one is paused for new hours.
      const pausedForHours = Boolean(input.send_hours) && campaign.status === ACTIVE;
      if (pausedForHours) await rest("POST", `/campaigns/${mappedId}/pause`);
      if (patched || writeSteps || input.send_hours)
        await rest("PATCH", `/campaigns/${mappedId}`, {
          ...(patched ? { stop_on_reply: true } : {}),
          ...(writeSteps ? { sequences: sequences(input.steps!) } : {}),
          ...(input.send_hours
            ? { campaign_schedule: campaignSchedule(input.send_hours, input.timezone) }
            : {}),
        });
      if (writeSteps) await requireSavedEmail(rest, mappedId);
      return {
        ...existing.binding,
        created: false,
        stopOnReplyPatched: patched,
        stepsSaved: writeSteps,
        ...(input.send_hours ? { sendHours: input.send_hours } : {}),
        ...(pausedForHours
          ? { paused: "Paused to change the hours; call activate_campaign to resume sending" }
          : {}),
        hasEmail: writeSteps || current !== null,
        ...(input.steps && !writeSteps
          ? {
              currentEmail: current,
              stepsNotSaved:
                "This campaign was not created here or is sending; its email is not changed",
            }
          : {}),
      };
    }
    stale = existing.effect.id;
    getLogger().info("instantly.role_campaign.repaired", {
      roleId: role.id,
      from: mappedId,
      reason: campaign ? "empty_mapped_campaign" : "mapped_campaign_missing",
      to: better ? String(better.campaign.id) : null,
    });
  }
  if (!context.runId) throw new IsolationError("A run is required to bind a role campaign");
  const eaccount =
    input.eaccount ??
    (stale ? existing!.binding.eaccount : await defaultMailbox(prisma, rest, context, serverId));
  // The user-visible name is the role title; the role id lives in the stored mapping's request.
  const name = role.title;
  const adopt = (await sameTitleCampaigns(prisma, context, rest, role)).find(
    (entry) => entry.campaign.id !== existing?.binding.campaignId,
  )?.campaign;
  const campaign = adopt ?? (await createCampaign(rest, { ...input, eaccount, name }));
  if (adopt && adopt.stop_on_reply !== true)
    await rest("PATCH", `/campaigns/${String(adopt.id)}`, { stop_on_reply: true });
  if (typeof campaign.id !== "string") throw new Error("Instantly returned no campaign id");
  const binding: RoleBinding = {
    campaignId: campaign.id,
    campaignName: typeof campaign.name === "string" ? campaign.name : name,
    eaccount,
    leads: {},
    created: !adopt,
  };
  if (stale)
    await prisma.externalEffect.update({
      where: { id: stale },
      data: { result: binding as unknown as Prisma.InputJsonValue },
    });
  else await recordBinding(prisma, context, key, role.id, serverId, binding);
  // Checked after binding, so a retry writes onto this campaign instead of adopting it.
  if (!adopt && input.steps) await requireSavedEmail(rest, campaign.id);
  return { created: !adopt, adopted: Boolean(adopt), ...binding };
}

// ponytail: no cross-request lock; two concurrent first calls can both create (the unique key
// keeps one binding and the retry adopts by name). Add an advisory lock if this ever races.
async function recordBinding(
  prisma: PrismaClient,
  context: AdapterContext,
  key: string,
  roleId: string,
  serverId: string,
  binding: RoleBinding,
) {
  await prisma.externalEffect.create({
    data: {
      spaceId: context.spaceId,
      runId: context.runId!,
      kind: "instantly_role_campaign",
      idempotencyKey: key,
      status: "completed",
      request: { roleId, serverId },
      result: binding as unknown as Prisma.InputJsonValue,
    },
  });
}

/** An unbound draft/paused campaign already made for this role: named "<title>…" or "…[role <id>]". */
async function hasLeads(rest: InstantlyRest, campaignId: unknown) {
  const leads = await rest("POST", "/leads/list", { campaign: campaignId, limit: 1 });
  return Array.isArray(leads.items) && leads.items.length > 0;
}

/**
 * Draft/paused campaigns titled exactly like the role (case-insensitive; a legacy " [role <id>]"
 * suffix is ignored), ordered best first: with leads, then newest.
 */
/**
 * Unbound campaigns named like the role, those with leads first. A campaign another role is already
 * bound to stays that role's: a test copy or a second role with the same title must never take over
 * (and add people to) a live campaign.
 */
async function sameTitleCampaigns(
  prisma: PrismaClient,
  context: AdapterContext,
  rest: InstantlyRest,
  role: { id: string; title: string },
) {
  const found = await rest("GET", `/campaigns?search=${encodeURIComponent(role.title)}&limit=100`);
  const title = role.title.trim().toLowerCase();
  const otherRoles = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      kind: "instantly_role_campaign",
      NOT: { request: { path: ["roleId"], equals: role.id } },
    },
    select: { result: true },
  });
  const boundElsewhere = new Set(
    otherRoles.map(({ result }) => (result as Partial<RoleBinding> | null)?.campaignId),
  );
  const matches = (Array.isArray(found.items) ? (found.items as Record<string, unknown>[]) : [])
    .filter(
      (campaign) =>
        typeof campaign.id === "string" &&
        !boundElsewhere.has(campaign.id) &&
        (campaign.status === 0 || campaign.status === 2) &&
        typeof campaign.name === "string" &&
        campaign.name.replace(` [role ${role.id}]`, "").trim().toLowerCase() === title,
    )
    .toSorted((a, b) =>
      String(b.timestamp_created ?? "").localeCompare(String(a.timestamp_created ?? "")),
    );
  const ranked = [];
  for (const campaign of matches)
    ranked.push({ campaign, leads: await hasLeads(rest, campaign.id) });
  return ranked.toSorted((a, b) => Number(b.leads) - Number(a.leads));
}

/** A campaign created inside a role conversation becomes that role's campaign if it has none. */
async function bindCreatedCampaign(
  prisma: PrismaClient,
  context: AdapterContext,
  serverId: string,
  campaign: Record<string, unknown>,
  eaccount: string,
) {
  if (!context.runId || typeof campaign.id !== "string") return;
  const roleId = await activeRoleId(prisma, context);
  if (!roleId) return;
  const key = bindingKey(serverId, roleId);
  if (await readBinding(prisma, context, key)) return;
  await recordBinding(prisma, context, key, roleId, serverId, {
    campaignId: campaign.id,
    campaignName: String(campaign.name ?? ""),
    eaccount,
    leads: {},
  });
}

/** Emails this account's contact lookups saved, by LinkedIn key, across its lookup connections. */
async function lookedUpEmails(prisma: PrismaClient, context: AdapterContext) {
  const servers = await prisma.mcpServer.findMany({
    where: {
      spaceId: context.spaceId,
      userId: context.userId,
      enabled: true,
      endpoint: "https://mcp.fullenrich.com/mcp",
    },
    select: { id: true, revision: true },
  });
  const found = new Map<string, FoundEmail[]>();
  for (const server of servers)
    for (const [key, emails] of await savedContactEmails(
      prisma,
      context,
      server,
      "native_find_emails",
    ))
      if (!found.has(key)) found.set(key, emails);
  return found;
}

async function addShortlistLeads(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  input: z.output<typeof AddShortlistLeadsInput>,
) {
  const role = await requireRole(prisma, context, input.role_id);
  // Out of the box: a role without a campaign gets one here instead of failing.
  if (!(await readBinding(prisma, context, bindingKey(serverId, role.id))))
    await ensureRoleCampaign(prisma, rest, context, serverId, {
      role_id: role.id,
      timezone: "America/Chicago",
    });
  const existing = await readBinding(prisma, context, bindingKey(serverId, role.id));
  if (!existing) throw new IsolationError("Role campaign binding missing after ensure");
  const { binding } = existing;
  // The send card is where the recruiter approves the recipients; the role's own people who are
  // not on hold or passed can be added without a shortlist bookmark first.
  const saved = await prisma.recruitingCandidate.findMany({
    where: {
      roleId: role.id,
      candidateKey: { in: input.candidates.map((candidate) => candidate.candidate_key) },
    },
    select: {
      candidateKey: true,
      consideration: true,
      occurrences: { select: { linkedinUrl: true } },
    },
  });
  // A person passed without an email gets the one this account's contact lookup already saved.
  const found = input.candidates.some((c) => !c.email)
    ? await lookedUpEmails(prisma, context)
    : new Map<string, FoundEmail[]>();
  const candidates = input.candidates.map((candidate) => {
    if (candidate.email) return candidate;
    const row = saved.find((entry) => entry.candidateKey === candidate.candidate_key);
    const keys = [candidate.candidate_key, ...(row?.occurrences ?? []).map((o) => o.linkedinUrl)]
      .map((value) => linkedinPersonKey(value))
      .filter((key): key is string => Boolean(key));
    const emails = keys.flatMap((key) => found.get(key) ?? []);
    const best = emails.find((email) => email.status === "DELIVERABLE") ?? emails[0];
    return best
      ? { ...candidate, email: best.address, email_type: candidate.email_type ?? best.type }
      : candidate;
  });
  const stopped = new Set(
    saved
      .filter((candidate) => {
        const operation = (candidate.consideration as { operation?: unknown } | null)?.operation;
        return operation === "hold" || operation === "pass";
      })
      .map((candidate) => candidate.candidateKey),
  );
  const inRole = new Set(saved.map((candidate) => candidate.candidateKey));
  const notInRole = candidates.filter((c) => !inRole.has(c.candidate_key));
  const onHoldOrPassed = candidates.filter((c) => stopped.has(c.candidate_key));
  const eligible = candidates.filter(
    (c) => inRole.has(c.candidate_key) && !stopped.has(c.candidate_key),
  );
  const missingEmail = eligible.filter((c) => !c.email);
  const withEmail = eligible.filter((c): c is typeof c & { email: string } => Boolean(c.email));
  const leads = { ...binding.leads };
  const already: string[] = [];
  let pending = withEmail;
  if (withEmail.length) {
    const listed = await rest("POST", "/leads/list", {
      campaign: binding.campaignId,
      contacts: withEmail.map((c) => c.email),
      limit: 100,
    });
    const items = (Array.isArray(listed.items) ? listed.items : []) as {
      id: string;
      email?: string | null;
    }[];
    pending = withEmail.filter((candidate) => {
      // Instantly stores lead emails case-insensitively; dedup the same way.
      const hit = items.find((lead) => lead.email?.toLowerCase() === candidate.email.toLowerCase());
      if (!hit) return true;
      leads[candidate.candidate_key] = {
        leadId: hit.id,
        email: candidate.email,
        ...(candidate.email_type ? { emailType: candidate.email_type } : {}),
      };
      already.push(candidate.candidate_key);
      return false;
    });
  }
  const added: string[] = [];
  let report: Record<string, unknown> | undefined;
  if (pending.length) {
    await requireEnrollable(rest, binding.campaignId);
    report = await rest("POST", "/leads/add", {
      campaign_id: binding.campaignId,
      skip_if_in_workspace: false,
      leads: pending.map(({ email, first_name, last_name, company_name, personalization }) => ({
        email,
        ...(first_name ? { first_name } : {}),
        ...(last_name ? { last_name } : {}),
        ...(company_name ? { company_name } : {}),
        ...(personalization ? { personalization } : {}),
      })),
    });
    for (const created of (report.created_leads ?? []) as { index: number; id: string }[]) {
      const candidate = pending[created.index];
      if (!candidate || typeof created.id !== "string") continue;
      leads[candidate.candidate_key] = {
        leadId: created.id,
        email: candidate.email,
        ...(candidate.email_type ? { emailType: candidate.email_type } : {}),
      };
      added.push(candidate.candidate_key);
    }
  }
  await prisma.externalEffect.update({
    where: { id: existing.effect.id },
    data: { result: { ...binding, leads } as unknown as Prisma.InputJsonValue },
  });
  return {
    campaignId: binding.campaignId,
    added,
    alreadyInCampaign: already,
    skippedMissingEmail: missingEmail.map((c) => c.candidate_key),
    notInRole: notInRole.map((c) => c.candidate_key),
    onHoldOrPassed: onHoldOrPassed.map((c) => c.candidate_key),
    notCreatedByProvider: pending
      .filter((c) => !added.includes(c.candidate_key))
      .map((c) => c.candidate_key),
    leads,
    ...(report ? { providerReport: report } : {}),
  };
}

/** Lead emails of a campaign (up to 100): who it sends to. */
async function leadEmails(rest: InstantlyRest, campaignId: string) {
  const leads = await rest("POST", "/leads/list", { campaign: campaignId, limit: 100 });
  return (Array.isArray(leads.items) ? leads.items : []).flatMap((lead) =>
    typeof (lead as { email?: unknown }).email === "string"
      ? [(lead as { email: string }).email]
      : [],
  );
}

export async function runInstantlyWrite(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  toolName: string,
  args: unknown,
): Promise<unknown> {
  switch (toolName) {
    case "native_instantly_create_campaign": {
      const input = CreateCampaignInput.parse(args);
      const campaign = await createCampaign(rest, input);
      await bindCreatedCampaign(prisma, context, serverId, campaign, input.eaccount);
      return campaign;
    }
    case "native_instantly_add_leads": {
      const input = AddLeadsInput.parse(args);
      await requireEnrollable(rest, input.campaign_id);
      return rest("POST", "/leads/add", input);
    }
    case "native_instantly_list_leads": {
      const input = ListLeadsInput.parse(args);
      if (!input.campaign_id && !input.email) throw new Error("Pass campaign_id and/or email");
      return rest("POST", "/leads/list", {
        ...(input.campaign_id ? { campaign: input.campaign_id } : {}),
        ...(input.email ? { contacts: [input.email] } : {}),
        limit: input.limit,
        ...(input.starting_after ? { starting_after: input.starting_after } : {}),
      });
    }
    case "native_instantly_get_campaign": {
      const campaign = await rest("GET", `/campaigns/${CampaignIdInput.parse(args).campaign_id}`);
      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        stop_on_reply: campaign.stop_on_reply,
        // email_list is the sending mailbox; recipients are the leads.
        sendingMailbox: campaign.email_list,
        recipients: await leadEmails(rest, String(campaign.id)),
        campaign_schedule: campaign.campaign_schedule,
        sequences: campaign.sequences,
      };
    }
    case "native_instantly_update_lead_interest":
      return rest("POST", "/leads/update-interest-status", UpdateLeadInterestInput.parse(args));
    case "native_instantly_activate_campaign": {
      const campaignId =
        ActivateCampaignInput.parse(args).campaign_id ??
        (
          await ensureRoleCampaign(prisma, rest, context, serverId, {
            timezone: "America/Chicago",
          })
        ).campaignId;
      if (!firstEmail(await rest("GET", `/campaigns/${campaignId}`)))
        throw new Error(
          "This campaign has no email yet; save the email with ensure_role_campaign steps, then activate again",
        );
      const campaign = await rest("POST", `/campaigns/${campaignId}/activate`);
      // The provider echoes the campaign, whose email_list is the sending mailbox, not recipients.
      return {
        activated: true,
        campaignId,
        sendingMailbox: Array.isArray(campaign.email_list) ? campaign.email_list : [],
        recipients: await leadEmails(rest, campaignId),
      };
    }
    case "native_instantly_pause_campaign":
      return rest("POST", `/campaigns/${CampaignIdInput.parse(args).campaign_id}/pause`);
    case "native_instantly_get_email":
      return readEmail(rest, EmailIdInput.parse(args).id);
    case "native_instantly_reply_to_email":
      return replyToEmail(rest, ReplyToEmailInput.parse(args));
    case "native_instantly_ensure_role_campaign":
      return ensureRoleCampaign(
        prisma,
        rest,
        context,
        serverId,
        EnsureRoleCampaignInput.parse(args),
      );
    case "native_instantly_add_shortlist_leads":
      return addShortlistLeads(prisma, rest, context, serverId, AddShortlistLeadsInput.parse(args));
    default:
      throw new IsolationError();
  }
}
