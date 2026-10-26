import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";

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
  body: z.string().min(1).max(20_000).describe("HTML; use <br/> for line breaks."),
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
    "Reads one campaign's name, status (0 draft, 1 active, 2 paused, 3 completed) and stop_on_reply.",
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
    "Returns the one Instantly campaign bound to a recruiting role, creating it (draft, stop-on-reply on, default mailbox) only if none exists. Idempotent; needs no arguments inside a role conversation. Pass steps to save the email sequence; they replace the copy of a draft or paused campaign. hasEmail says whether the campaign has an email to send. Also returns candidate_key -> lead id mappings.",
  ),
  tool(
    "add_shortlist_leads",
    AddShortlistLeadsInput,
    false,
    "Adds shortlisted candidates of a role to its campaign as leads (ensuring the campaign first). Skips candidates without an email and ones already in the campaign; records candidate_key -> lead id.",
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

function sequences(steps: z.output<typeof Step>[]) {
  return [
    {
      steps: steps.map((step) => ({
        type: "email",
        delay: step.delay_days,
        delay_unit: "days",
        variants: [{ subject: step.subject, body: step.body }],
      })),
    },
  ];
}
/** The first step's first variant, or null when the campaign has no email yet. */
function firstEmail(campaign: Record<string, unknown> | undefined) {
  const list = Array.isArray(campaign?.sequences) ? campaign.sequences : [];
  const steps = (list[0] as { steps?: unknown } | undefined)?.steps;
  const step = Array.isArray(steps) ? (steps[0] as { variants?: unknown }) : undefined;
  const variant = Array.isArray(step?.variants)
    ? (step.variants[0] as { subject?: unknown; body?: unknown })
    : undefined;
  return typeof variant?.subject === "string" && typeof variant.body === "string"
    ? { subject: variant.subject, body: variant.body }
    : null;
}

function campaignBody(name: string, setup: z.output<typeof CreateCampaignInput>) {
  return {
    name,
    campaign_schedule: {
      schedules: [
        {
          name: "Weekdays",
          timing: { from: "09:00", to: "17:00" },
          // ponytail: "1".."5" assumed Mon-Fri (docs do not define the day index); adjust in UI if off.
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
          timezone: providerTimezone(setup.timezone),
        },
      ],
    },
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

type RoleBinding = {
  campaignId: string;
  campaignName: string;
  eaccount: string;
  leads: Record<string, { leadId: string; email: string }>;
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
  recipients: { name: string | null; email: string }[];
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
): Promise<InstantlyActivationDisplay> {
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
    return [{ name: name || null, email: lead.email }];
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
        : (await sameTitleCampaigns(rest, role)).find(
            (entry) => entry.campaign.id !== mappedId && (!campaign || entry.leads),
          );
    if (campaign && !better) {
      const patched = campaign.stop_on_reply !== true;
      // New copy goes onto a draft or paused campaign; an active one keeps what is sending.
      const writeSteps = Boolean(input.steps) && ENROLLABLE.has(campaign.status as number);
      if (patched || writeSteps)
        await rest("PATCH", `/campaigns/${mappedId}`, {
          ...(patched ? { stop_on_reply: true } : {}),
          ...(writeSteps ? { sequences: sequences(input.steps!) } : {}),
        });
      return {
        created: false,
        stopOnReplyPatched: patched,
        stepsSaved: writeSteps,
        hasEmail: writeSteps || firstEmail(campaign) !== null,
        ...existing.binding,
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
  const adopt = (await sameTitleCampaigns(rest, role)).find(
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
  };
  if (stale)
    await prisma.externalEffect.update({
      where: { id: stale },
      data: { result: binding as unknown as Prisma.InputJsonValue },
    });
  else await recordBinding(prisma, context, key, role.id, serverId, binding);
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
async function sameTitleCampaigns(rest: InstantlyRest, role: { id: string; title: string }) {
  const found = await rest("GET", `/campaigns?search=${encodeURIComponent(role.title)}&limit=100`);
  const title = role.title.trim().toLowerCase();
  const matches = (Array.isArray(found.items) ? (found.items as Record<string, unknown>[]) : [])
    .filter(
      (campaign) =>
        typeof campaign.id === "string" &&
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
  const shortlisted = new Set(
    (
      await prisma.recruitingCandidate.findMany({
        where: {
          roleId: role.id,
          shortlisted: true,
          candidateKey: { in: input.candidates.map((candidate) => candidate.candidate_key) },
        },
        select: { candidateKey: true },
      })
    ).map((candidate) => candidate.candidateKey),
  );
  const notShortlisted = input.candidates.filter((c) => !shortlisted.has(c.candidate_key));
  const eligible = input.candidates.filter((c) => shortlisted.has(c.candidate_key));
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
      leads[candidate.candidate_key] = { leadId: hit.id, email: candidate.email };
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
      leads: pending.map(({ email, first_name, last_name, company_name }) => ({
        email,
        ...(first_name ? { first_name } : {}),
        ...(last_name ? { last_name } : {}),
        ...(company_name ? { company_name } : {}),
      })),
    });
    for (const created of (report.created_leads ?? []) as { index: number; id: string }[]) {
      const candidate = pending[created.index];
      if (!candidate || typeof created.id !== "string") continue;
      leads[candidate.candidate_key] = { leadId: created.id, email: candidate.email };
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
    notShortlisted: notShortlisted.map((c) => c.candidate_key),
    notCreatedByProvider: pending
      .filter((c) => !added.includes(c.candidate_key))
      .map((c) => c.candidate_key),
    leads,
    ...(report ? { providerReport: report } : {}),
  };
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
        email_list: campaign.email_list,
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
      return rest("POST", `/campaigns/${campaignId}/activate`);
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
