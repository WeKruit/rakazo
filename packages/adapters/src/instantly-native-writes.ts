import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import type { FoundEmail } from "./contact-lookup.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import { bestLookedUpEmail, lookedUpContactEmails } from "./recruiting-research.js";

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
const Recipients = z.array(z.string().trim().min(1).max(254)).min(1).max(100).optional();
const ActivateCampaignInput = z.strictObject({
  campaign_id: Uuid.optional().describe(
    "Omit inside a role conversation to activate the role's own campaign (created if needed).",
  ),
  recipients: Recipients.describe(
    "Only these people get the email: each one's email or name as added with add_shortlist_leads. Omit to send to everyone in the campaign.",
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
  recipients: Recipients.describe(
    "Save steps (one step: the first email written for them) as only these people's own email, each one's email or full name; a candidate of this role with a saved email who is not in the campaign yet is added first. Everyone else keeps the role's email.",
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
    "get_campaign_analytics",
    CampaignIdInput,
    true,
    "Reads sent, opened and replied counts for one exact campaign.",
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
    "Sends the campaign's first email by activating it (also resumes a paused one); the campaign needs its email saved first (ensure_role_campaign steps). This is the only way to send a campaign email; it shows the native confirmation card — call it and let the human confirm, do not refuse or ask for a thread. When the recruiter names who gets it, pass exactly those people as recipients: the card lists only them and nobody else in the campaign is emailed. Without recipients it sends to everyone in the campaign, and the card lists them all.",
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
    "Returns the one Instantly campaign bound to a recruiting role, creating it (draft, stop-on-reply on, default mailbox) only if none exists. Idempotent; needs no arguments inside a role conversation. Pass steps to save the email sequence on a campaign it created: a draft that has sent nothing takes new copy in place of the old, a paused one only its first; other copy is kept and comes back as currentEmail. hasEmail says whether the campaign has an email to send. Pass send_hours any_time when the recruiter wants it sent now or outside weekday 9-5. Pass recipients with one step to save an email written for those people as their own first email: activate_campaign with them as recipients then sends exactly it. Also returns candidate_key -> lead id mappings.",
  ),
  tool(
    "add_shortlist_leads",
    AddShortlistLeadsInput,
    false,
    "Adds the role's candidates the recruiter asked to contact to its campaign as leads (ensuring the campaign first); no shortlist is needed. Pass each person's email, email_type, first_name, company_name and personalization (their own opening line for {{personalization}} in the sequence); a person passed without an email gets the one an earlier contact lookup saved. Skips people with no email, on hold or passed for the role, or already in the campaign; records candidate_key -> lead id. When the campaign is already sending, the people are kept ready instead and are emailed only through activate_campaign with them as recipients.",
  ),
];
const TOOL_NAMES = new Set(nativeInstantlyWrites.map((entry) => entry.toolName));
export const isNativeInstantlyWrite = (toolName: string) => TOOL_NAMES.has(toolName);

export type InstantlyRest = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
// The provider lists no Pacific zone that keeps daylight saving (its America/Dawson is fixed
// UTC-7), so Pacific hours are scheduled in Mountain time, always exactly one hour ahead.
const PACIFIC_WEEKDAYS = "Weekdays (Pacific)";
const PACIFIC = new Set([
  "America/Los_Angeles",
  "America/Vancouver",
  "America/Tijuana",
  "US/Pacific",
]);

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
  return enrollable((await rest("GET", `/campaigns/${campaignId}`)).status);
}
function enrollable(status: unknown) {
  if (!ENROLLABLE.has(status as number))
    throw new Error(
      `Campaign status ${String(status)} is not draft/paused; pause it before adding leads, then activate it (confirmation required).`,
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

/**
 * One-person first emails. The role campaign keeps its one sequence, but once a person has their
 * own email its first step reads the lead's custom variables (POST /leads/add and PATCH
 * /leads/{id} `custom_variables`, kept in the lead's `payload`; {{name}} works in a subject and a
 * body). Each lead then holds its own first email, or the role's with its lead variables filled
 * in here, so no variable value relies on another variable. Follow-ups stay the role's.
 */
const OWN_SUBJECT = "rk_subject";
const OWN_BODY = "rk_body";
const TEMPLATE_VARIANT = { subject: `{{${OWN_SUBJECT}}}`, body: `<p>{{${OWN_BODY}}}</p>` };
type FirstEmail = { subject: string; body: string };
const isTemplated = (campaign: Record<string, unknown> | undefined) =>
  firstEmail(campaign)?.subject === TEMPLATE_VARIANT.subject;
/** The body as one paragraph's content: the template keeps the value inside its paragraph. */
const inlineHtml = (body: string) =>
  bodyHtml(body)
    .replace(/^<p>|<\/p>$/g, "")
    .replaceAll("</p><p>", "<br /><br />");
const emailVariables = (email: FirstEmail) => ({
  [OWN_SUBJECT]: email.subject.replace(/&/g, "＆"),
  [OWN_BODY]: inlineHtml(email.body),
});
const LEAD_VARIABLES: Record<
  string,
  "first_name" | "last_name" | "company_name" | "personalization"
> = {
  firstName: "first_name",
  first_name: "first_name",
  lastName: "last_name",
  last_name: "last_name",
  companyName: "company_name",
  company_name: "company_name",
  personalization: "personalization",
};
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** Refuses a role email whose variables cannot be filled in per person. */
function requireFillable(email: FirstEmail) {
  const unknown = [...`${email.subject} ${email.body}`.matchAll(VARIABLE)]
    .map((match) => match[1]!)
    .filter((name) => !LEAD_VARIABLES[name]);
  if (unknown.length)
    throw new Error(
      `The role's first email uses {{${unknown[0]}}}; use only {{firstName}}, {{lastName}}, {{companyName}} and {{personalization}} in it, then save again.`,
    );
}
const fillFor = (email: FirstEmail, person: Person): FirstEmail => {
  const fill = (value: string) =>
    value.replace(VARIABLE, (_, name: string) => {
      const field = LEAD_VARIABLES[name];
      return (field && text(person[field])) || "";
    });
  return { subject: fill(email.subject), body: fill(email.body) };
};
type Copy = Pick<RoleBinding, "roleEmail" | "drafts"> | null | undefined;
/** The first email a person in a templated campaign gets: their own, else the role's. */
function emailFor(binding: Copy, person: Person): FirstEmail | undefined {
  const own = binding?.drafts?.[person.email.toLowerCase()];
  if (own) return own;
  return binding?.roleEmail ? fillFor(binding.roleEmail, person) : undefined;
}
const variablesOf = (binding: Copy, person: Person) => {
  const email = emailFor(binding, person);
  return email ? emailVariables(email) : undefined;
};
const variablesFor = (binding: Copy, person: Person) => {
  const variables = variablesOf(binding, person);
  return variables ? { custom_variables: variables } : {};
};

function campaignSchedule(hours: "weekdays_9_to_5" | "any_time", zone: string) {
  const anyTime = hours === "any_time";
  const pacific = PACIFIC.has(zone);
  return {
    schedules: [
      {
        name: anyTime ? "Any time" : pacific ? PACIFIC_WEEKDAYS : "Weekdays",
        timing: anyTime
          ? { from: "00:00", to: "23:59" }
          : pacific
            ? { from: "10:00", to: "18:00" }
            : { from: "09:00", to: "17:00" },
        // ponytail: "1".."5" assumed Mon-Fri (docs do not define the day index); adjust in UI if off.
        days: { "0": anyTime, "1": true, "2": true, "3": true, "4": true, "5": true, "6": anyTime },
        timezone: pacific ? "America/Boise" : providerTimezone(zone),
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
  /** People added while the campaign was sending: not in it (not emailed) until a confirmed send. */
  staged?: Record<string, StagedLead>;
  /** The role's first email once its campaign reads lead variables (see TEMPLATE_VARIANT). */
  roleEmail?: FirstEmail;
  /** Each person's own first email, by lowercased address. */
  drafts?: Record<string, FirstEmail>;
};
type StagedLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  personalization?: string;
  emailType?: "work" | "personal";
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
    /** This person's own first email, when it is not the role's. */
    firstEmail?: FirstEmail;
  }[];
  /** null when the leads could not be read; the list itself is capped at 100. */
  recipientCount: number | null;
  stopOnReply: boolean | null;
  schedule: string | null;
  /** The first email; null when the campaign has none, omitted when it could not be read. */
  firstEmail?: { subject: string; body: string } | null;
  /** Why this send cannot be shown as exact recipients; no card is shown. */
  refusal?: string;
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
  if (first.name === PACIFIC_WEEKDAYS) return "Weekdays 09:00-17:00 Pacific time";
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
/** A campaign lead or a staged person, as one send would address them. */
type Person = StagedLead & {
  id?: string;
  /** The first email this lead's variables hold (subject and body HTML), when it has them. */
  saved?: Record<typeof OWN_SUBJECT | typeof OWN_BODY, string>;
  /** The provider has emailed this lead (Lead.timestamp_last_contact). */
  contacted?: boolean;
};
type SendPlan =
  /** Activate the campaign once `remove` (never-emailed people nobody named) are taken out. */
  | { send: "activate"; recipients: Person[]; remove: Person[] }
  /** Add these staged people to the already sending campaign: only they are newly emailed. */
  | { send: "enroll"; recipients: Person[] }
  | { refusal: string };

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const fullName = (person: Person) =>
  [person.first_name, person.last_name].filter((part) => text(part)).join(" ");
const label = (people: Person[]) =>
  people.map((person) => fullName(person) || person.email).join(", ");

function asPerson(lead: Record<string, unknown>): Person[] {
  if (typeof lead.email !== "string") return [];
  const fields = ["first_name", "last_name", "company_name", "personalization"] as const;
  const payload = (lead.payload ?? {}) as Record<string, unknown>;
  const subject = payload[OWN_SUBJECT];
  const body = payload[OWN_BODY];
  return [
    {
      email: lead.email,
      ...(typeof lead.id === "string" ? { id: lead.id } : {}),
      ...Object.fromEntries(
        fields.flatMap((key) => (text(lead[key]) ? [[key, text(lead[key])]] : [])),
      ),
      ...(text(subject) && text(body)
        ? { saved: { [OWN_SUBJECT]: String(subject), [OWN_BODY]: String(body) } }
        : {}),
      ...(lead.timestamp_last_contact ? { contacted: true } : {}),
    },
  ];
}

/** One requested recipient: an exact email, else the one person with that full or first name. */
function matchRecipient(people: Person[], wanted: string) {
  const value = wanted.trim().toLowerCase();
  for (const pick of [
    (person: Person) => person.email.toLowerCase() === value,
    (person: Person) =>
      fullName(person).toLowerCase() === value || person.first_name?.toLowerCase() === value,
  ]) {
    const hits = people.filter(pick);
    if (hits.length) return hits.length === 1 ? hits[0] : undefined;
  }
  return undefined;
}

/**
 * Who one activate_campaign call emails, decided the same way for the card and for the send.
 * Only a draft (never activated, so nobody in it was approved or emailed) may have unnamed people
 * taken out; a campaign that has run keeps everyone and is resumed only when nobody else is in it.
 */
function planSend(
  status: unknown,
  leads: Person[],
  staged: Person[],
  wanted?: string[],
  templated = false,
  copy: Copy = null,
): SendPlan {
  const plan = planRecipients(status, leads, staged, wanted);
  if ("refusal" in plan || !templated) return plan;
  // A templated first email is in each person's variables: nobody goes out without one.
  const blank = plan.recipients.filter((person) =>
    leads.includes(person) ? !person.saved : !emailFor(copy, person),
  );
  return blank.length
    ? {
        refusal: `No first email is saved for ${label(blank)}, so nothing was sent. Save the role's email with ensure_role_campaign steps, or their own with steps and recipients, then call activate_campaign again.`,
      }
    : plan;
}
function planRecipients(
  status: unknown,
  leads: Person[],
  staged: Person[],
  wanted?: string[],
): SendPlan {
  const pending =
    status === ACTIVE
      ? staged.filter((s) => !leads.some((l) => sameAddress(l.email, s.email)))
      : [];
  if (!wanted)
    return pending.length
      ? { send: "enroll", recipients: pending }
      : { send: "activate", recipients: leads, remove: [] };
  const chosen: Person[] = [];
  const unmatched: string[] = [];
  for (const entry of wanted) {
    const hit = matchRecipient([...leads, ...pending], entry);
    if (!hit) unmatched.push(entry);
    else if (!chosen.includes(hit)) chosen.push(hit);
  }
  if (unmatched.length)
    return {
      refusal: `Not in this campaign, or more than one person matches: ${unmatched.join(", ")}. Add each person with add_shortlist_leads, then call activate_campaign again with their emails as recipients.`,
    };
  const others = leads.filter((lead) => !chosen.includes(lead));
  if (status === DRAFT) return { send: "activate", recipients: chosen, remove: others };
  if (status === ACTIVE) {
    const sending = chosen.filter((person) => leads.includes(person));
    return sending.length
      ? {
          refusal: `Already in this campaign, which is sending, so nothing new goes to: ${label(sending)}.`,
        }
      : { send: "enroll", recipients: chosen };
  }
  return others.length
    ? {
        refusal: `This campaign has already run; resuming it would also email ${label(others)}, so nothing was sent. Ask the recruiter whether to resume it for everyone in it.`,
      }
    : { send: "activate", recipients: chosen, remove: [] };
}

/** A lead as /leads/add takes it; a templated campaign also gets its first email's variables. */
const newLead = (person: Person, copy: Copy | false) => ({
  email: person.email,
  ...(person.first_name ? { first_name: person.first_name } : {}),
  ...(person.last_name ? { last_name: person.last_name } : {}),
  ...(person.company_name ? { company_name: person.company_name } : {}),
  ...(person.personalization ? { personalization: person.personalization } : {}),
  ...(copy === false ? {} : variablesFor(copy, person)),
});
const stagedPeople = (binding: Pick<RoleBinding, "staged"> | null | undefined): Person[] =>
  Object.values(binding?.staged ?? {});

/**
 * What the activate_campaign approval card shows: live name, status, the people this call would
 * email (up to 100 leads read) and sending mailbox, read through the read-only native tools. Reads
 * that fail leave fields null; a send to named people that cannot be read or made exact is refused.
 */
export async function describeCampaignActivation(
  read: (
    tool: "native_instantly_get_campaign" | "native_instantly_list_leads",
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>,
  campaignId: string,
  fallbackMailbox: string | null = null,
  binding: Pick<RoleBinding, "leads" | "staged" | "roleEmail" | "drafts"> | null = null,
  wanted?: string[],
): Promise<InstantlyActivationDisplay> {
  const types = new Map(
    [...Object.values(binding?.leads ?? {}), ...stagedPeople(binding)].flatMap((lead) =>
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
  const templated = isTemplated(campaign);
  const people = (items ?? []).flatMap(asPerson);
  const plan =
    campaign && items
      ? planSend(campaign.status, people, stagedPeople(binding), wanted, templated, binding)
      : wanted
        ? { refusal: "This campaign could not be read, so nothing was sent; try again." }
        : { send: "activate" as const, recipients: people, remove: [] };
  let roleCopyShown = false;
  const recipients = ("refusal" in plan ? [] : plan.recipients).map((person) => {
    const emailType = types.get(person.email.toLowerCase());
    // A lead's own variables are what is sent; a person not yet added gets what the send adds.
    const own = !templated
      ? undefined
      : people.includes(person)
        ? person.saved
        : variablesOf(binding, person);
    const role = binding?.roleEmail && emailVariables(fillFor(binding.roleEmail, person));
    const theirs =
      own && (!role || own[OWN_SUBJECT] !== role[OWN_SUBJECT] || own[OWN_BODY] !== role[OWN_BODY])
        ? { subject: own[OWN_SUBJECT], body: own[OWN_BODY] }
        : undefined;
    if (!theirs) roleCopyShown = true;
    return {
      name: fullName(person) || null,
      email: person.email,
      ...(emailType ? { emailType } : {}),
      ...(person.personalization && !theirs ? { personalization: person.personalization } : {}),
      ...(theirs ? { firstEmail: theirs } : {}),
    };
  });
  // A templated campaign's own step is variables: the card shows the role's email instead, and
  // only when someone on it gets that email.
  const shownEmail = !campaign
    ? {}
    : !templated
      ? { firstEmail: firstEmail(campaign) }
      : binding?.roleEmail
        ? roleCopyShown
          ? {
              firstEmail: {
                subject: binding.roleEmail.subject,
                body: bodyHtml(binding.roleEmail.body),
              },
            }
          : {}
        : recipients.length && !roleCopyShown
          ? {}
          : { firstEmail: null };
  return {
    ...("refusal" in plan ? { refusal: plan.refusal } : {}),
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
    ...shownEmail,
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

/** The recruiter reviews the emails in chat, never only as a saved sequence. */
const SHOW_SAVED_STEPS =
  "In your reply, show the recruiter every saved email as Subject: and its full body, written out for the first person (their name and company in place of the variables); the saved sequence keeps its variables.";

async function ensureRoleCampaign(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  input: z.output<typeof EnsureRoleCampaignInput>,
  /** People this call already added for its recipients; set only on the retry after adding. */
  added?: string[],
): Promise<{ campaignId: string } & Record<string, unknown>> {
  const role = await requireRole(prisma, context, input.role_id);
  const key = bindingKey(serverId, role.id);
  // Named recipients who are this role's saved candidates are added first, as add_shortlist_leads
  // would, and the email is then saved for them; only people who cannot be told apart stop it.
  const addThenSave = async (unmatched: string[]) => {
    if (added) throw new Error(notFound(unmatched));
    const people = await addSavedRecipients(prisma, rest, context, serverId, role.id, unmatched);
    return ensureRoleCampaign(prisma, rest, context, serverId, input, people);
  };
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
      if (input.recipients) {
        const saved = await saveOwnEmail(prisma, rest, existing, campaign, input);
        if (saved.unmatched) return addThenSave(saved.unmatched);
        return added?.length ? { ...saved, addedToCampaign: added } : saved;
      }
      const patched = campaign.stop_on_reply !== true;
      const current = firstEmail(campaign);
      const templated = isTemplated(campaign);
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
      // A campaign that reads lead variables keeps doing so: the new role email goes into the
      // variables of everyone without their own email.
      if (writeSteps && templated) requireFillable(input.steps![0]!);
      if (pausedForHours) await rest("POST", `/campaigns/${mappedId}/pause`);
      if (patched || writeSteps || input.send_hours)
        await rest("PATCH", `/campaigns/${mappedId}`, {
          ...(patched ? { stop_on_reply: true } : {}),
          ...(writeSteps
            ? {
                sequences: templated
                  ? withTemplate(sequences(input.steps!)[0]!.steps)
                  : sequences(input.steps!),
              }
            : {}),
          ...(input.send_hours
            ? { campaign_schedule: campaignSchedule(input.send_hours, input.timezone) }
            : {}),
        });
      if (writeSteps) await requireSavedEmail(rest, mappedId);
      if (writeSteps && templated) {
        const { subject, body } = input.steps![0]!;
        existing.binding = { ...existing.binding, roleEmail: { subject, body } };
        await prisma.externalEffect.update({
          where: { id: existing.effect.id },
          data: { result: existing.binding as unknown as Prisma.InputJsonValue },
        });
        for (const lead of await allLeads(rest, mappedId))
          if (lead.id && !existing.binding.drafts?.[lead.email.toLowerCase()])
            await rest("PATCH", `/leads/${lead.id}`, {
              custom_variables: variablesOf(existing.binding, lead),
            });
      }
      const shown = templated ? (existing.binding.roleEmail ?? null) : current;
      return {
        ...existing.binding,
        created: false,
        stopOnReplyPatched: patched,
        stepsSaved: writeSteps,
        ...(input.send_hours ? { sendHours: input.send_hours } : {}),
        ...(pausedForHours
          ? { paused: "Paused to change the hours; call activate_campaign to resume sending" }
          : {}),
        hasEmail: writeSteps || shown !== null,
        ...(writeSteps ? { next: SHOW_SAVED_STEPS } : {}),
        ...(input.steps && !writeSteps
          ? {
              currentEmail: shown,
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
  if (input.recipients) return addThenSave(input.recipients);
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
  return {
    created: !adopt,
    adopted: Boolean(adopt),
    ...binding,
    ...(!adopt && input.steps ? { next: SHOW_SAVED_STEPS } : {}),
  };
}

/** The live sequence's steps as a PATCH sends them back. */
function liveSteps(campaign: Record<string, unknown>) {
  const list = Array.isArray(campaign.sequences) ? campaign.sequences : [];
  const steps = (list[0] as { steps?: unknown } | undefined)?.steps;
  return (Array.isArray(steps) ? (steps as Record<string, unknown>[]) : []).map((step) => ({
    type: "email",
    delay: typeof step.delay === "number" ? step.delay : 0,
    delay_unit: typeof step.delay_unit === "string" ? step.delay_unit : "days",
    variants: (Array.isArray(step.variants)
      ? (step.variants as Record<string, unknown>[])
      : []
    ).map((variant) => ({
      subject: variant.subject,
      body: variant.body,
      ...(typeof variant.v_disabled === "boolean" ? { v_disabled: variant.v_disabled } : {}),
    })),
  }));
}
/** The sequence with its first step reading lead variables; later steps keep their copy. */
function withTemplate(steps: { delay: unknown; delay_unit?: unknown; variants: unknown[] }[]) {
  const [first, ...later] = steps;
  return [
    {
      steps: [
        {
          type: "email",
          delay: first?.delay ?? 0,
          delay_unit: first?.delay_unit ?? "days",
          variants: [TEMPLATE_VARIANT],
        },
        ...later,
      ],
    },
  ];
}

const notFound = (people: string[]) =>
  `Nothing was saved: ${people.join(", ")} is not one of this role's candidates with a saved email, or more than one person matches. Ask the recruiter one question: which person they mean, by full name or email.`;

/**
 * Adds the named people who are this role's saved candidates to its campaign the way
 * add_shortlist_leads does (a sending campaign keeps them ready instead). A name or email that
 * matches no candidate, or more than one, is refused with one question for the recruiter.
 */
async function addSavedRecipients(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  roleId: string,
  wanted: string[],
) {
  const rows = await prisma.recruitingCandidate.findMany({
    where: { roleId },
    select: {
      candidateKey: true,
      occurrences: { select: { name: true, company: true, linkedinUrl: true } },
    },
  });
  const found = await lookedUpContactEmails(prisma, context);
  const people = rows.map((row) => {
    const name = row.occurrences.map((o) => text(o.name)).find(Boolean) ?? "";
    const profiles = [row.candidateKey, ...row.occurrences.map((o) => o.linkedinUrl)];
    const emails = [...new Set(profiles.map((value) => linkedinPersonKey(value)))]
      .filter((key): key is string => Boolean(key))
      .flatMap((key) => found.get(key) ?? []);
    return {
      key: row.candidateKey,
      name,
      company: row.occurrences.map((o) => text(o.company)).find(Boolean),
      emails,
      best: bestLookedUpEmail(found, ...profiles),
    };
  });
  const unknown: string[] = [];
  const noEmail: string[] = [];
  const candidates: z.output<typeof AddShortlistLeadsInput>["candidates"] = [];
  for (const entry of wanted) {
    const value = entry.trim().toLowerCase();
    const byEmail = people.filter((p) => p.emails.some((e) => sameAddress(e.address, value)));
    const byName = people.filter((p) => p.name.toLowerCase() === value);
    const byFirst = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === value);
    const hits = value.includes("@") ? byEmail : byName.length ? byName : byFirst;
    const person = hits.length === 1 ? hits[0]! : undefined;
    const email = value.includes("@")
      ? person?.emails.find((e) => sameAddress(e.address, value))
      : person?.best;
    if (!person) unknown.push(entry);
    else if (!email) noEmail.push(person.name || entry);
    else if (!candidates.some((c) => c.candidate_key === person.key)) {
      const [first, ...last] = person.name.split(/\s+/).filter(Boolean);
      candidates.push({
        candidate_key: person.key,
        email: email.address,
        email_type: email.type,
        ...(first ? { first_name: first } : {}),
        ...(last.length ? { last_name: last.join(" ") } : {}),
        ...(person.company ? { company_name: person.company } : {}),
      });
    }
  }
  if (noEmail.length)
    throw new Error(
      `Nothing was saved: ${noEmail.join(", ")} has no saved email yet. Find their email with find_emails, then save their email again with the same recipients.`,
    );
  if (unknown.length) throw new Error(notFound(unknown));
  const out = await addShortlistLeads(prisma, rest, context, serverId, {
    role_id: roleId,
    candidates,
  });
  const stopped = candidates.filter((c) => out.onHoldOrPassed.includes(c.candidate_key));
  if (stopped.length)
    throw new Error(
      `Nothing was saved: ${stopped.map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email).join(", ")} is on hold or passed for this role. Ask the recruiter one question: take them off hold and email them, or leave them out?`,
    );
  return candidates.map((c) => c.email!);
}

const askAbout = (who: string, why: string) =>
  `${who}'s own email was not saved and nothing was sent: ${why}. Ask the recruiter one question: send ${who} the role's saved email instead, or keep this email unsent?`;

/**
 * Saves one email as the first email of only the named people. A campaign whose sequence still
 * holds the role's text switches to variables only while it is a draft nobody was emailed from,
 * so nobody already approved or emailed gets different copy; a person already emailed, or in a
 * campaign that is sending, keeps the email they have.
 */
async function saveOwnEmail(
  prisma: PrismaClient,
  rest: InstantlyRest,
  existing: { effect: { id: string }; binding: RoleBinding },
  campaign: Record<string, unknown>,
  input: z.output<typeof EnsureRoleCampaignInput>,
) {
  const [own, ...more] = input.steps ?? [];
  if (!own || more.length)
    throw new Error(
      "With recipients, pass exactly one step: the first email written for them, with its subject and full body.",
    );
  if (/\{\{/.test(`${own.subject} ${own.body}`))
    throw new Error("Write their own email out in full, without {{variables}}, then save again.");
  const { binding } = existing;
  const leads = await allLeads(rest, binding.campaignId);
  const waiting = stagedPeople(binding).filter(
    (person) => !leads.some((lead) => sameAddress(lead.email, person.email)),
  );
  const chosen: Person[] = [];
  const unmatched: string[] = [];
  for (const entry of input.recipients!) {
    const hit = matchRecipient([...leads, ...waiting], entry);
    if (!hit) unmatched.push(entry);
    else if (!chosen.includes(hit)) chosen.push(hit);
  }
  if (unmatched.length) return { unmatched };
  const who = label(chosen);
  if (binding.created !== true)
    throw new Error(askAbout(who, "this role's campaign was set up outside this product"));
  const templated = isTemplated(campaign);
  if (!templated && (campaign.status !== DRAFT || leads.some((lead) => lead.contacted)))
    throw new Error(
      askAbout(
        who,
        "this role's emails have already gone out, and its first email cannot become one person's own without changing it for people already approved",
      ),
    );
  const emailed = chosen.filter(
    (person) =>
      leads.includes(person) &&
      (person.contacted ||
        campaign.status === ACTIVE ||
        !ENROLLABLE.has(campaign.status as number)),
  );
  if (emailed.length)
    throw new Error(
      askAbout(label(emailed), "they are already getting this role's emails, which stay as sent"),
    );
  const next: RoleBinding = {
    ...binding,
    drafts: {
      ...binding.drafts,
      ...Object.fromEntries(
        chosen.map((person) => [
          person.email.toLowerCase(),
          { subject: own.subject, body: own.body },
        ]),
      ),
    },
  };
  const current = firstEmail(campaign);
  if (!templated && current) {
    requireFillable(current);
    next.roleEmail = current;
  }
  // Variables before the sequence: if the switch then fails, the campaign keeps its own copy.
  for (const lead of templated ? chosen.filter((person) => leads.includes(person)) : leads)
    if (lead.id && emailFor(next, lead))
      await rest("PATCH", `/leads/${lead.id}`, { custom_variables: variablesOf(next, lead) });
  await prisma.externalEffect.update({
    where: { id: existing.effect.id },
    data: { result: next as unknown as Prisma.InputJsonValue },
  });
  if (!templated) {
    await rest("PATCH", `/campaigns/${binding.campaignId}`, {
      sequences: withTemplate(liveSteps(campaign)),
    });
    if (!isTemplated(await rest("GET", `/campaigns/${binding.campaignId}`)))
      throw new Error("The mail service did not save the email, and nothing was sent; try again.");
  }
  return {
    campaignId: binding.campaignId,
    ownEmailSavedFor: chosen.map((person) => person.email),
    next: "Saved as only their first email; everyone else keeps the role's email. To send it, call activate_campaign with them as recipients; its card shows this email for them.",
  };
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
    ? await lookedUpContactEmails(prisma, context)
    : new Map<string, FoundEmail[]>();
  const candidates = input.candidates.map((candidate) => {
    if (candidate.email) return candidate;
    const row = saved.find((entry) => entry.candidateKey === candidate.candidate_key);
    const best = bestLookedUpEmail(
      found,
      candidate.candidate_key,
      ...(row?.occurrences ?? []).map((o) => o.linkedinUrl),
    );
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
  const staged = { ...binding.staged };
  const ready: string[] = [];
  let report: Record<string, unknown> | undefined;
  // Adding to a sending campaign would email them at once, so they wait for the send card.
  const live = pending.length ? await rest("GET", `/campaigns/${binding.campaignId}`) : undefined;
  const status = live?.status;
  const templated = isTemplated(live);
  if (status === ACTIVE)
    for (const { candidate_key, email, email_type, ...fields } of pending) {
      staged[candidate_key] = {
        email,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => text(value))),
        ...(email_type ? { emailType: email_type } : {}),
      };
      ready.push(candidate_key);
    }
  else if (pending.length) {
    enrollable(status);
    report = await rest("POST", "/leads/add", {
      campaign_id: binding.campaignId,
      skip_if_in_workspace: false,
      leads: pending.map((candidate) => newLead(candidate, templated && binding)),
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
    data: {
      result: {
        ...binding,
        leads,
        ...(Object.keys(staged).length ? { staged } : {}),
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return {
    campaignId: binding.campaignId,
    added,
    ...(ready.length
      ? {
          readyToSend: ready,
          next: "The campaign is already sending, so these people were not added and nothing was sent. To email them, call activate_campaign with their emails as recipients.",
        }
      : {}),
    alreadyInCampaign: already,
    skippedMissingEmail: missingEmail.map((c) => c.candidate_key),
    notInRole: notInRole.map((c) => c.candidate_key),
    onHoldOrPassed: onHoldOrPassed.map((c) => c.candidate_key),
    notCreatedByProvider: pending
      .filter((c) => !added.includes(c.candidate_key) && !ready.includes(c.candidate_key))
      .map((c) => c.candidate_key),
    leads,
    ...(report ? { providerReport: report } : {}),
  };
}

/** Every lead of a campaign, paged; a send never acts on a partial list. */
async function allLeads(rest: InstantlyRest, campaignId: string) {
  const people: Person[] = [];
  let after: unknown;
  for (let page = 0; page < 10; page++) {
    const listed = await rest("POST", "/leads/list", {
      campaign: campaignId,
      limit: 100,
      ...(typeof after === "string" ? { starting_after: after } : {}),
    });
    const items = Array.isArray(listed.items) ? (listed.items as Record<string, unknown>[]) : [];
    people.push(...items.flatMap(asPerson));
    after = listed.next_starting_after;
    if (items.length < 100 || typeof after !== "string" || !after) return people;
  }
  throw new Error("This campaign has more than 1,000 people; nothing was sent");
}

/** The active role's binding when it is bound to this campaign. */
async function bindingOfCampaign(
  prisma: PrismaClient,
  context: AdapterContext,
  serverId: string,
  campaignId: string,
) {
  const roleId = await activeRoleId(prisma, context);
  const existing = roleId ? await readBinding(prisma, context, bindingKey(serverId, roleId)) : null;
  return existing?.binding.campaignId === campaignId ? existing : null;
}

/**
 * Sends exactly the planned recipients (see planSend): a draft loses the never-emailed people
 * nobody named, and is activated only after a re-read shows exactly the named people remain; a
 * sending campaign gets only the named staged people added. Nobody else is emailed by this call.
 */
async function activateCampaign(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  input: z.output<typeof ActivateCampaignInput>,
) {
  const campaignId =
    input.campaign_id ??
    (await ensureRoleCampaign(prisma, rest, context, serverId, { timezone: "America/Chicago" }))
      .campaignId;
  const campaign = await rest("GET", `/campaigns/${campaignId}`);
  if (!firstEmail(campaign))
    throw new Error(
      "This campaign has no email yet; save the email with ensure_role_campaign steps, then activate again",
    );
  const bound = await bindingOfCampaign(prisma, context, serverId, campaignId);
  const leads = await allLeads(rest, campaignId);
  const templated = isTemplated(campaign);
  const plan = planSend(
    campaign.status,
    leads,
    stagedPeople(bound?.binding),
    input.recipients,
    templated,
    bound?.binding,
  );
  if ("refusal" in plan) throw new Error(plan.refusal);
  const sendingMailbox = Array.isArray(campaign.email_list) ? campaign.email_list : [];
  const save = async (binding: RoleBinding) => {
    if (bound)
      await prisma.externalEffect.update({
        where: { id: bound.effect.id },
        data: { result: binding as unknown as Prisma.InputJsonValue },
      });
  };
  if (plan.send === "enroll") {
    // Adding a lead to a sending campaign sends to that lead; nobody else is touched.
    const report = await rest("POST", "/leads/add", {
      campaign_id: campaignId,
      skip_if_in_workspace: false,
      leads: plan.recipients.map((person) => newLead(person, templated && bound?.binding)),
    });
    const sent: string[] = [];
    if (bound) {
      const binding = { ...bound.binding, leads: { ...bound.binding.leads } };
      const staged = { ...binding.staged };
      for (const created of (report.created_leads ?? []) as { index: number; id: string }[]) {
        const person = plan.recipients[created.index];
        if (!person || typeof created.id !== "string") continue;
        sent.push(person.email);
        for (const [key, entry] of Object.entries(staged))
          if (sameAddress(entry.email, person.email)) {
            binding.leads[key] = {
              leadId: created.id,
              email: entry.email,
              ...(entry.emailType ? { emailType: entry.emailType } : {}),
            };
            delete staged[key];
          }
      }
      await save({ ...binding, staged });
    } else
      for (const created of (report.created_leads ?? []) as { index: number }[])
        if (plan.recipients[created.index]) sent.push(plan.recipients[created.index]!.email);
    return {
      sent: sent.length > 0,
      campaignId,
      sendingMailbox,
      recipients: sent,
      notCreatedByProvider: plan.recipients
        .filter((person) => !sent.includes(person.email))
        .map((person) => person.email),
    };
  }
  if (plan.remove.length) {
    const removed: string[] = [];
    try {
      for (const lead of plan.remove) {
        if (!lead.id) throw new Error(`No lead id for ${lead.email}; nothing was sent`);
        await rest("DELETE", `/leads/${lead.id}`);
        removed.push(lead.email);
      }
    } finally {
      // Taken out of the campaign and the role's lead map, so a later send adds them again.
      if (bound && removed.length)
        await save({
          ...bound.binding,
          leads: Object.fromEntries(
            Object.entries(bound.binding.leads).filter(
              ([, lead]) => !removed.some((email) => sameAddress(email, lead.email)),
            ),
          ),
        });
    }
    const remaining = await allLeads(rest, campaignId);
    const exact =
      remaining.length === plan.recipients.length &&
      remaining.every((lead) => plan.recipients.some((p) => sameAddress(p.email, lead.email)));
    if (!exact)
      throw new Error(
        "The campaign's people changed while preparing the send, so nothing was sent; call activate_campaign again",
      );
  }
  const activated = await rest("POST", `/campaigns/${campaignId}/activate`);
  // The provider echoes the campaign, whose email_list is the sending mailbox, not recipients.
  return {
    activated: true,
    campaignId,
    sendingMailbox: Array.isArray(activated.email_list) ? activated.email_list : sendingMailbox,
    recipients: plan.recipients.map((person) => person.email),
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
    case "native_instantly_get_campaign_analytics":
      return rest(
        "GET",
        `/campaigns/analytics/overview?id=${CampaignIdInput.parse(args).campaign_id}`,
      );
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
    case "native_instantly_activate_campaign":
      return activateCampaign(prisma, rest, context, serverId, ActivateCampaignInput.parse(args));
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
