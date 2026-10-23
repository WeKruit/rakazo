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
const EnsureRoleCampaignInput = z.strictObject({
  role_id: z.string().min(1).max(100),
  eaccount: CampaignSetup.eaccount
    .optional()
    .describe("Sending mailbox; omit when exactly one Instantly account is connected."),
  steps: CampaignSetup.steps,
  timezone: CampaignSetup.timezone,
});
const AddShortlistLeadsInput = z.strictObject({
  role_id: z.string().min(1).max(100),
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
    CampaignIdInput,
    false,
    "Sends the campaign's first email to its leads by activating it (also resumes a paused one). This is the only way to send a campaign email; it shows the native confirmation card — call it and let the human confirm, do not refuse or ask for a thread.",
  ),
  tool("pause_campaign", CampaignIdInput, false, "Pauses a campaign; stops further sends."),
  tool(
    "ensure_role_campaign",
    EnsureRoleCampaignInput,
    false,
    "Returns the one Instantly campaign bound to a recruiting role, creating it (draft, stop-on-reply on) only if none exists. Idempotent. Also returns candidate_key -> lead id mappings.",
  ),
  tool(
    "add_shortlist_leads",
    AddShortlistLeadsInput,
    false,
    "Adds shortlisted candidates of a role to its campaign as leads. Skips candidates without an email and ones already in the campaign; records candidate_key -> lead id.",
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
    if (!response.ok) throw new InstantlyRestError(response.status);
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
          timezone: setup.timezone,
        },
      ],
    },
    ...(setup.steps
      ? {
          sequences: [
            {
              steps: setup.steps.map((step) => ({
                type: "email",
                delay: step.delay_days,
                delay_unit: "days",
                variants: [{ subject: step.subject, body: step.body }],
              })),
            },
          ],
        }
      : {}),
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

async function requireRole(prisma: PrismaClient, context: AdapterContext, roleId: string) {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: context.spaceId, userId: context.userId },
    select: { id: true, title: true },
  });
  if (!role) throw new IsolationError("Recruiting role not found");
  return role;
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
      if (patched) await rest("PATCH", `/campaigns/${mappedId}`, { stop_on_reply: true });
      return { created: false, stopOnReplyPatched: patched, ...existing.binding };
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
  let eaccount = input.eaccount ?? (stale ? existing!.binding.eaccount : undefined);
  if (!eaccount) {
    const accounts = await rest("GET", "/accounts?limit=2");
    const items = Array.isArray(accounts.items) ? (accounts.items as { email?: string }[]) : [];
    if (items.length !== 1 || typeof items[0]?.email !== "string")
      throw new Error("Pass eaccount: the sending mailbox is ambiguous or none is connected");
    eaccount = items[0].email;
  }
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
  const run = await prisma.run.findFirst({
    where: { id: context.runId, spaceId: context.spaceId, userId: context.userId },
    select: { thread: { select: { activeRecruitingRoleId: true } } },
  });
  const roleId = run?.thread.activeRecruitingRoleId;
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
  const existing = await readBinding(prisma, context, bindingKey(serverId, role.id));
  if (!existing) throw new Error("No campaign for this role yet; call ensure_role_campaign first");
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
      };
    }
    case "native_instantly_update_lead_interest":
      return rest("POST", "/leads/update-interest-status", UpdateLeadInterestInput.parse(args));
    case "native_instantly_activate_campaign":
      return rest("POST", `/campaigns/${CampaignIdInput.parse(args).campaign_id}/activate`);
    case "native_instantly_pause_campaign":
      return rest("POST", `/campaigns/${CampaignIdInput.parse(args).campaign_id}/pause`);
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
