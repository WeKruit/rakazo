import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { MailReplyErrorCode } from "@rakazo/contracts";
import { MailReplyErrorCodeSchema } from "@rakazo/contracts";
import {
  greetsByName,
  INSTANTLY_MCP_ENDPOINT,
  NAMED_GREETING_NOTE,
  PLACEHOLDER_NOTE,
  signedAsTeam,
  TEAM_SIGNATURE_NOTE,
  unfilledPlaceholder,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import type { FoundEmail } from "./contact-lookup.js";
import {
  adoptAssignedSenders,
  adoptLegacySender,
  confirmedSendingMailbox,
  confirmedSendingMailboxes,
  defaultSendingMailbox,
  EnsureSenderInput,
  ensureSendingIdentity,
  requireSendingMailboxReady,
  sendingMailboxState,
} from "./instantly-senders.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import { campaignObservedDetails } from "./recruiting-campaign-details.js";
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
  subject: z
    .string()
    .min(1)
    .max(500)
    .refine((subject) => !unfilledPlaceholder(subject), PLACEHOLDER_NOTE),
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe('Plain text: a blank line between paragraphs, "• " to start a bullet.')
    .refine((body) => !signedAsTeam(body), TEAM_SIGNATURE_NOTE)
    .refine((body) => !unfilledPlaceholder(body), PLACEHOLDER_NOTE),
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
    .describe(
      "When emails may go out; a campaign sends as soon as the recruiter confirms (any_time) unless they ask for weekdays_9_to_5.",
    ),
};
const CreateCampaignInput = z.strictObject({
  name: z.string().min(1).max(200),
  ...CampaignSetup,
  // Everyone added to a new campaign gets its email, so a name written into the greeting is wrong
  // for all but one of them (ensure_role_campaign's per-person email keeps its own schema).
  steps: CampaignSetup.steps.refine(
    (steps) => !steps?.some((step) => greetsByName(step.body)),
    NAMED_GREETING_NOTE,
  ),
});
const RoleDraftInput = CreateCampaignInput.extend({ role_id: z.string().min(1).max(100) });
const CloneRoleDraftInput = z.strictObject({
  client_nonce: z.string().min(1).max(200),
  role_id: z.string().min(1).max(100),
  campaign_id: Uuid,
  name: z.string().trim().min(1).max(200),
});
const CreateRoleDraftInput = RoleDraftInput.extend({ client_nonce: z.string().min(1).max(200) });
const UpdateRoleDraftInput = RoleDraftInput.extend({
  campaign_id: Uuid,
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
});
const ReadRoleDraftInput = z.strictObject({
  role_id: z.string().min(1).max(100),
  campaign_id: Uuid.optional(),
});
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
  send_now: z
    .boolean()
    .optional()
    .describe(
      "Send everyone already queued in this sending campaign now instead of waiting for its sending hours or the gap between emails (recipients are ignored). Its card lists who is queued.",
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
    "Change when emails may go out; a sending campaign keeps sending in the new hours.",
  ),
  recipients: Recipients.describe(
    "Save steps (one step: the first email written for them) as only these people's own email, each one's email or full name; a candidate of this role with a saved email, or an email the recruiter typed for someone not in Results, who is not in the campaign yet is added first. Everyone else keeps the role's email.",
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
  check_sender: z
    .boolean()
    .optional()
    .describe(
      "Read-only check that this exact email can be replied to from its current sending mailbox.",
    ),
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
  cc_address_email_list: z
    .string()
    .max(10_000)
    .refine((value) => !/[\r\n\0]/.test(value))
    .optional(),
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
    "ensure_sender",
    EnsureSenderInput,
    false,
    "Read this account's confirmed sending identity, propose an available address on an existing product sending domain without purchasing, or confirm the proposal. Always call read first and do what it returns. Also call read when asked to send from the recruiter's own email without a send_message tool, and answer with its next; never ask them to connect or reconnect their email. Only when read returns selfSetup true with no sender, ask the company name on one native question card, then call propose. Call confirm with that exact email and display_name: the tool's native Create address / Change the address approval is the second card; do not ask another question first. Only the real exact native allow receipt authorizes a paid order. select changes the default owned sender on its own native approval. The account limit is a product default. Never buys a domain, guesses a warmup completion date, activates campaigns, or approves sending.",
  ),
  tool(
    "get_role_draft",
    ReadRoleDraftInput,
    true,
    "Reads the exact role-bound campaign and connected sending mailboxes; never sends.",
  ),
  tool(
    "clone_role_draft",
    CloneRoleDraftInput,
    false,
    "Clones an exact role-associated sequence into a new zero-recipient draft, retaining original content and history. Never activates or sends.",
  ),
  tool(
    "create_role_draft",
    CreateRoleDraftInput,
    false,
    "Creates a zero-recipient draft for a role without a bound campaign. Never sends or adopts a campaign by name.",
  ),
  tool(
    "update_role_draft",
    UpdateRoleDraftInput,
    false,
    "Edits only the exact role-bound draft. Refuses active, paused, completed or unsupported sequences. Never sends.",
  ),
  tool(
    "create_campaign",
    CreateCampaignInput,
    false,
    "Creates a draft (not sending) campaign from one of your connected mailboxes with stop-on-reply on. Prefer ensure_role_campaign for a recruiting role. Outside a role conversation, this is how to send a new one-off email (compose and send to any address, not a reply in an existing thread) to someone the recruiter names: pass the email as steps and this account's sending mailbox as eaccount, then add_leads with that person and activate_campaign with the campaign_id and them as recipients. Several people get one campaign with all of them added, so one card confirms them together.",
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
    "Reads sent, opened and replied counts for one exact campaign. These totals lag behind sending; for who has been emailed and who is still queued, read get_campaign.",
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
    "Sends the campaign's first email by activating it (also resumes a paused one); the campaign needs its email saved first (ensure_role_campaign steps). This is the only way to send a campaign email; it shows the native confirmation card — call it and let the human confirm, do not refuse or ask for a thread. When the recruiter names who gets it, pass exactly those people as recipients: the card lists only them and nobody else in the campaign is emailed. Without recipients it sends to everyone in the campaign, and the card lists them all. To add people to a campaign that is already sending, stage them with add_shortlist_leads and pass them as recipients: only they are emailed. When people are queued (for later sending hours, or behind the gap between emails) and the recruiter wants them sent now, pass send_now: its card lists who is queued, and on confirm they go out as soon as the mail service picks them up (often minutes, at most about an hour), one a minute. Never tell the recruiter a queue cannot be sped up; offer send_now.",
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
    "Sends a reply in the existing thread of one received email from your connected mailbox. This is the only way to answer a candidate's email; it shows the native confirmation card and nothing is sent until the human confirms — call it, never refuse or say there is no approval flow. Every new request to reply gets its own call and card, whatever happened to earlier cards for that email (sent, discarded or still open): never skip the call because of them.",
  ),
  tool(
    "ensure_role_campaign",
    EnsureRoleCampaignInput,
    false,
    "Returns the one Instantly campaign bound to a recruiting role, creating it (draft, stop-on-reply on, default mailbox) only if none exists. Idempotent; needs no arguments inside a role conversation. Pass steps to save the email sequence on a campaign it created (with no sending mailbox yet, steps are still saved for the role, no connection needed): a draft that has sent nothing takes new copy in place of the old, a paused one only its first; other copy is kept and comes back as currentEmail. hasEmail says whether the campaign has an email to send. Emails go out as soon as the recruiter confirms; pass send_hours weekdays_9_to_5 only when the recruiter asks to send in business hours. Pass recipients with one step to save an email written for those people as their own first email: activate_campaign with them as recipients then sends exactly it. Also returns candidate_key -> lead id mappings.",
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
const PACIFIC_ANY_TIME = "Any time (Pacific)";
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

async function requireOwnMailbox(
  rest: InstantlyRest,
  eaccount: string,
  allowPendingSender = false,
) {
  try {
    await rest("GET", `/accounts/${encodeURIComponent(eaccount)}`);
    return true;
  } catch (error) {
    if (allowPendingSender && error instanceof InstantlyRestError && error.status === 404)
      return false;
    if (error instanceof InstantlyRestError && error.status === 404)
      throw new Error(`${eaccount} is not one of your connected Instantly mailboxes`);
    if (error instanceof IsolationError)
      throw new Error(`${eaccount} is not one of this account's sending mailboxes`);
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
        name: anyTime
          ? pacific
            ? PACIFIC_ANY_TIME
            : "Any time"
          : pacific
            ? PACIFIC_WEEKDAYS
            : "Weekdays",
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
    campaign_schedule: campaignSchedule(setup.send_hours ?? "any_time", setup.timezone),
    ...(setup.steps ? { sequences: sequences(setup.steps) } : {}),
    email_list: [setup.eaccount],
    // Instantly has no per-lead stop; the campaign flag is the only native stop on reply.
    stop_on_reply: true,
    stop_on_auto_reply: true,
  };
}

async function createCampaign(
  rest: InstantlyRest,
  input: z.output<typeof CreateCampaignInput>,
  allowPendingSender = false,
) {
  const connected = await requireOwnMailbox(rest, input.eaccount, allowPendingSender);
  return rest("POST", "/campaigns", {
    ...campaignBody(input.name, input),
    email_list: connected ? [input.eaccount] : [],
  });
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
  /** Hours the recruiter asked for; without them a confirmed send goes out at once. */
  sendHours?: "weekdays_9_to_5" | "any_time";
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
/**
 * A role's imported campaign: another tool's sequence that keeps emailing and answering the people
 * it already holds. The role reads and can reply in it, but adds new people to its own campaign.
 */
export const historyKey = (serverId: string, roleId: string) =>
  `${bindingKey(serverId, roleId)}:history`;

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
  if (!id)
    throw new Error(
      "Pass role_id: this conversation has no linked recruiting role. To email someone the recruiter names outside a role, use create_campaign with that email as steps, then add_leads, then activate_campaign with its campaign_id.",
    );
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
  userId: string,
) {
  const effect = await prisma.externalEffect.findFirst({
    where: {
      spaceId,
      kind: "instantly_role_campaign",
      run: { userId, spaceId },
      status: "completed",
      request: { path: ["serverId"], equals: serverId },
    },
    orderBy: { updatedAt: "desc" },
    select: { result: true },
  });
  const eaccount = (effect?.result as Partial<RoleBinding> | null)?.eaccount;
  return typeof eaccount === "string" ? eaccount : null;
}

const NO_MAILBOX = "No sending mailbox is set up for this account yet";
/** Default sender: the last-used mailbox if still connected, else the first connected one. */
async function defaultMailbox(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
) {
  const confirmed = await defaultSendingMailbox(prisma, context);
  if (confirmed) return confirmed;
  const accounts = await rest("GET", "/accounts?limit=100");
  const emails = (Array.isArray(accounts.items) ? (accounts.items as { email?: unknown }[]) : [])
    .map((item) => item.email)
    .filter((email): email is string => typeof email === "string");
  const last = await lastUsedMailbox(prisma, context.spaceId, serverId, context.userId);
  const picked = emails.find((email) => last && sameAddress(email, last)) ?? emails[0];
  if (!picked) throw new Error(`${NO_MAILBOX}; tell the recruiter instead of creating a campaign`);
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
  senderState?: { state: string; warmup: string; readyAt: null };
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clockMinutes = (value: unknown) => {
  const hit = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  return hit ? Number(hit[1]) * 60 + Number(hit[2]) : null;
};
/** Weekday (0 = Sunday) and minutes past midnight of `at` on the wall clock of `zone`. */
function wallClock(at: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: WEEKDAYS.indexOf(String(parts.weekday)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * When a sending campaign next emails the people queued in it, from its first sending window:
 * "now" inside the window, else the window's next start (its weekday and time in its zone).
 * Null when the schedule cannot be read. A queued person outside the window is not a failure.
 */
export function nextSendWindow(
  campaign: Record<string, unknown> | undefined,
  now = new Date(),
): { now: true } | { now: false; at: string; local: string } | null {
  const schedules = (campaign?.campaign_schedule as { schedules?: unknown } | undefined)?.schedules;
  const first = Array.isArray(schedules) ? (schedules[0] as Record<string, unknown>) : undefined;
  const zone = typeof first?.timezone === "string" ? first.timezone : null;
  const timing = first?.timing as { from?: unknown; to?: unknown } | undefined;
  const from = clockMinutes(timing?.from);
  const to = clockMinutes(timing?.to);
  const days = first?.days as Record<string, unknown> | undefined;
  if (!zone || from === null || to === null || !days) return null;
  let clock: ReturnType<typeof wallClock>;
  try {
    clock = wallClock(now, zone);
  } catch {
    return null;
  }
  const open = (day: number) => days[String(day)] === true;
  if (open(clock.day) && clock.minutes >= from && clock.minutes < to) return { now: true };
  for (let ahead = 0; ahead <= 7; ahead++) {
    // The window's start on that day, corrected once for a daylight-saving change in between.
    let start = new Date(now.getTime() + ((from - clock.minutes) * 60 + ahead * 86_400) * 1000);
    const drift = wallClock(start, zone).minutes - from;
    if (drift) start = new Date(start.getTime() - drift * 60_000);
    start = new Date(Math.floor(start.getTime() / 60_000) * 60_000);
    const day = wallClock(start, zone).day;
    if (start > now && open(day)) {
      // Pacific hours are stored one hour ahead in Mountain time (see PACIFIC_WEEKDAYS).
      const pacific = first?.name === PACIFIC_WEEKDAYS;
      const shownFrom = pacific ? from - 60 : from;
      const time = `${String(Math.floor(shownFrom / 60)).padStart(2, "0")}:${String(shownFrom % 60).padStart(2, "0")}`;
      return {
        now: false,
        at: start.toISOString(),
        local: `${WEEKDAYS[day]} ${time} ${pacific ? "Pacific time" : zone}`,
      };
    }
  }
  return null;
}
/**
 * True when a confirmed send would wait for the campaign's sending hours although the recruiter
 * never asked for them (older campaigns defaulted to weekdays 9-5): the send widens them first.
 */
function waitsForHours(
  campaign: Record<string, unknown> | undefined,
  binding: Pick<RoleBinding, "sendHours"> | null | undefined,
) {
  const window = nextSendWindow(campaign);
  return Boolean(window && !window.now && binding?.sendHours !== "weekdays_9_to_5");
}
/** The card's send time: now unless the recruiter chose hours that start later. */
function sendTime(
  campaign: Record<string, unknown> | undefined,
  binding: Pick<RoleBinding, "sendHours"> | null | undefined,
  sendNow = false,
) {
  if (!campaign) return null;
  const window = nextSendWindow(campaign);
  if (sendNow) return window && !window.now ? `Now, instead of ${window.local}` : "Now";
  if (!window || waitsForHours(campaign, binding))
    return window ? "Now" : describeSchedule(campaign);
  return window.now ? "Now" : `${window.local} (${describeSchedule(campaign)})`;
}
/**
 * When `count` people queued now in a sending campaign have all been emailed: one mailbox sends
 * one email every `email_gap` minutes (the provider's default is 10), so a confirmed send is
 * queued, not sent, and the recruiter is told until when.
 */
/** Minutes between two emails from one mailbox; the provider's default is 10. */
const emailGap = (campaign: Record<string, unknown> | undefined) =>
  Number(campaign?.email_gap) > 0 ? Number(campaign?.email_gap) : 10;
/** The shortest gap the provider takes: what a send-now sets so queued people go out at once. */
const FASTEST_GAP = 1;
/**
 * Minutes the provider can take to start emailing a campaign it just activated or whose hours
 * just opened (observed up to about an hour, often a few minutes).
 */
const PICKUP_MINUTES = 60;

export function queuePace(
  campaign: Record<string, unknown> | undefined,
  count: number,
  /** When the first of these people was queued; the estimate counts from it, so it holds still. */
  since?: Date,
  now = new Date(),
): string {
  const gap = emailGap(campaign);
  const schedules = (campaign?.campaign_schedule as { schedules?: unknown } | undefined)?.schedules;
  const first = Array.isArray(schedules) ? (schedules[0] as Record<string, unknown>) : undefined;
  // Pacific schedules are stored in Mountain time (see PACIFIC_WEEKDAYS); show both by name.
  const pacific = first?.name === PACIFIC_WEEKDAYS || first?.name === PACIFIC_ANY_TIME;
  const zone = pacific
    ? "America/Los_Angeles"
    : typeof first?.timezone === "string"
      ? first.timezone
      : "America/Chicago";
  const shown = pacific
    ? "Pacific time"
    : ({ "America/Boise": "Mountain time", "America/Chicago": "Central time (Chicago)" }[zone] ??
      zone);
  const start = since && since.getTime() <= now.getTime() ? since : now;
  const spread = (Math.max(count, 1) - 1) * gap * 60_000;
  const done = new Date(start.getTime() + PICKUP_MINUTES * 60_000 + spread);
  const overdue = done.getTime() < now.getTime();
  const at = (date: Date) => {
    const { minutes } = wallClock(date, zone);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  };
  let time: string;
  let queuedAt: string;
  try {
    time = at(overdue ? new Date(now.getTime() + spread) : done);
    queuedAt = at(start);
  } catch {
    return `queued with the mail service: the first email can take up to an hour to leave, then about one every ${gap} minutes from the mailbox`;
  }
  if (overdue)
    return `queued with the mail service since ${queuedAt} ${shown}, longer than its usual hour; nothing failed, it is still sending about one every ${gap} minutes, so ${count > 1 ? `all ${count} should be` : "it should be"} out by about ${time} ${shown}`;
  return `queued with the mail service: the first email can take up to an hour to leave (tell the recruiter so), then about one every ${gap} minutes from the mailbox, so ${count > 1 ? `all ${count} should be` : "it should be"} out by about ${time} ${shown} at the latest`;
}
/** Role-campaign binding for a role, read without a run (approval cards, API). */
/** What one connection owns on the shared mail account: its roles' campaigns and senders. */
export type OwnedInstantly = { campaigns: ReadonlySet<string>; mailboxes: ReadonlySet<string> };

const mailboxKey = (email: string) => email.trim().toLowerCase();

/**
 * This connection's bound campaigns and explicitly confirmed account senders.
 * A campaign's existing mailbox authorizes its own reply thread only, not general sender access.
 */
export async function ownedInstantly(
  prisma: Pick<PrismaClient, "$queryRaw">,
  spaceId: string,
  serverId: string,
  userId: string,
): Promise<{ campaigns: string[]; mailboxes: string[] }> {
  // Run ownership is the indexed boundary; OFFSET 0 keeps each receipt lookup on (runId, status).
  const effects = await prisma.$queryRaw<{ kind: string; result: unknown }[]>`
    SELECT e.kind, e.result
    FROM runs r
    CROSS JOIN LATERAL (
      SELECT e.kind, e.result
      FROM external_effects e
      WHERE e."runId" = r.id AND e."spaceId" = ${spaceId}
        AND e.status = 'completed'
        AND e.kind IN ('instantly_role_campaign', 'instantly_sender_account')
        AND e.request->>'serverId' = ${serverId}
      OFFSET 0
    ) e
    WHERE r."spaceId" = ${spaceId} AND r."userId" = ${userId}
  `;
  const campaigns = new Set<string>();
  const mailboxes = new Set<string>();
  for (const { kind, result } of effects) {
    const value = (result ?? {}) as Partial<RoleBinding> & { email?: unknown };
    if (kind === "instantly_role_campaign" && typeof value.campaignId === "string")
      campaigns.add(value.campaignId);
    const sender = kind === "instantly_sender_account" ? value.email : undefined;
    if (typeof sender === "string" && sender.includes("@")) mailboxes.add(mailboxKey(sender));
  }
  return { campaigns: [...campaigns].sort(), mailboxes: [...mailboxes].sort() };
}

const CAMPAIGN_PATH = /^\/campaigns\/([0-9a-f-]{36})(?:\/(?:activate|pause))?$/i;

/**
 * The shared account's REST boundary: only this connection's own campaigns (and one it creates in
 * this call) can be read or changed, only its own sending mailboxes are listed or used, and
 * nothing searches or deduplicates across the account.
 */
export function ownedInstantlyRest(rest: InstantlyRest, owned: OwnedInstantly): InstantlyRest {
  const mine = new Set(owned.campaigns);
  const refuse = (what = "campaign") => {
    throw new IsolationError(`That ${what} does not belong to this account`);
  };
  const own = (id: unknown) => {
    if (typeof id !== "string" || !mine.has(id)) refuse();
  };
  const sender = (email: unknown) =>
    typeof email === "string" && owned.mailboxes.has(mailboxKey(email));
  const senders = (list: unknown) => {
    if (list !== undefined && (!Array.isArray(list) || !list.every(sender))) refuse("mailbox");
  };
  return async (method, path, body) => {
    const [route, query = ""] = path.split("?");
    const fields = (body ?? {}) as Record<string, unknown>;
    if (route === "/campaigns" && method === "GET") return { items: [] };
    if (route === "/accounts" && method === "GET") {
      const listed = await rest(method, path, body);
      const items = Array.isArray(listed.items) ? (listed.items as { email?: unknown }[]) : [];
      return { items: items.filter((item) => sender(item.email)) };
    }
    if (route!.startsWith("/accounts/")) {
      if (method !== "GET" || !sender(decodeURIComponent(route!.slice("/accounts/".length))))
        refuse("mailbox");
      return rest(method, path, body);
    }
    if (route === "/campaigns" && method === "POST") {
      senders(fields.email_list);
      const created = await rest(method, path, body);
      if (typeof created.id === "string") mine.add(created.id);
      return created;
    }
    const campaign = CAMPAIGN_PATH.exec(route!);
    if (campaign) {
      own(campaign[1]);
      senders(fields.email_list);
    } else if (route === "/campaigns/analytics/overview") own(new URLSearchParams(query).get("id"));
    else if (route === "/leads/list") own(fields.campaign);
    else if (route === "/leads/add") {
      own(fields.campaign_id);
      // Skipping people already in the shared account would reveal other accounts' leads.
      if (fields.skip_if_in_workspace)
        return rest(method, path, { ...fields, skip_if_in_workspace: false });
    } else if (route === "/leads/update-interest-status") own(fields.campaign_id);
    else if (route === "/emails/reply") {
      if (!sender(fields.eaccount)) refuse("mailbox");
    } else if (!route!.startsWith("/emails") && !/^\/leads\/[0-9a-f-]{36}$/i.test(route!)) refuse();
    return rest(method, path, body);
  };
}

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

/** The campaigns a role's mail is read from: its own, then the one its imported history used. */
export async function roleCampaignIds(
  prisma: Pick<PrismaClient, "externalEffect">,
  spaceId: string,
  serverId: string,
  roleId: string,
) {
  const effects = await prisma.externalEffect.findMany({
    where: {
      idempotencyKey: { in: [bindingKey(serverId, roleId), historyKey(serverId, roleId)] },
      spaceId,
      status: "completed",
    },
    select: { idempotencyKey: true, result: true },
  });
  return effects
    .toSorted((a, b) => a.idempotencyKey.length - b.idempotencyKey.length)
    .map((effect) => (effect.result as Partial<RoleBinding> | null)?.campaignId)
    .filter((id): id is string => typeof id === "string");
}
/**
 * Links each role of an onboarded account to the one campaign its imported mail history came
 * from, once every mailbox that history used is assigned to (or already sends for) the account,
 * so the role's Inbox reads new replies from that campaign and the account can reply in it.
 * The link is the role's history, not its own campaign: the other tool keeps the people it holds,
 * and people this product adds go to a campaign of its own. A link made before that, which nobody
 * was added through yet, becomes history. A campaign any role already uses is left alone.
 * Returns the number of roles linked.
 */
export async function bindImportedCampaigns(prisma: PrismaClient, userId: string) {
  const imports = await prisma.externalEffect.findMany({
    where: { kind: "recruiting_history_import", status: "completed", run: { userId } },
    select: { id: true, runId: true, spaceId: true, result: true },
    orderBy: { createdAt: "asc" },
  });
  const roles = new Map<
    string,
    { runId: string; spaceId: string; campaigns: Set<string>; mailboxes: Map<string, number> }
  >();
  for (const receipt of imports) {
    const result = (receipt.result ?? {}) as { roleId?: unknown; emails?: unknown };
    if (typeof result.roleId !== "string" || !Array.isArray(result.emails)) continue;
    const role = roles.get(result.roleId) ?? {
      runId: receipt.runId,
      spaceId: receipt.spaceId,
      campaigns: new Set<string>(),
      mailboxes: new Map<string, number>(),
    };
    if (role.spaceId !== receipt.spaceId) continue;
    for (const email of result.emails as { campaignId?: unknown; eaccount?: unknown }[]) {
      if (typeof email?.campaignId === "string") role.campaigns.add(email.campaignId);
      if (typeof email?.eaccount === "string" && email.eaccount.includes("@")) {
        const mailbox = email.eaccount.trim().toLowerCase();
        role.mailboxes.set(mailbox, (role.mailboxes.get(mailbox) ?? 0) + 1);
      }
    }
    roles.set(result.roleId, role);
  }
  if (!roles.size) return 0;
  const assigned = await prisma.sendingMailboxAssignment.findMany({
    where: { userId },
    select: { email: true },
  });
  const senders = await prisma.externalEffect.findMany({
    where: { kind: "instantly_sender_account", status: "completed", run: { userId } },
    select: { result: true },
  });
  const mine = new Set([
    ...assigned.map((row) => row.email.toLowerCase()),
    ...senders.flatMap(({ result }) => {
      const email = (result as { email?: unknown } | null)?.email;
      return typeof email === "string" ? [email.toLowerCase()] : [];
    }),
  ]);
  let linked = 0;
  for (const [roleId, history] of roles) {
    const [campaignId, ...others] = [...history.campaigns];
    if (!campaignId || others.length || !history.mailboxes.size) continue;
    if (![...history.mailboxes.keys()].every((mailbox) => mine.has(mailbox))) continue;
    const role = await prisma.recruitingRole.findFirst({
      where: { id: roleId, userId, spaceId: history.spaceId, archivedAt: null },
      select: { title: true },
    });
    const servers = await prisma.mcpServer.findMany({
      where: { userId, spaceId: history.spaceId, endpoint: INSTANTLY_MCP_ENDPOINT, enabled: true },
      select: { id: true },
    });
    if (!role || servers.length !== 1) continue;
    const serverId = servers[0]!.id;
    const key = historyKey(serverId, roleId);
    const earlier = await prisma.externalEffect.findUnique({
      where: { idempotencyKey: bindingKey(serverId, roleId) },
      select: { id: true, request: true, result: true },
    });
    const earlierRequest = (earlier?.request ?? {}) as { importedHistory?: unknown };
    const earlierResult = (earlier?.result ?? {}) as Partial<RoleBinding>;
    if (
      earlier &&
      earlierRequest.importedHistory === true &&
      earlierResult.campaignId === campaignId &&
      !Object.keys(earlierResult.leads ?? {}).length &&
      !Object.keys(earlierResult.staged ?? {}).length
    ) {
      await prisma.externalEffect.update({
        where: { id: earlier.id },
        data: { idempotencyKey: key },
      });
      linked++;
      continue;
    }
    const taken = await prisma.externalEffect.findFirst({
      where: {
        OR: [
          { idempotencyKey: key },
          { kind: "instantly_role_campaign", result: { path: ["campaignId"], equals: campaignId } },
        ],
      },
      select: { id: true },
    });
    if (taken) continue;
    const eaccount = [...history.mailboxes].sort((a, b) => b[1] - a[1])[0]![0];
    const binding: RoleBinding = {
      campaignId,
      campaignName: role.title,
      eaccount,
      leads: {},
      created: false,
    };
    await prisma.externalEffect.create({
      data: {
        spaceId: history.spaceId,
        runId: history.runId,
        kind: "instantly_role_campaign",
        idempotencyKey: key,
        status: "completed",
        request: { roleId, serverId, importedHistory: true },
        result: binding as unknown as Prisma.InputJsonValue,
      },
    });
    linked++;
  }
  return linked;
}

/** A campaign lead or a staged person, as one send would address them. */
type Person = StagedLead & {
  id?: string;
  /** The first email this lead's variables hold (subject and body HTML), when it has them. */
  saved?: Record<typeof OWN_SUBJECT | typeof OWN_BODY, string>;
  /** The provider has emailed this lead (Lead.timestamp_last_contact). */
  contacted?: boolean;
  /** When this lead joined the campaign (Lead.timestamp_created). */
  queuedAt?: string;
};
type SendPlan =
  /** Activate the campaign once `remove` (never-emailed people nobody named) are taken out. */
  | { send: "activate"; recipients: Person[]; remove: Person[] }
  /** Add these staged people to the already sending campaign: only they are newly emailed. */
  | { send: "enroll"; recipients: Person[] }
  /** Open the sending hours so the people already queued in the campaign are emailed now. */
  | { send: "now"; recipients: Person[] }
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
      ...(typeof lead.timestamp_created === "string" ? { queuedAt: lead.timestamp_created } : {}),
    },
  ];
}
/** When the earliest of these people joined the campaign, if the provider said. */
function firstQueued(people: Person[]): Date | undefined {
  const times = people
    .map((person) => Date.parse(person.queuedAt ?? ""))
    .filter((time) => Number.isFinite(time));
  return times.length ? new Date(Math.min(...times)) : undefined;
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
  campaign: Record<string, unknown> | undefined,
  leads: Person[],
  staged: Person[],
  wanted?: string[],
  templated = false,
  copy: Copy = null,
  sendNow = false,
): SendPlan {
  const plan = sendNow
    ? planSendNow(campaign, leads)
    : planRecipients(campaign, leads, staged, wanted);
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
/**
 * Who a send-now emails: everyone in the sending campaign it has not emailed yet. They wait for
 * its sending hours or for the gap between emails; once neither holds them back there is nothing
 * left to speed up.
 */
function planSendNow(campaign: Record<string, unknown> | undefined, leads: Person[]): SendPlan {
  const queued = leads.filter((lead) => !lead.contacted);
  if (campaign?.status !== ACTIVE)
    return {
      refusal: "This campaign is not sending, so nobody is queued in it; nothing was sent.",
    };
  if (!queued.length)
    return { refusal: "Everyone in this campaign has already been emailed; nothing was sent." };
  const window = nextSendWindow(campaign);
  return (!window || window.now) && emailGap(campaign) <= FASTEST_GAP
    ? {
        refusal: `Already sending as fast as the mail service allows: ${label(queued)} ${queuePace(campaign, queued.length, firstQueued(queued))}. Nothing failed, nothing was changed and nobody is emailed twice. Tell the recruiter once, plainly, that this is the fastest the mail service sends and give that time; do not try send_now again. get_campaign shows who has been emailed.`,
      }
    : { send: "now", recipients: queued };
}
/** When people queued in a sending campaign get their first email. */
function queuedWhen(campaign: Record<string, unknown> | undefined, queued: Person[]) {
  const window = nextSendWindow(campaign);
  return window && !window.now
    ? `Their first email goes out ${window.local}.`
    : `They are ${queuePace(campaign, queued.length, firstQueued(queued))}.`;
}
function planRecipients(
  campaign: Record<string, unknown> | undefined,
  leads: Person[],
  staged: Person[],
  wanted?: string[],
): SendPlan {
  const status = campaign?.status;
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
    if (!sending.length) return { send: "enroll", recipients: chosen };
    const emailed = sending.filter((person) => person.contacted);
    const queued = sending.filter((person) => !person.contacted);
    return {
      refusal: [
        emailed.length ? `Already emailed by this campaign: ${label(emailed)}.` : "",
        queued.length
          ? `Already queued in this sending campaign, not emailed yet: ${label(queued)}. ${queuedWhen(campaign, queued)} Nothing failed. If the recruiter wants them sooner, call activate_campaign with send_now: its card sends everyone queued one a minute instead of one every ten.`
          : "",
        "Nobody new was added, so nothing else was sent.",
      ]
        .filter(Boolean)
        .join(" "),
    };
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
  binding: Pick<
    RoleBinding,
    "leads" | "staged" | "roleEmail" | "drafts" | "sendHours"
  > | null = null,
  wanted?: string[],
  sendNow = false,
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
  // get_campaign names the sending mailbox sendingMailbox; the raw provider read calls it email_list.
  const emails = Array.isArray(campaign?.sendingMailbox)
    ? campaign.sendingMailbox
    : Array.isArray(campaign?.email_list)
      ? campaign.email_list
      : [];
  const items = Array.isArray(leads?.items) ? (leads.items as Record<string, unknown>[]) : null;
  const templated = isTemplated(campaign);
  const people = (items ?? []).flatMap(asPerson);
  const plan =
    campaign && items
      ? planSend(campaign, people, stagedPeople(binding), wanted, templated, binding, sendNow)
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
    ...(campaign?.senderState &&
    typeof campaign.senderState === "object" &&
    !Array.isArray(campaign.senderState) &&
    typeof (campaign.senderState as Record<string, unknown>).state === "string" &&
    typeof (campaign.senderState as Record<string, unknown>).warmup === "string"
      ? {
          senderState: {
            state: String((campaign.senderState as Record<string, unknown>).state),
            warmup: String((campaign.senderState as Record<string, unknown>).warmup),
            readyAt: null,
          },
        }
      : {}),
    campaignName: typeof campaign?.name === "string" ? campaign.name : null,
    status:
      typeof campaign?.status === "number"
        ? (INSTANTLY_CAMPAIGN_STATUS[campaign.status] ?? String(campaign.status))
        : null,
    mailbox: typeof emails[0] === "string" ? emails[0] : fallbackMailbox,
    recipients,
    recipientCount: items ? recipients.length : null,
    stopOnReply: typeof campaign?.stop_on_reply === "boolean" ? campaign.stop_on_reply : null,
    schedule: sendTime(campaign, binding, sendNow),
    ...shownEmail,
  };
}

export type InstantlyReplyDisplay = {
  to: string | null;
  from: string | null;
  subject: string;
  inReplyTo: string | null;
  body: string;
  original?: Record<string, unknown>;
  refusal?: MailReplyErrorCode;
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
      ? await read("native_instantly_get_email", {
          id: args.reply_to_uuid,
          check_sender: true,
        }).catch(() => undefined)
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
    original,
    ...((original?.replySenderCheck as { ready?: boolean } | undefined)?.ready === true
      ? {}
      : {
          refusal:
            MailReplyErrorCodeSchema.safeParse(
              (original?.replySenderCheck as { error?: unknown } | undefined)?.error,
            ).data ?? "sender_unavailable",
        }),
  };
}

async function readEmail(rest: InstantlyRest, id: string) {
  const email = await rest("GET", `/emails/${id}`);
  if (email.id !== id) throw new Error("The provider returned a different email");
  return email;
}

export class MailReplySendingError extends Error {
  constructor(readonly code: MailReplyErrorCode) {
    super(code);
  }
}

/** An existing campaign authorizes only replying to its own email, never claiming a default sender. */
export async function requireReplySendingMailboxReady(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  original: Record<string, unknown>,
  email: string,
) {
  if (typeof original.eaccount !== "string" || !sameAddress(original.eaccount, email))
    throw new MailReplySendingError("sender_unavailable");
  if (await confirmedSendingMailbox(prisma, context, email)) {
    try {
      return await requireSendingMailboxReady(prisma, rest, context, email);
    } catch (error) {
      throw new MailReplySendingError(
        error instanceof IsolationError
          ? "sender_unavailable"
          : error instanceof Error && error.message.includes("display name changed")
            ? "sender_changed"
            : error instanceof Error && error.message.includes("not active yet")
              ? "sender_not_ready"
              : "sender_unavailable",
      );
    }
  }
  const roleId = await activeRoleId(prisma, context);
  if (
    !roleId ||
    typeof original.campaign_id !== "string" ||
    !original.campaign_id.trim() ||
    typeof original.thread_id !== "string" ||
    !original.thread_id.trim()
  )
    throw new MailReplySendingError("sender_unavailable");
  const key = bindingKey(serverId, roleId);
  let owned: Partial<RoleBinding> | null = null;
  // Existing native associations have unique keys; never scan unrelated effect history for proof.
  for (const idempotencyKey of [
    key,
    historyKey(serverId, roleId),
    `${key}:campaign:${original.campaign_id}`,
  ]) {
    const binding = await prisma.externalEffect.findUnique({
      where: {
        idempotencyKey,
        spaceId: context.spaceId,
        run: { userId: context.userId, spaceId: context.spaceId },
        kind: "instantly_role_campaign",
        status: "completed",
        AND: [
          { request: { path: ["serverId"], equals: serverId } },
          { request: { path: ["roleId"], equals: roleId } },
          { result: { path: ["campaignId"], equals: original.campaign_id } },
        ],
      },
      select: { result: true },
    });
    owned = binding?.result as Partial<RoleBinding> | null;
    if (typeof owned?.eaccount === "string" && sameAddress(owned.eaccount, email)) break;
  }
  if (typeof owned?.eaccount !== "string" || !sameAddress(owned.eaccount, email))
    throw new MailReplySendingError("sender_unavailable");
  let state: Awaited<ReturnType<typeof sendingMailboxState>>;
  try {
    state = await sendingMailboxState(rest, email);
  } catch {
    throw new MailReplySendingError("sender_unavailable");
  }
  if (!state.usable) throw new MailReplySendingError("sender_not_ready");
  await context.reauthorize?.();
  return state;
}

async function replyToEmail(
  rest: InstantlyRest,
  input: z.output<typeof ReplyToEmailInput>,
  ready?: (email: string, original: Record<string, unknown>) => Promise<unknown>,
) {
  const original = await readEmail(rest, input.reply_to_uuid);
  const eaccount =
    input.eaccount ?? (typeof original.eaccount === "string" ? original.eaccount : "");
  if (!eaccount) throw new Error("The original email names no mailbox; pass eaccount");
  await requireOwnMailbox(rest, eaccount);
  await ready?.(eaccount, original);
  if (typeof original.eaccount === "string" && !sameAddress(original.eaccount, eaccount))
    throw new Error(`${input.reply_to_uuid} is not in the ${eaccount} mailbox`);
  const subject =
    input.subject ??
    (typeof original.subject === "string" && original.subject.trim()
      ? `Re: ${original.subject.replace(/^(re:\s*)+/iu, "")}`
      : "Re:");
  const text = input.body.text.replace(/\r\n?/g, "\n");
  const html = `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br />")}</p>`;
  const sent = await rest("POST", "/emails/reply", {
    reply_to_uuid: input.reply_to_uuid,
    eaccount,
    subject,
    body: { text, html },
    ...(input.cc_address_email_list !== undefined
      ? { cc_address_email_list: input.cc_address_email_list }
      : {}),
  });
  return sent;
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
): Promise<{ campaignId?: string } & Record<string, unknown>> {
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
      // The people already in it were approved: it resumes as soon as the hours are saved.
      if (pausedForHours) await rest("POST", `/campaigns/${mappedId}/activate`);
      if (writeSteps) await requireSavedEmail(rest, mappedId);
      if (input.send_hours || (writeSteps && templated)) {
        existing.binding = {
          ...existing.binding,
          ...(input.send_hours ? { sendHours: input.send_hours } : {}),
          ...(writeSteps && templated
            ? { roleEmail: { subject: input.steps![0]!.subject, body: input.steps![0]!.body } }
            : {}),
        };
        await prisma.externalEffect.update({
          where: { id: existing.effect.id },
          data: { result: existing.binding as unknown as Prisma.InputJsonValue },
        });
      }
      if (writeSteps && templated) {
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
        ...(pausedForHours ? { resumed: "Still sending, now in the new hours" } : {}),
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
  const emailKey = `${key}:email`;
  let eaccount: string;
  try {
    eaccount =
      input.eaccount ??
      (stale ? existing!.binding.eaccount : await defaultMailbox(prisma, rest, context, serverId));
  } catch (error) {
    // Saving the role's email needs no mailbox: it waits on the role until a campaign exists.
    if (!input.steps || !(error instanceof Error) || !error.message.startsWith(NO_MAILBOX))
      throw error;
    return saveRoleEmail(prisma, context, emailKey, role, serverId, input.steps);
  }
  const steps = input.steps ?? (await savedRoleEmail(prisma, context, emailKey));
  // The user-visible name is the role title; the role id lives in the stored mapping's request.
  const name = role.title;
  const adopt = (await sameTitleCampaigns(prisma, context, rest, role)).find(
    (entry) => entry.campaign.id !== existing?.binding.campaignId,
  )?.campaign;
  const pendingAllowed = (await confirmedSendingMailboxes(prisma, context)).some(
    (sender) => sender.email === eaccount.toLowerCase(),
  );
  const campaign =
    adopt ?? (await createCampaign(rest, { ...input, steps, eaccount, name }, pendingAllowed));
  if (adopt && adopt.stop_on_reply !== true)
    await rest("PATCH", `/campaigns/${String(adopt.id)}`, { stop_on_reply: true });
  if (typeof campaign.id !== "string") throw new Error("Instantly returned no campaign id");
  const binding: RoleBinding = {
    campaignId: campaign.id,
    campaignName: typeof campaign.name === "string" ? campaign.name : name,
    eaccount,
    leads: {},
    created: !adopt,
    ...(input.send_hours ? { sendHours: input.send_hours } : {}),
  };
  if (stale)
    await prisma.externalEffect.update({
      where: { id: stale },
      data: { result: binding as unknown as Prisma.InputJsonValue },
    });
  else await recordBinding(prisma, context, key, role.id, serverId, binding);
  // Checked after binding, so a retry writes onto this campaign instead of adopting it.
  if (!adopt && steps) await requireSavedEmail(rest, campaign.id);
  return {
    created: !adopt,
    adopted: Boolean(adopt),
    ...binding,
    ...(!adopt && input.steps ? { next: SHOW_SAVED_STEPS } : {}),
  };
}

type Steps = NonNullable<z.output<typeof EnsureRoleCampaignInput>["steps"]>;

/** The role's email saved before any sending mailbox existed. */
async function savedRoleEmail(prisma: PrismaClient, context: AdapterContext, key: string) {
  const effect = await prisma.externalEffect.findUnique({ where: { idempotencyKey: key } });
  if (!effect) return undefined;
  if (effect.spaceId !== context.spaceId) throw new IsolationError();
  return (effect.result as { steps?: Steps } | null)?.steps;
}

async function saveRoleEmail(
  prisma: PrismaClient,
  context: AdapterContext,
  key: string,
  role: { id: string; title: string },
  serverId: string,
  steps: Steps,
) {
  const current = await prisma.externalEffect.findUnique({ where: { idempotencyKey: key } });
  if (current && current.spaceId !== context.spaceId) throw new IsolationError();
  const result = { steps } as unknown as Prisma.InputJsonValue;
  if (current) await prisma.externalEffect.update({ where: { id: current.id }, data: { result } });
  else
    await prisma.externalEffect.create({
      data: {
        spaceId: context.spaceId,
        runId: context.runId!,
        kind: "instantly_role_email",
        idempotencyKey: key,
        status: "completed",
        request: { roleId: role.id, serverId },
        result,
      },
    });
  return {
    saved: true,
    role: role.title,
    hasEmail: true,
    next: `Saved as the ${role.title} role's email, with no mailbox needed: it becomes the first email of the role's sequence and is used whenever this role's candidates are emailed. Say in one line that it is saved for the role and that they can ask you to show it any time; never ask for a mailbox or connection to save it.`,
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

/** The lead key for an email the recruiter named for someone who is not a saved candidate. */
const NAMED_EMAIL = "email:";
const namedEmailKey = (address: string) => `${NAMED_EMAIL}${address.trim().toLowerCase()}`;
const isNamedEmail = (candidate: { candidate_key: string; email?: string | null }) =>
  candidate.candidate_key.startsWith(NAMED_EMAIL) &&
  Boolean(candidate.email) &&
  namedEmailKey(candidate.email!) === candidate.candidate_key;

const notFound = (people: string[]) =>
  `Nothing was saved: ${people.join(", ")} is not one of this role's candidates with a saved email, or more than one person matches. Ask the recruiter one question: which person they mean, by full name or email.`;

/**
 * Adds the named people who are this role's saved candidates to its campaign the way
 * add_shortlist_leads does (a sending campaign keeps them ready instead), plus any email the
 * recruiter typed for someone who is not a candidate. A name that matches no candidate, or more
 * than one, is refused with one question for the recruiter.
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
    if (!person && !byEmail.length && Email.safeParse(value).success) {
      // An address the recruiter typed for someone not in Results is theirs to send to; the send
      // card still lists it before anything goes out.
      const key = namedEmailKey(value);
      if (!candidates.some((c) => c.candidate_key === key))
        candidates.push({ candidate_key: key, email: value });
    } else if (!person) unknown.push(entry);
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
  // An imported campaign is the other tool's, even for this role: it is read, never adopted.
  const otherRoles = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      kind: "instantly_role_campaign",
      OR: [
        { NOT: { request: { path: ["roleId"], equals: role.id } } },
        { request: { path: ["importedHistory"], equals: true } },
      ],
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
  const inRole = new Set([
    ...saved.map((candidate) => candidate.candidateKey),
    ...candidates.filter(isNamedEmail).map((candidate) => candidate.candidate_key),
  ]);
  const notInRole = candidates.filter((c) => !inRole.has(c.candidate_key));
  const onHoldOrPassed = candidates.filter((c) => stopped.has(c.candidate_key));
  const eligible = candidates.filter(
    (c) => inRole.has(c.candidate_key) && !stopped.has(c.candidate_key),
  );
  const missingEmail = eligible.filter((c) => !c.email);
  let withEmail = eligible.filter((c): c is typeof c & { email: string } => Boolean(c.email));
  // People the role's imported campaign already holds stay with it: that tool keeps emailing and
  // answering them, so this campaign never emails them as well.
  const history = await readBinding(prisma, context, historyKey(serverId, role.id));
  const earlierCampaign: string[] = [];
  if (withEmail.length && history?.effect.status === "completed" && history.binding.campaignId) {
    const listed = await rest("POST", "/leads/list", {
      campaign: history.binding.campaignId,
      contacts: withEmail.map((c) => c.email),
      limit: 100,
    });
    const held = new Set(
      (Array.isArray(listed.items) ? (listed.items as { email?: string | null }[]) : []).flatMap(
        (lead) => (lead.email ? [lead.email.toLowerCase()] : []),
      ),
    );
    withEmail = withEmail.filter((candidate) => {
      if (!held.has(candidate.email.toLowerCase())) return true;
      earlierCampaign.push(candidate.candidate_key);
      return false;
    });
  }
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
    ...(earlierCampaign.length
      ? {
          inImportedCampaign: earlierCampaign,
          inImportedCampaignNote:
            "These people are already in the role's imported campaign, which keeps emailing and answering them; they were not added here.",
        }
      : {}),
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
  confirmedSenderRequired = false,
) {
  if (!input.campaign_id && !(await activeRoleId(prisma, context)))
    throw new Error(
      "Pass campaign_id: this conversation has no linked role, so name the campaign to send. It is the campaignId in this conversation's earlier create_campaign or activate_campaign result; read it with get_campaign. Do not ask the recruiter for the role again.",
    );
  const campaignId =
    input.campaign_id ??
    (await ensureRoleCampaign(prisma, rest, context, serverId, { timezone: "America/Chicago" }))
      .campaignId!;
  let campaign = await rest("GET", `/campaigns/${campaignId}`);
  const bound = await bindingOfCampaign(prisma, context, serverId, campaignId);
  if (confirmedSenderRequired) {
    let senders = Array.isArray(campaign.email_list) ? campaign.email_list : [];
    if (!senders.length && bound?.binding.eaccount) {
      await requireSendingMailboxReady(prisma, rest, context, bound.binding.eaccount);
      await rest("PATCH", `/campaigns/${campaignId}`, { email_list: [bound.binding.eaccount] });
      campaign = await rest("GET", `/campaigns/${campaignId}`);
      senders = Array.isArray(campaign.email_list) ? campaign.email_list : [];
      if (senders.length !== 1 || senders[0] !== bound.binding.eaccount)
        throw new Error("The confirmed sending address was not saved on this campaign.");
    }
    if (!senders.length || senders.some((email) => typeof email !== "string"))
      throw new Error("Choose this account's confirmed sending address before sending.");
    for (const email of senders)
      await requireSendingMailboxReady(prisma, rest, context, String(email));
  }
  if (!firstEmail(campaign))
    throw new Error(
      "This campaign has no email yet; save the email with ensure_role_campaign steps, then activate again",
    );
  const leads = await allLeads(rest, campaignId);
  const templated = isTemplated(campaign);
  const plan = planSend(
    campaign,
    leads,
    stagedPeople(bound?.binding),
    input.recipients,
    templated,
    bound?.binding,
    input.send_now === true,
  );
  if ("refusal" in plan) throw new Error(plan.refusal);
  // A confirmed send goes out now: hours the recruiter never asked for, or any hours on a
  // send-now, are widened first. The provider edits only paused campaigns, so a sending one is
  // paused for it and resumed below.
  let resume = false;
  const window = nextSendWindow(campaign);
  const widen =
    waitsForHours(campaign, bound?.binding) || (plan.send === "now" && window && !window.now);
  // A send-now also shortens the gap between emails to a minute, so the people queued go out together.
  const hurry = plan.send === "now" && emailGap(campaign) > FASTEST_GAP;
  if (widen || hurry) {
    const zone = (campaign.campaign_schedule as { schedules?: { timezone?: unknown }[] })
      .schedules?.[0]?.timezone;
    if (campaign.status === ACTIVE) {
      await rest("POST", `/campaigns/${campaignId}/pause`);
      resume = true;
    }
    try {
      await rest("PATCH", `/campaigns/${campaignId}`, {
        ...(widen
          ? {
              campaign_schedule: campaignSchedule(
                "any_time",
                typeof zone === "string" ? zone : "America/Chicago",
              ),
            }
          : {}),
        ...(hurry ? { email_gap: FASTEST_GAP, random_wait_max: FASTEST_GAP } : {}),
      });
    } catch (error) {
      if (resume) await rest("POST", `/campaigns/${campaignId}/activate`);
      throw error;
    }
    campaign = await rest("GET", `/campaigns/${campaignId}`);
  }
  // Inside sending hours a confirmed send is queued, not sent: say until when.
  const paced = (count: number) => ({
    next: `Nobody is emailed at this moment: these people are ${queuePace(campaign, count)}. Tell the recruiter they are queued and that time, never that they were sent. get_campaign with campaign_id ${campaignId} (this campaign, not the role's) shows who has been emailed; until that time nobody listed as emailed there means still queued, not failed, so never take the queued answer back.`,
  });
  if (plan.send === "now") {
    if (resume) await rest("POST", `/campaigns/${campaignId}/activate`);
    return {
      sendingNow: true,
      campaignId,
      recipients: plan.recipients.map((person) => person.email),
      ...paced(plan.recipients.length),
    };
  }
  const sendingMailbox = Array.isArray(campaign.email_list) ? campaign.email_list : [];
  // Hours the recruiter asked for: the people wait for them, and the result says until when.
  const later = nextSendWindow(campaign);
  const when =
    later && !later.now
      ? {
          firstEmailAt: later.at,
          next: `Outside the sending hours the recruiter chose (${describeSchedule(campaign)}): these people are queued and their first email goes out ${later.local}. Tell the recruiter that time and that activate_campaign send_now can send them now; it is not a failure.`,
        }
      : {};
  const save = async (binding: RoleBinding) => {
    if (bound)
      await prisma.externalEffect.update({
        where: { id: bound.effect.id },
        data: { result: binding as unknown as Prisma.InputJsonValue },
      });
  };
  if (plan.send === "enroll") {
    // Adding a lead to a sending campaign sends to that lead; nobody else is touched.
    let report: Record<string, unknown>;
    try {
      report = await rest("POST", "/leads/add", {
        campaign_id: campaignId,
        skip_if_in_workspace: false,
        leads: plan.recipients.map((person) => newLead(person, templated && bound?.binding)),
      });
    } finally {
      if (resume) await rest("POST", `/campaigns/${campaignId}/activate`);
    }
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
      queued: sent.length > 0,
      campaignId,
      sendingMailbox,
      recipients: sent,
      ...(later && !later.now ? when : paced(sent.length)),
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
    ...(later && !later.now ? when : paced(plan.recipients.length)),
  };
}

/**
 * Who a campaign sends to (up to 100 leads), split into those it has emailed and those still
 * queued, with when the queued people's first email goes out.
 */
async function leadDelivery(rest: InstantlyRest, campaign: Record<string, unknown>) {
  const leads = await rest("POST", "/leads/list", { campaign: String(campaign.id), limit: 100 });
  const people = (
    Array.isArray(leads.items) ? (leads.items as Record<string, unknown>[]) : []
  ).flatMap(asPerson);
  const waiting = people.filter((person) => !person.contacted);
  const queued = waiting.map((person) => person.email);
  const window = campaign.status === ACTIVE && queued.length ? nextSendWindow(campaign) : null;
  return {
    recipients: people.map((person) => person.email),
    emailed: people.filter((person) => person.contacted).map((person) => person.email),
    queued,
    ...(window ? { queuedFirstEmail: window.now ? "now" : window.local } : {}),
    ...(window && !window.now
      ? {
          next: `The queued people are waiting for the sending hours, not failed. Tell the recruiter who and that their first email goes out ${window.local}, and call activate_campaign with send_now so their card offers to send now.`,
        }
      : window
        ? {
            next: `The queued people are going out now, not failed: they are ${queuePace(campaign, queued.length, firstQueued(waiting))}. Tell the recruiter who is emailed and who is still queued with that time, the same time each check; do not send them again.${emailGap(campaign) > FASTEST_GAP ? " If the recruiter wants them sooner, call activate_campaign with send_now: its card sends everyone queued one a minute instead of one every ten." : ""}`,
          }
        : {}),
  };
}

function draftDelivery(campaign: Record<string, unknown>) {
  const schedules = (
    campaign.campaign_schedule as { schedules?: Record<string, unknown>[] } | undefined
  )?.schedules;
  const schedule = schedules?.length === 1 ? schedules[0] : undefined;
  const timezone = typeof schedule?.timezone === "string" ? schedule.timezone : null;
  const hours = timezone
    ? ((["weekdays_9_to_5", "any_time"] as const).find(
        (hours) =>
          isDeepStrictEqual(
            schedule?.timing,
            campaignSchedule(hours, timezone).schedules[0]!.timing,
          ) &&
          isDeepStrictEqual(schedule?.days, campaignSchedule(hours, timezone).schedules[0]!.days),
      ) ?? null)
    : null;
  return { timezone, hours };
}

function editableDraft(campaign: Record<string, unknown>) {
  const list = campaign.sequences;
  if (list == null || (Array.isArray(list) && list.length === 0)) return true;
  if (!Array.isArray(list) || list.length !== 1 || isTemplated(campaign)) return false;
  const steps = (list[0] as { steps?: unknown })?.steps;
  return (
    Array.isArray(steps) &&
    steps.every(
      (step) =>
        step?.type === "email" &&
        step.delay_unit === "days" &&
        Number.isInteger(step.delay) &&
        step.delay >= 0 &&
        step.delay <= 366 &&
        Array.isArray(step.variants) &&
        step.variants.length === 1 &&
        typeof step.variants[0]?.subject === "string" &&
        typeof step.variants[0]?.body === "string" &&
        // Only the plain paragraphs this writer can reproduce are editable; preserve rich drafts.
        bodyHtml(htmlToPlainText(step.variants[0].body)) === step.variants[0].body,
    )
  );
}

/** Verify only supplied configuration; provider metadata is not part of the write. */
function requireSavedConfiguration(
  campaign: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  if (Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(campaign[key], value)))
    throw new Error(
      "The saved configuration does not match the requested changes. Reopen the sequence to review it.",
    );
}

/** Hash only editable configuration, not telemetry or provider timestamps. */
export function sequenceConfigurationRevision(campaign: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      stableJsonValue(
        Object.fromEntries(
          ["name", "sequences", "campaign_schedule", "email_list", "stop_on_reply"].map((key) => [
            key,
            campaign[key] ?? null,
          ]),
        ),
      ),
    )
    .digest("hex");
}

async function reserveSequenceEffect(
  prisma: PrismaClient,
  context: AdapterContext,
  key: string,
  input: object,
  payload?: object,
) {
  const existing = await prisma.externalEffect.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    const request = existing.request as { input?: unknown; payload?: Record<string, unknown> };
    if (
      existing.spaceId !== context.spaceId ||
      existing.kind !== "instantly_sequence_draft" ||
      stableJsonValue(request.input) !== stableJsonValue(input)
    )
      throw new Error("This draft changed in another request. Reopen it before saving again.");
    const result = existing.result as { campaignId?: string } | null;
    if (typeof result?.campaignId === "string")
      return { existing, campaignId: result.campaignId, payload: request.payload };
    throw new Error(
      "The previous draft request is still unconfirmed. Review the saved sequences before retrying.",
    );
  }
  if (!context.runId) throw new Error("Open the role conversation before changing a draft");
  try {
    await prisma.externalEffect.create({
      data: {
        spaceId: context.spaceId,
        runId: context.runId,
        kind: "instantly_sequence_draft",
        idempotencyKey: key,
        status: "executing",
        request: { input, ...(payload ? { payload } : {}) } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002")
      return reserveSequenceEffect(prisma, context, key, input, payload);
    throw error;
  }
  return {
    existing: null,
    campaignId: null,
    payload: payload as Record<string, unknown> | undefined,
  };
}

/** Retain verified readback in the write receipt already being committed; no extra query. */
function savedSequenceObservation(
  context: AdapterContext,
  serverId: string,
  observedAt: string,
  campaign: Record<string, unknown>,
) {
  return context.recruitingCampaignSourceRevision === undefined
    ? {}
    : {
        __rakazoSequenceObservation: {
          version: 1,
          serverId,
          sourceRevision: context.recruitingCampaignSourceRevision,
          observedAt,
          campaign: {
            id: String(campaign.id),
            name: String(campaign.name),
            status: typeof campaign.status === "number" ? campaign.status : null,
            eaccount: typeof campaign.eaccount === "string" ? campaign.eaccount : null,
            stopOnReply:
              typeof campaign.stopOnReply === "boolean"
                ? campaign.stopOnReply
                : typeof campaign.stop_on_reply === "boolean"
                  ? campaign.stop_on_reply
                  : null,
          },
        },
      };
}

/** No network call runs under a database lock. Unknown delivery consumes the nonce. */
async function createAssociatedDraft(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  roleId: string,
  operation: "create" | "clone",
  nonce: string,
  input: object,
  payload: Record<string, unknown>,
) {
  const key = `instantly-sequence-draft:${serverId}:${roleId}:${operation}:${nonce}`;
  const reservation = await reserveSequenceEffect(prisma, context, key, input, payload);
  let id = reservation.campaignId;
  if (reservation.existing?.status === "completed" && id) {
    await context.reauthorize?.();
    return roleDraft(prisma, rest, context, serverId, { role_id: roleId, campaign_id: id });
  }
  const expected = reservation.payload ?? payload;
  try {
    if (!id) {
      const created = await rest("POST", "/campaigns", payload);
      id = Uuid.parse(created.id);
    }
    const binding = {
      campaignId: id,
      campaignName: String(expected.name),
      eaccount:
        Array.isArray(expected.email_list) && typeof expected.email_list[0] === "string"
          ? expected.email_list[0]
          : "eaccount" in input && typeof input.eaccount === "string"
            ? input.eaccount
            : ((await defaultSendingMailbox(prisma, context)) ?? ""),
      leads: {},
      created: true,
    };
    const associationKey = `${bindingKey(serverId, roleId)}:campaign:${id}`;
    // Commit the returned id and role association together; no provider I/O runs in this transaction.
    await prisma.$transaction(async (tx) => {
      await tx.externalEffect.updateMany({
        where: { idempotencyKey: key },
        data: { status: "created", result: { campaignId: id! } },
      });
      await tx.externalEffect.upsert({
        where: { idempotencyKey: associationKey },
        create: {
          spaceId: context.spaceId,
          runId: context.runId!,
          kind: "instantly_role_campaign",
          idempotencyKey: associationKey,
          status: "completed",
          request: { roleId, serverId },
          result: binding,
        },
        update: {},
      });
      if (operation === "create")
        await tx.externalEffect.upsert({
          where: { idempotencyKey: bindingKey(serverId, roleId) },
          create: {
            spaceId: context.spaceId,
            runId: context.runId!,
            kind: "instantly_role_campaign",
            idempotencyKey: bindingKey(serverId, roleId),
            status: "completed",
            request: { roleId, serverId },
            result: binding,
          },
          update: {},
        });
    });
    // Receipt and exact role association survive revocation after the provider accepted creation.
    await context.reauthorize?.();
    const observedAt = new Date().toISOString();
    const saved = await rest("GET", `/campaigns/${id}`);
    const people = await rest("POST", "/leads/list", { campaign: id, limit: 1 });
    if (saved.status !== DRAFT || !Array.isArray(people.items) || people.items.length !== 0)
      throw new Error("The saved draft could not be verified. Reopen the sequence to review it.");
    requireSavedConfiguration(saved, expected);
    await prisma.externalEffect.updateMany({
      where: { idempotencyKey: key },
      data: {
        status: "completed",
        result: {
          campaignId: id,
          ...savedSequenceObservation(context, serverId, observedAt, saved),
        },
      },
    });
    return roleDraft(
      prisma,
      rest,
      context,
      serverId,
      { role_id: roleId, campaign_id: id },
      expected,
    );
  } catch (error) {
    // ponytail: the provider has no idempotency keys; never re-POST an uncertain create. A
    // known id resumes readback; an unknown id needs provider reconciliation, not a blind retry.
    await prisma.externalEffect.updateMany({
      where: { idempotencyKey: key, status: "executing" },
      data: { status: "unknown" },
    });
    throw error;
  }
}

/** An explicit secondary sequence never replaces the role's primary outreach binding. */
async function roleDraftBinding(
  prisma: PrismaClient,
  context: AdapterContext,
  serverId: string,
  roleId: string,
  campaignId?: string,
) {
  const key = bindingKey(serverId, roleId);
  const primary = await readBinding(prisma, context, key);
  if (!campaignId || primary?.binding.campaignId === campaignId) return primary;
  const selected = await readBinding(prisma, context, `${key}:campaign:${campaignId}`);
  if (selected?.binding.campaignId !== campaignId) throw new IsolationError();
  return selected;
}

async function roleDraft(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  args: z.output<typeof ReadRoleDraftInput>,
  expected?: Record<string, unknown>,
  verifiedReceipt?: string,
) {
  const role = await requireRole(prisma, context, args.role_id);
  const existing = await roleDraftBinding(prisma, context, serverId, role.id, args.campaign_id);
  if (args.campaign_id && args.campaign_id !== existing?.binding.campaignId)
    throw new IsolationError();
  const observedAt = new Date().toISOString();
  if (existing)
    context.onRecruitingCampaignRead?.({
      roleId: role.id,
      campaignId: existing.binding.campaignId,
      observedAt,
    });
  const campaign = existing ? await rest("GET", `/campaigns/${existing.binding.campaignId}`) : null;
  if (expected && campaign) requireSavedConfiguration(campaign, expected);
  const accounts = await rest("GET", "/accounts?limit=100");
  const mailboxes = (Array.isArray(accounts.items) ? accounts.items : []).flatMap((item) =>
    typeof item?.email === "string" ? [item.email as string] : [],
  );
  for (const sender of await confirmedSendingMailboxes(prisma, context))
    if (!mailboxes.includes(sender.email)) mailboxes.push(sender.email);
  const associations = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      run: { userId: context.userId },
      OR: [
        {
          kind: "instantly_role_campaign",
          status: "completed",
          AND: [
            { request: { path: ["roleId"], equals: role.id } },
            { request: { path: ["serverId"], equals: serverId } },
          ],
        },
        {
          kind: "instantly_sequence_draft",
          status: { in: ["executing", "unknown"] },
          idempotencyKey: { startsWith: `instantly-sequence-draft:${serverId}:${role.id}:` },
        },
      ],
    },
    select: { result: true, kind: true, status: true, idempotencyKey: true },
    orderBy: { createdAt: "desc" },
  });
  const unconfirmedDrafts = associations.filter(
    (effect) =>
      effect.kind === "instantly_sequence_draft" &&
      ["executing", "unknown"].includes(effect.status) &&
      effect.idempotencyKey !== verifiedReceipt,
  ).length;
  const campaigns = [
    ...new Map(
      associations.flatMap((effect) => {
        const binding = effect.result as Partial<RoleBinding> | null;
        return typeof binding?.campaignId === "string" && typeof binding.campaignName === "string"
          ? [
              [
                binding.campaignId,
                {
                  id: binding.campaignId,
                  name:
                    campaign?.id === binding.campaignId && typeof campaign.name === "string"
                      ? campaign.name
                      : binding.campaignName,
                },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  if (!campaign)
    return {
      roleId: role.id,
      roleTitle: role.title,
      mailboxes,
      campaigns,
      unconfirmedDrafts,
      campaign: null,
    };
  const { timezone, hours } = draftDelivery(campaign);
  const raw = Array.isArray(campaign.sequences) ? campaign.sequences : [];
  const steps = editableDraft(campaign)
    ? (
        (raw[0]?.steps ?? []) as { variants: { subject: string; body: string }[]; delay: number }[]
      ).map((step) => ({
        subject: step.variants[0]!.subject,
        body: htmlToPlainText(step.variants[0]!.body),
        delay_days: step.delay as number,
      }))
    : [];
  return {
    roleId: role.id,
    roleTitle: role.title,
    sourceRevision: context.recruitingCampaignSourceRevision,
    observedAt,
    mailboxes,
    campaigns,
    unconfirmedDrafts,
    campaign: {
      id: existing!.binding.campaignId,
      name: String(campaign.name ?? role.title),
      status: campaign.status,
      revision: sequenceConfigurationRevision(campaign),
      observedDetails: campaignObservedDetails(campaign),
      stopOnReply: typeof campaign.stop_on_reply === "boolean" ? campaign.stop_on_reply : null,
      editable:
        campaign.status === DRAFT &&
        editableDraft(campaign) &&
        hours !== null &&
        Array.isArray(campaign.email_list) &&
        campaign.email_list.length === 1,
      eaccount:
        Array.isArray(campaign.email_list) && campaign.email_list.length === 1
          ? campaign.email_list[0]
          : null,
      steps,
      timezone,
      send_hours: hours,
    },
  };
}

export async function runInstantlyWrite(
  prisma: PrismaClient,
  accountRest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  toolName: string,
  args: unknown,
  /** Set on the shared account: the campaigns and senders this connection owns. */
  owned?: OwnedInstantly,
): Promise<unknown> {
  // On the shared account a role's campaign comes only from ensure_role_campaign; outside a role,
  // create_campaign makes this account's own campaign for an email to someone the recruiter names.
  const direct =
    owned && toolName === "native_instantly_create_campaign"
      ? !(await activeRoleId(prisma, context))
      : false;
  if (owned && toolName === "native_instantly_create_campaign" && !direct)
    throw new Error("In a role conversation, use ensure_role_campaign for the role's campaign");
  // Mailboxes the owner assigned become this account's on its first mail call of any kind, so a
  // reply in a thread one of them already holds works as well as a new send.
  if (owned && toolName !== "native_instantly_ensure_sender") {
    const adopted = await adoptAssignedSenders(prisma, accountRest, context, serverId);
    if (adopted.length)
      owned = { ...owned, mailboxes: new Set([...owned.mailboxes, ...adopted.map(mailboxKey)]) };
  }
  if (
    owned &&
    !owned.mailboxes.size &&
    (toolName === "native_instantly_ensure_role_campaign" ||
      toolName === "native_instantly_add_shortlist_leads" ||
      direct)
  ) {
    const adopted = await adoptLegacySender(prisma, accountRest, context, serverId);
    if (adopted) owned = { ...owned, mailboxes: new Set([mailboxKey(adopted)]) };
  }
  const rest = owned ? ownedInstantlyRest(accountRest, owned) : accountRest;
  switch (toolName) {
    case "native_instantly_ensure_sender":
      return ensureSendingIdentity(prisma, accountRest, context, serverId, args);
    case "native_instantly_get_role_draft":
      return roleDraft(prisma, rest, context, serverId, ReadRoleDraftInput.parse(args));
    case "native_instantly_clone_role_draft": {
      const input = CloneRoleDraftInput.parse(args);
      const role = await requireRole(prisma, context, input.role_id);
      await roleDraftBinding(prisma, context, serverId, role.id, input.campaign_id);
      if (!context.runId) throw new Error("Start a role conversation before cloning a draft");
      const original = await rest("GET", `/campaigns/${input.campaign_id}`);
      if (
        original.id !== input.campaign_id ||
        !Array.isArray(original.sequences) ||
        !original.campaign_schedule
      )
        throw new Error("The complete saved sequence could not be read");
      // Copy template fields verbatim. Status, recipients, analytics and historical run state
      // are not POSTed; the provider's create operation always makes a new inactive draft.
      const fields = [
        "campaign_schedule",
        "sequences",
        "email_list",
        "stop_on_reply",
        "stop_on_auto_reply",
        "stop_for_company",
        "open_tracking",
        "link_tracking",
        "text_only",
        "insert_unsubscribe_header",
        "daily_limit",
        "daily_max_leads",
        "email_gap",
        "random_wait_max",
        "allow_risky_contacts",
      ];
      const body = Object.fromEntries(
        fields
          .filter((field) => original[field] !== undefined)
          .map((field) => [field, original[field]]),
      );
      return createAssociatedDraft(
        prisma,
        rest,
        context,
        serverId,
        role.id,
        "clone",
        input.client_nonce,
        input,
        { ...body, name: input.name },
      );
    }
    case "native_instantly_create_role_draft": {
      const input = CreateRoleDraftInput.parse(args);
      const role = await requireRole(prisma, context, input.role_id);
      const connected = await requireOwnMailbox(
        rest,
        input.eaccount,
        Boolean(owned?.mailboxes.has(input.eaccount.toLowerCase())),
      );
      return createAssociatedDraft(
        prisma,
        rest,
        context,
        serverId,
        role.id,
        "create",
        input.client_nonce,
        input,
        { ...campaignBody(input.name, input), email_list: connected ? [input.eaccount] : [] },
      );
    }
    case "native_instantly_update_role_draft": {
      const input = UpdateRoleDraftInput.parse(args);
      const role = await requireRole(prisma, context, input.role_id);
      const existing = await roleDraftBinding(
        prisma,
        context,
        serverId,
        role.id,
        input.campaign_id,
      );
      if (existing?.binding.campaignId !== input.campaign_id) throw new IsolationError();
      const effectKey = `instantly-sequence-draft:${serverId}:${role.id}:save:${input.campaign_id}:${input.expected_revision}`;
      const previous = await prisma.externalEffect.findUnique({
        where: { idempotencyKey: effectKey },
      });
      if (previous) {
        await reserveSequenceEffect(prisma, context, effectKey, input);
        return roleDraft(prisma, rest, context, serverId, input, campaignBody(input.name, input));
      }
      const campaign = await rest("GET", `/campaigns/${input.campaign_id}`);
      if (campaign.status !== DRAFT) throw new Error("Only a draft can be edited here");
      if (
        !editableDraft(campaign) ||
        draftDelivery(campaign).hours === null ||
        !Array.isArray(campaign.email_list) ||
        campaign.email_list.length !== 1
      )
        throw new Error("This sequence needs to be edited in its existing mail workspace");
      if (sequenceConfigurationRevision(campaign) !== input.expected_revision)
        throw new Error(
          "This sequence changed since it was opened. Reopen it before saving again.",
        );
      const connected = await requireOwnMailbox(
        rest,
        input.eaccount,
        Boolean(owned?.mailboxes.has(input.eaccount.toLowerCase())),
      );
      await reserveSequenceEffect(prisma, context, effectKey, input);
      try {
        // ponytail: this revision claim fences native editors. The provider has no CAS;
        // an external writer racing final GET/PATCH needs provider ETag/If-Match support.
        const expected = {
          ...campaignBody(input.name, input),
          email_list: connected ? [input.eaccount] : [],
        };
        await rest("PATCH", `/campaigns/${input.campaign_id}`, expected);
        await context.reauthorize?.();
        const observedAt = new Date().toISOString();
        const output = await roleDraft(prisma, rest, context, serverId, input, expected, effectKey);
        await prisma.externalEffect.updateMany({
          where: { idempotencyKey: effectKey },
          data: {
            status: "completed",
            result: {
              campaignId: input.campaign_id,
              ...(output.campaign
                ? savedSequenceObservation(context, serverId, observedAt, output.campaign)
                : {}),
            },
          },
        });
        await context.reauthorize?.();
        return output;
      } catch (error) {
        await prisma.externalEffect.updateMany({
          where: { idempotencyKey: effectKey, status: "executing" },
          data: { status: "unknown" },
        });
        throw error;
      }
    }
    case "native_instantly_create_campaign": {
      const input = CreateCampaignInput.parse(args);
      if (!direct) {
        const campaign = await createCampaign(rest, input);
        await bindCreatedCampaign(prisma, context, serverId, campaign, input.eaccount);
        return campaign;
      }
      if (!context.runId) throw new IsolationError("A run is required to create a campaign");
      // An email to someone the recruiter names goes out when they confirm it, not next weekday.
      const campaign = await createCampaign(rest, {
        ...input,
        send_hours: input.send_hours ?? "any_time",
      });
      if (typeof campaign.id !== "string") throw new Error("Instantly returned no campaign id");
      await prisma.externalEffect.create({
        data: {
          spaceId: context.spaceId,
          runId: context.runId,
          kind: "instantly_role_campaign",
          idempotencyKey: `instantly-direct-campaign:${serverId}:${campaign.id}`,
          status: "completed",
          request: { serverId, direct: true },
          result: {
            campaignId: campaign.id,
            campaignName: String(campaign.name ?? input.name),
            eaccount: input.eaccount,
            leads: {},
          },
        },
      });
      if (input.steps) await requireSavedEmail(rest, campaign.id);
      return {
        ...campaign,
        next: "Add the person with add_leads on this campaign_id, then call activate_campaign with this campaign_id and them as recipients; its card is the recruiter's one confirmation.",
      };
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
    case "native_instantly_get_campaign_analytics": {
      const observedAt = new Date().toISOString();
      return {
        ...(await rest(
          "GET",
          `/campaigns/analytics/overview?id=${CampaignIdInput.parse(args).campaign_id}`,
        )),
        observedAt,
      };
    }
    case "native_instantly_get_campaign": {
      const observedAt = new Date().toISOString();
      const campaign = await rest("GET", `/campaigns/${CampaignIdInput.parse(args).campaign_id}`);
      const senders = Array.isArray(campaign.email_list) ? campaign.email_list : [];
      const binding =
        owned && !senders.length
          ? await bindingOfCampaign(prisma, context, serverId, String(campaign.id))
          : null;
      const mailbox = typeof senders[0] === "string" ? senders[0] : binding?.binding.eaccount;
      const senderState =
        owned && mailbox ? await sendingMailboxState(accountRest, mailbox) : undefined;
      return {
        id: campaign.id,
        observedAt,
        name: campaign.name,
        status: campaign.status,
        stop_on_reply: campaign.stop_on_reply,
        email_gap: campaign.email_gap,
        // email_list is the sending mailbox; recipients are the leads.
        sendingMailbox: campaign.email_list,
        ...(senderState ? { senderState } : {}),
        ...(await leadDelivery(rest, campaign)),
        campaign_schedule: campaign.campaign_schedule,
        sequences: campaign.sequences,
      };
    }
    case "native_instantly_update_lead_interest":
      return rest("POST", "/leads/update-interest-status", UpdateLeadInterestInput.parse(args));
    case "native_instantly_activate_campaign":
      return activateCampaign(
        prisma,
        rest,
        context,
        serverId,
        ActivateCampaignInput.parse(args),
        Boolean(owned),
      );
    case "native_instantly_pause_campaign":
      return rest("POST", `/campaigns/${CampaignIdInput.parse(args).campaign_id}/pause`);
    case "native_instantly_get_email": {
      const input = EmailIdInput.parse(args);
      const original = await readEmail(rest, input.id);
      if (!input.check_sender) return original;
      let error: MailReplyErrorCode | undefined;
      if (owned) {
        try {
          await requireReplySendingMailboxReady(
            prisma,
            accountRest,
            context,
            serverId,
            original,
            String(original.eaccount ?? ""),
          );
        } catch (cause) {
          error = cause instanceof MailReplySendingError ? cause.code : "sender_unavailable";
        }
      }
      return { ...original, replySenderCheck: { ready: !error, ...(error ? { error } : {}) } };
    }
    case "native_instantly_reply_to_email": {
      const input = ReplyToEmailInput.parse(args);
      if (!owned) return replyToEmail(rest, input);
      const original = await readEmail(rest, input.reply_to_uuid);
      const mailbox = input.eaccount ?? String(original.eaccount ?? "");
      await requireReplySendingMailboxReady(
        prisma,
        accountRest,
        context,
        serverId,
        original,
        mailbox,
      );
      const scopedReply = ownedInstantlyRest(accountRest, {
        campaigns: owned.campaigns,
        mailboxes: new Set([...owned.mailboxes, mailboxKey(mailbox)]),
      });
      return replyToEmail(scopedReply, input, (email, currentOriginal) =>
        requireReplySendingMailboxReady(
          prisma,
          accountRest,
          context,
          serverId,
          currentOriginal,
          email,
        ),
      );
    }
    case "native_instantly_ensure_role_campaign": {
      const input = EnsureRoleCampaignInput.parse(args);
      return ensureRoleCampaign(prisma, rest, context, serverId, input).catch(
        async (error: unknown) => {
          // No mailbox yet: the role's saved email is still there to show.
          if (!(error instanceof Error) || !error.message.startsWith(NO_MAILBOX)) throw error;
          const roleId = input.role_id ?? (await activeRoleId(prisma, context));
          const steps =
            roleId &&
            (await savedRoleEmail(prisma, context, `${bindingKey(serverId, roleId)}:email`));
          if (!steps) throw error;
          return { campaign: null, savedEmail: steps, hasEmail: true, sending: NO_MAILBOX };
        },
      );
    }
    case "native_instantly_add_shortlist_leads":
      return addShortlistLeads(prisma, rest, context, serverId, AddShortlistLeadsInput.parse(args));
    default:
      throw new IsolationError();
  }
}
