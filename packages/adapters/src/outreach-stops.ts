import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import { lookedUpContactEmails } from "./recruiting-research.js";

/**
 * Who an outside send must not reach, read from records, never from words: a person the recruiter
 * asked never to contact again (kept for this account by address), and a role's people on hold or
 * passed. Every send path (campaign and own-mailbox) checks the same facts before its card and
 * again before it sends.
 */
export type OutreachStop = "do_not_contact" | "on_hold" | "passed";

const KIND = "outreach_contact_stop";
const address = (email: string) => email.trim().toLowerCase();
const stopKey = (spaceId: string, email: string) =>
  `outreach-contact-stop:${spaceId}:${address(email)}`;

/** Records that this person is never contacted again from this account; sends nothing. */
export async function recordContactStop(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: Pick<AdapterContext, "spaceId" | "userId" | "runId">,
  email: string,
  campaignId: string | null,
) {
  if (!context.runId) throw new IsolationError("A run is required to record a stop");
  const idempotencyKey = stopKey(context.spaceId, email);
  const result = { email: address(email), stoppedAt: new Date().toISOString(), campaignId };
  const existing = await prisma.externalEffect.findUnique({ where: { idempotencyKey } });
  if (existing && existing.spaceId !== context.spaceId) throw new IsolationError();
  if (existing)
    await prisma.externalEffect.update({
      where: { id: existing.id },
      data: { status: "completed", result },
    });
  else
    await prisma.externalEffect.create({
      data: {
        spaceId: context.spaceId,
        runId: context.runId,
        kind: KIND,
        idempotencyKey,
        status: "completed",
        request: { email: address(email) },
        result,
      },
    });
}

/** Lifts a stop the recruiter takes back; the record stays, marked lifted. */
export async function liftContactStop(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: Pick<AdapterContext, "spaceId">,
  email: string,
) {
  const existing = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: stopKey(context.spaceId, email) },
  });
  if (existing?.spaceId !== context.spaceId || existing.kind !== KIND) return false;
  if (existing.status !== "completed") return false;
  await prisma.externalEffect.update({ where: { id: existing.id }, data: { status: "revoked" } });
  return true;
}

/**
 * The people of a planned send who must not get it, by lowercased address. `roleId` adds that
 * role's people on hold or passed, matched by the addresses the role's records hold for them.
 */
export async function outreachStops(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "spaceId" | "userId">,
  roleId: string | null,
  emails: readonly string[],
): Promise<Map<string, OutreachStop>> {
  const wanted = [...new Set(emails.map(address))];
  const stops = new Map<string, OutreachStop>();
  if (!wanted.length) return stops;
  // One unique record per address: a send names few people.
  const stopped = await Promise.all(
    wanted.map((email) =>
      prisma.externalEffect.findUnique({ where: { idempotencyKey: stopKey(context.spaceId, email) } }),
    ),
  );
  wanted.forEach((email, index) => {
    const row = stopped[index];
    if (row?.spaceId === context.spaceId && row.kind === KIND && row.status === "completed")
      stops.set(email, "do_not_contact");
  });
  if (!roleId) return stops;
  const decided = await prisma.recruitingCandidate.findMany({
    where: {
      roleId,
      role: { spaceId: context.spaceId, userId: context.userId },
      consideration: { not: Prisma.DbNull },
    },
    select: { candidateKey: true, consideration: true, occurrences: { select: { linkedinUrl: true } } },
  });
  const held = decided.flatMap((candidate) => {
    const operation = (candidate.consideration as { operation?: unknown } | null)?.operation;
    return operation === "hold" || operation === "pass" ? [{ ...candidate, operation }] : [];
  });
  if (!held.length) return stops;
  // The addresses this account holds for each held person: the role campaign's records and
  // saved contact lookups.
  const bindings = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      request: { path: ["roleId"], equals: roleId },
    },
    select: { result: true },
  });
  const byKey = new Map<string, string[]>();
  for (const { result } of bindings) {
    const binding = result as {
      leads?: Record<string, { email?: unknown }>;
      staged?: Record<string, { email?: unknown }>;
    } | null;
    for (const [key, lead] of [
      ...Object.entries(binding?.leads ?? {}),
      ...Object.entries(binding?.staged ?? {}),
    ])
      if (typeof lead?.email === "string")
        byKey.set(key, [...(byKey.get(key) ?? []), address(lead.email)]);
  }
  const found = await lookedUpContactEmails(prisma, context);
  for (const candidate of held) {
    const keys = [
      candidate.candidateKey,
      ...candidate.occurrences.map((occurrence) => linkedinPersonKey(occurrence.linkedinUrl)),
    ].filter((key): key is string => Boolean(key));
    const addresses = [
      ...(byKey.get(candidate.candidateKey) ?? []),
      ...keys.flatMap((key) => (found.get(key) ?? []).map((email) => address(email.address))),
    ];
    for (const email of addresses)
      if (wanted.includes(email) && !stops.has(email))
        stops.set(email, candidate.operation === "hold" ? "on_hold" : "passed");
  }
  return stops;
}

/** What the agent is told instead of a card or a send when someone must not be emailed. */
export function outreachStopRefusal(stops: Map<string, OutreachStop>): string {
  const why: Record<OutreachStop, string> = {
    do_not_contact: "the recruiter asked that they never be contacted again",
    on_hold: "they are on hold for this role",
    passed: "they were passed on for this role",
  };
  return `Nothing was sent and no card was shown: ${[...stops].map(([email, stop]) => `${email} (${why[stop]})`).join("; ")}. Tell the recruiter in one line, in plain words. Only if the recruiter says to contact them again: for a stop, call pause_campaign with their email and allow_again; for a hold or pass, resume them with recruiting_feedback; then send again.`;
}

type Rest = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;
type Binding = {
  campaignId?: unknown;
  campaignName?: unknown;
  leads?: Record<string, { email?: unknown }>;
  staged?: Record<string, { email?: unknown }>;
};

/**
 * Stops one person: takes them out of every campaign of this account that holds them (and the
 * campaign named), so no follow-up reaches them, and records that they are not contacted again.
 * The mail service has no per-person pause (Lead.status is read-only), so taking the lead out of
 * the campaign is the stop. Emails already sent stay sent. Sends nothing.
 */
export async function stopContact(
  prisma: PrismaClient,
  rest: Rest,
  context: AdapterContext,
  serverId: string,
  input: { email: string; campaign_id?: string | undefined; allow_again?: boolean | undefined },
) {
  const email = address(input.email);
  if (input.allow_again) {
    const lifted = await liftContactStop(prisma, context, email);
    return {
      email,
      allowedAgain: lifted,
      next: lifted
        ? "They can be contacted again. Nobody was added back to any campaign or emailed; a new email to them needs its own send and card."
        : "This person had no stop recorded; nothing changed.",
    };
  }
  const bindings = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      run: { userId: context.userId, spaceId: context.spaceId },
      request: { path: ["serverId"], equals: serverId },
    },
    select: { id: true, result: true },
  });
  const holds = (entries: Binding["leads"]) =>
    Object.values(entries ?? {}).some(
      (lead) => typeof lead?.email === "string" && address(lead.email) === email,
    );
  const holding = bindings.filter(({ result }) => {
    const binding = result as Binding | null;
    return Boolean(binding && (holds(binding.leads) || holds(binding.staged)));
  });
  const campaigns = new Set<string>(input.campaign_id ? [input.campaign_id] : []);
  for (const { result } of holding) {
    const id = (result as Binding).campaignId;
    if (typeof id === "string") campaigns.add(id);
  }
  const stoppedIn: string[] = [];
  for (const campaignId of campaigns) {
    const listed = await rest("POST", "/leads/list", {
      campaign: campaignId,
      contacts: [email],
      limit: 100,
    });
    const leads = (Array.isArray(listed.items) ? listed.items : []) as {
      id?: unknown;
      email?: unknown;
    }[];
    for (const lead of leads) {
      if (typeof lead.id !== "string" || typeof lead.email !== "string") continue;
      if (address(lead.email) !== email) continue;
      await rest("DELETE", `/leads/${lead.id}`);
      if (!stoppedIn.includes(campaignId)) stoppedIn.push(campaignId);
    }
  }
  // Out of the role's records too, so a later add or send does not bring them back.
  const keep = (entries: Binding["leads"]) =>
    Object.fromEntries(
      Object.entries(entries ?? {}).filter(
        ([, lead]) => typeof lead?.email !== "string" || address(lead.email) !== email,
      ),
    );
  for (const { id, result } of holding) {
    const binding = result as Binding;
    await prisma.externalEffect.update({
      where: { id },
      data: {
        result: {
          ...binding,
          leads: keep(binding.leads),
          ...(binding.staged ? { staged: keep(binding.staged) } : {}),
        } as Prisma.InputJsonValue,
      },
    });
  }
  await recordContactStop(prisma, context, email, input.campaign_id ?? stoppedIn[0] ?? null);
  return {
    email,
    stopped: true,
    stoppedInCampaigns: stoppedIn,
    next: `Recorded: ${email} is not contacted again from this account, and no follow-up goes to them${stoppedIn.length ? "" : " (no campaign of this account was emailing them)"}. Nothing was sent; emails already sent cannot be taken back. Tell the recruiter in one line, in plain words.`,
  };
}
