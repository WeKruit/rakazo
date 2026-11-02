import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma as Sql } from "@rakazo/db";
import { z } from "zod";
import type { InstantlyRest } from "./instantly-native-writes.js";

const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\r\n<>]+$/);
const Prefix = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const EnsureSenderInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read") }),
  z.strictObject({
    operation: z.literal("propose"),
    display_name: DisplayName,
    address_prefix: Prefix.optional(),
    existing_email: z.email().optional(),
  }),
  z.strictObject({
    operation: z.literal("confirm"),
    display_name: DisplayName,
    email: z.email(),
    mode: z.enum(["create", "attach"]).optional(),
  }),
  z.strictObject({ operation: z.literal("select"), email: z.email() }),
]);

type Sender = {
  email: string;
  displayName: string;
  domain: string;
  emailProvider?: number;
  attached?: boolean;
  default?: boolean;
};
const key = (email: string) => `instantly-sender-mailbox:${email.trim().toLowerCase()}`;
const own = (context: AdapterContext) => ({ userId: context.userId, spaceId: context.spaceId });
const receiptScope = (context: AdapterContext) => ({
  spaceId: context.spaceId,
  run: own(context),
  kind: "instantly_sender_account",
});
const sender = (value: unknown): Sender | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<Sender>;
  return typeof row.email === "string" &&
    typeof row.displayName === "string" &&
    typeof row.domain === "string" &&
    (row.attached === true || typeof row.emailProvider === "number")
    ? (row as Sender)
    : undefined;
};
const is404 = (error: unknown) =>
  error instanceof Error && "status" in error && error.status === 404;

export async function confirmedSendingMailboxes(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: Pick<AdapterContext, "userId" | "spaceId">,
) {
  const rows = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      run: { userId: context.userId, spaceId: context.spaceId },
      kind: "instantly_sender_account",
      status: "completed",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { result: true },
  });
  return rows.flatMap((row) => {
    const value = sender(row.result);
    return value ? [value] : [];
  });
}

export async function defaultSendingMailbox(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: AdapterContext,
) {
  const senders = await confirmedSendingMailboxes(prisma, context);
  const selected = await prisma.externalEffect.findFirst({
    where: {
      spaceId: context.spaceId,
      run: own(context),
      kind: "instantly_sender_default",
      status: "completed",
    },
    orderBy: { updatedAt: "desc" },
    select: { result: true },
  });
  const email = (selected?.result as { email?: unknown } | null)?.email;
  return senders.find((row) => row.email === email)?.email ?? senders[0]?.email ?? null;
}

/** Provisioning and warmup are distinct: active warmup is ongoing, never a promised ready date. */
export async function sendingMailboxState(rest: InstantlyRest, email: string) {
  let account: Record<string, unknown>;
  try {
    account = await rest("GET", `/accounts/${encodeURIComponent(email)}`);
  } catch (error) {
    if (is404(error))
      return { state: "provisioning", usable: false, warmup: "unknown", readyAt: null };
    throw error;
  }
  if (typeof account.email !== "string" || account.email.toLowerCase() !== email.toLowerCase())
    throw new IsolationError();
  return {
    displayName: [account.first_name, account.last_name]
      .filter((part) => typeof part === "string" && part.trim())
      .join(" "),
    state:
      account.setup_pending === true
        ? "provisioning"
        : account.status === 1 && account.setup_pending === false
          ? "active"
          : "unavailable",
    usable: account.status === 1 && account.setup_pending === false,
    warmup:
      account.warmup_status === 1
        ? "active"
        : account.warmup_status === 0
          ? "paused"
          : "unavailable",
    warmupStartedAt:
      typeof account.timestamp_warmup_start === "string" ? account.timestamp_warmup_start : null,
    warmupScore: typeof account.stat_warmup_score === "number" ? account.stat_warmup_score : null,
    readyAt: null,
  };
}

export async function requireSendingMailboxReady(
  prisma: Pick<PrismaClient, "externalEffect">,
  rest: InstantlyRest,
  context: AdapterContext,
  email: string,
) {
  const mine = await confirmedSendingMailboxes(prisma, context);
  if (!mine.some((row) => row.email === email.trim().toLowerCase()))
    throw new IsolationError("Confirm this account's sending address before sending.");
  const state = await sendingMailboxState(rest, email);
  if (!state.usable)
    throw new Error(
      "This sending address is not active yet. The draft is saved; sending must wait.",
    );
  if (
    !("displayName" in state) ||
    state.displayName !== mine.find((row) => row.email === email.trim().toLowerCase())!.displayName
  )
    throw new Error(
      "The sending display name changed. Review this account's sender before sending.",
    );
  return state;
}

type OrderedAccount = { email: string; domain: string; emailProvider: number; displayName: string };
async function orderedAccounts(rest: InstantlyRest) {
  const items: OrderedAccount[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const result = await rest(
      "GET",
      `/dfy-email-account-orders/accounts?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!Array.isArray(result.items)) throw new Error("The sending domains could not be checked.");
    for (const raw of result.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (
        !row.timestamp_cancelled &&
        typeof row.email === "string" &&
        typeof row.domain === "string" &&
        typeof row.email_provider === "number" &&
        [1, 2, 3].includes(row.email_provider)
      )
        items.push({
          email: row.email.toLowerCase(),
          domain: row.domain.toLowerCase(),
          emailProvider: Number(row.email_provider),
          displayName: [row.first_name, row.last_name]
            .filter((part) => typeof part === "string" && part.trim())
            .join(" "),
        });
    }
    if (!result.next_starting_after) return items;
    if (typeof result.next_starting_after !== "string" || seen.has(result.next_starting_after))
      throw new Error("The sending domains could not be checked completely.");
    cursor = result.next_starting_after;
    seen.add(cursor);
  }
  throw new Error("The sending domains could not be checked completely.");
}

function orderBody(value: Sender, simulation: boolean) {
  const prefix = value.email.split("@")[0]!;
  return {
    items: [
      {
        domain: value.domain,
        email_provider: value.emailProvider,
        accounts: [{ email_address_prefix: prefix, first_name: value.displayName, last_name: "" }],
      },
    ],
    order_type: "extra_accounts",
    simulation,
  };
}
async function validateOrder(rest: InstantlyRest, value: Sender) {
  const report = await rest("POST", "/dfy-email-account-orders", orderBody(value, true));
  if (report.order_is_valid !== true || report.simulation !== true || report.order_placed === true)
    throw new Error(
      "That sending address cannot be set up on the current sending domain. Choose another address or ask the account owner to check the sending setup.",
    );
}

async function requireSenderApproval(
  prisma: PrismaClient,
  context: AdapterContext,
  serverId: string,
  args: unknown,
) {
  if (!context.runId || !context.botId || !context.senderConfirmationEffectId)
    throw new IsolationError("Confirm this sending address on its native approval card first.");
  const [effect, source] = await Promise.all([
    prisma.externalEffect.findUnique({
      where: { id: context.senderConfirmationEffectId },
      include: { run: { select: { userId: true, spaceId: true, botId: true, threadId: true } } },
    }),
    prisma.mcpServer.findFirst({
      where: { id: serverId, ...own(context), enabled: true },
      select: { revision: true },
    }),
  ]);
  if (
    !effect ||
    !source ||
    effect.status !== "executing" ||
    effect.runId !== context.runId ||
    effect.spaceId !== context.spaceId ||
    effect.run.userId !== context.userId ||
    effect.run.spaceId !== context.spaceId ||
    effect.run.botId !== context.botId
  )
    throw new IsolationError();
  const direct = boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool");
  const catalog = catalogApprovalDetails(effect.request, "__rakazoCatalogTool");
  const route = direct?.route ?? catalog?.route;
  const savedArgs = direct?.args ?? catalog?.args.arguments;
  if (
    route?.connectorId !== "mcp" ||
    route.resourceId !== serverId ||
    route.resourceRevision !== source.revision ||
    route.toolName !== "native_instantly_ensure_sender" ||
    stableJsonValue(savedArgs) !== stableJsonValue(args)
  )
    throw new IsolationError();
  const requestHash = createHash("sha256").update(stableJsonValue(effect.request)).digest("hex");
  const proofs = await prisma.event.findMany({
    where: {
      spaceId: context.spaceId,
      threadId: effect.run.threadId,
      runId: context.runId,
      type: "effect.approval.answered",
      payload: { path: ["effectId"], equals: effect.id },
    },
    select: { payload: true },
  });
  if (
    !proofs.some(
      ({ payload }) =>
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.effectId === effect.id &&
        payload.answer === "allow" &&
        payload.answeredByUserId === context.userId &&
        payload.requestHash === requestHash,
    )
  )
    throw new IsolationError("The sending-address setup was not confirmed.");
  return { effectId: effect.id, requestHash };
}

export async function senderApprovalDisplay(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: AdapterContext,
  args: unknown,
) {
  const input = EnsureSenderInput.parse(args);
  if (input.operation === "confirm")
    return { email: input.email, displayName: input.display_name, select: input.mode === "attach" };
  if (input.operation !== "select") return undefined;
  const value = (await confirmedSendingMailboxes(prisma, context)).find(
    (row) => row.email === input.email.toLowerCase(),
  );
  if (!value) throw new IsolationError();
  return { email: value.email, displayName: value.displayName, select: true };
}

async function ownedLegacySender(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  email: string,
  displayName: string,
): Promise<Sender> {
  const claim = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: key(email) },
    include: { run: { select: { userId: true, spaceId: true } } },
  });
  if (
    claim &&
    (claim.spaceId !== context.spaceId ||
      claim.run.userId !== context.userId ||
      claim.run.spaceId !== context.spaceId)
  )
    throw new IsolationError("That sending address belongs to another account.");
  const [proof] = await prisma.$queryRaw<{ owned: boolean; foreign: boolean }[]>(Sql.sql`
    SELECT coalesce(bool_or(e."spaceId"=${context.spaceId} AND r."spaceId"=${context.spaceId} AND r."userId"=${context.userId} AND e.request->>'serverId'=${serverId}),false) AS "owned",
      coalesce(bool_or(e."spaceId"<>${context.spaceId} OR r."spaceId"<>${context.spaceId} OR r."userId"<>${context.userId}),false) AS "foreign"
    FROM external_effects e JOIN runs r ON r.id=e."runId"
    WHERE e.kind='instantly_role_campaign' AND e.status='completed' AND lower(e.result->>'eaccount')=${email}
  `);
  if (!proof?.owned || proof.foreign)
    throw new IsolationError(
      "This address is not exclusively owned by this account. Its display name was not changed.",
    );
  const account = await rest("GET", `/accounts/${encodeURIComponent(email)}`);
  if (typeof account.email !== "string" || account.email.toLowerCase() !== email)
    throw new IsolationError();
  return { email, displayName, domain: email.split("@")[1]!, attached: true };
}

/** A confirmed sender is an existing native receipt, never authority to activate a campaign. */
export async function ensureSendingIdentity(
  prisma: PrismaClient,
  rest: InstantlyRest,
  context: AdapterContext,
  serverId: string,
  raw: unknown,
) {
  const input = EnsureSenderInput.parse(raw);
  await context.reauthorize?.();
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { sendingMailboxLimit: true },
  });
  const limit = settings?.sendingMailboxLimit ?? 2;
  const mine = await confirmedSendingMailboxes(prisma, context);
  if (input.operation === "read") {
    const pending = await prisma.externalEffect.findMany({
      where: { ...receiptScope(context), status: { in: ["executing", "unknown"] } },
      select: { id: true, result: true },
    });
    if (pending.length) {
      const observed = await orderedAccounts(rest);
      for (const row of pending) {
        const value = sender(row.result);
        if (
          value &&
          observed.some(
            (account) => account.email === value.email && account.displayName === value.displayName,
          )
        )
          await prisma.externalEffect.updateMany({
            where: { id: row.id, ...receiptScope(context), status: "unknown" },
            data: { status: "completed" },
          });
      }
    }
    const current = await confirmedSendingMailboxes(prisma, context);
    return {
      senders: await Promise.all(
        current.map(async ({ email, displayName }) => ({
          email,
          ...(await refreshMailbox(rest, email, displayName)),
        })),
      ),
      pending: pending.flatMap((row) => {
        const value = sender(row.result);
        return value && !current.some((item) => item.email === value.email)
          ? [
              {
                email: value.email,
                displayName: value.displayName,
                state: "setup_pending",
                readyAt: null,
              },
            ]
          : [];
      }),
      defaultMailbox: await defaultSendingMailbox(prisma, context),
      mailboxLimit: limit,
    };
  }
  if (input.operation === "select") {
    const selected = mine.find((row) => row.email === input.email.toLowerCase());
    if (!selected) throw new IsolationError();
    const confirmation = await requireSenderApproval(prisma, context, serverId, raw);
    await prisma.externalEffect.upsert({
      where: { idempotencyKey: `instantly-sender-default:${context.userId}:${context.spaceId}` },
      create: {
        spaceId: context.spaceId,
        runId: context.runId!,
        kind: "instantly_sender_default",
        status: "completed",
        idempotencyKey: `instantly-sender-default:${context.userId}:${context.spaceId}`,
        request: { serverId, confirmation },
        result: { email: selected.email },
      },
      update: { status: "completed", result: { email: selected.email } },
    });
    return { email: selected.email, displayName: selected.displayName, default: true };
  }
  if (input.operation === "propose" && input.existing_email) {
    const value = await ownedLegacySender(
      prisma,
      rest,
      context,
      serverId,
      input.existing_email.toLowerCase(),
      input.display_name,
    );
    return {
      state: "needs_confirmation",
      mode: "attach",
      email: value.email,
      displayName: value.displayName,
      mailboxLimit: limit,
    };
  }
  const accounts =
    input.operation === "confirm" && input.mode === "attach" ? [] : await orderedAccounts(rest);
  if (input.operation === "propose") {
    const domains = [...new Set(accounts.map((row) => row.domain))].sort();
    const domain = domains.find((name) => {
      const rows = accounts.filter((row) => row.domain === name);
      return (
        rows.length < 5 &&
        [1, 2].includes(rows[0]!.emailProvider) &&
        rows.every((row) => row.emailProvider === rows[0]!.emailProvider)
      );
    });
    if (!domain)
      throw new Error(
        "No existing sending domain has room for another address. Ask the account owner to check the sending setup; no new domain was purchased.",
      );
    const used = await prisma.externalEffect.count({
      where: { ...receiptScope(context), status: { in: ["executing", "unknown", "completed"] } },
    });
    if (used >= limit)
      return {
        state: "limit_reached",
        mailboxLimit: limit,
        message: `This account can have up to ${limit} sending addresses.`,
      };
    const suffix = createHash("sha256")
      .update(JSON.stringify([context.userId, context.spaceId]))
      .digest("hex")
      .slice(0, 8);
    const company =
      input.display_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 35) || "recruiting";
    const prefix = input.address_prefix ?? `${company}.${suffix}${used ? `.${used + 1}` : ""}`;
    const email = z.email().parse(`${prefix}@${domain}`);
    if (accounts.some((row) => row.email === email))
      throw new Error("That address is already in use. Choose a different address.");
    const value = {
      email,
      displayName: input.display_name,
      domain,
      emailProvider: accounts.find((row) => row.domain === domain)!.emailProvider,
    };
    await validateOrder(rest, value);
    return {
      state: "needs_confirmation",
      mode: "create",
      email,
      displayName: input.display_name,
      mailboxLimit: limit,
    };
  }
  const email = input.email.toLowerCase();
  const domain = email.split("@")[1]!;
  const domainAccounts = accounts.filter((row) => row.domain === domain);
  if (
    input.mode !== "attach" &&
    (!domainAccounts.length ||
      ![1, 2].includes(domainAccounts[0]!.emailProvider) ||
      domainAccounts.some((row) => row.emailProvider !== domainAccounts[0]!.emailProvider))
  )
    throw new IsolationError("Choose an address on an existing product sending domain.");
  const value: Sender =
    input.mode === "attach"
      ? await ownedLegacySender(prisma, rest, context, serverId, email, input.display_name)
      : {
          email,
          displayName: input.display_name,
          domain,
          emailProvider: domainAccounts[0]!.emailProvider,
        };
  const confirmation = await requireSenderApproval(prisma, context, serverId, raw);
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["sending-identity", context.userId, context.spaceId])}, 0))`;
    const existing = await tx.externalEffect.findUnique({
      where: { idempotencyKey: key(email) },
      include: { run: { select: { userId: true, spaceId: true } } },
    });
    if (existing) {
      if (
        existing.run.userId !== context.userId ||
        existing.spaceId !== context.spaceId ||
        existing.run.spaceId !== context.spaceId
      )
        throw new IsolationError();
      const recorded = sender(existing.result);
      if (!recorded || recorded.displayName !== value.displayName || recorded.email !== email)
        throw new IsolationError();
      if (existing.status === "failed") {
        const used = await tx.externalEffect.count({
          where: {
            ...receiptScope(context),
            status: { in: ["executing", "unknown", "completed"] },
          },
        });
        if (used >= limit)
          throw new Error(`This account can have up to ${limit} sending addresses.`);
        await tx.externalEffect.update({
          where: { id: existing.id },
          data: { status: "executing" },
        });
        return { created: true, effect: existing };
      }
      return { created: false, effect: existing };
    }
    if (!context.runId) throw new IsolationError();
    const used = await tx.externalEffect.count({
      where: { ...receiptScope(context), status: { in: ["executing", "unknown", "completed"] } },
    });
    if (used >= limit) throw new Error(`This account can have up to ${limit} sending addresses.`);
    const effect = await tx.externalEffect.create({
      data: {
        spaceId: context.spaceId,
        runId: context.runId,
        kind: "instantly_sender_account",
        status: "executing",
        idempotencyKey: key(email),
        request: { serverId, confirmation },
        result: value as unknown as Prisma.InputJsonValue,
      },
    });
    return { created: true, effect };
  });
  if (!outcome.created) {
    if (outcome.effect.status !== "completed")
      return { state: "setup_pending", email, displayName: value.displayName, readyAt: null };
    return { email, ...(await refreshMailbox(rest, email, value.displayName)) };
  }
  try {
    if (value.attached) {
      await context.reauthorize?.();
      const state = await refreshMailbox(rest, email, value.displayName);
      await context.reauthorize?.();
      await prisma.externalEffect.update({
        where: { id: outcome.effect.id },
        data: { status: "completed" },
      });
      return { email, ...state };
    }
    if (accounts.some((row) => row.email === email))
      throw new Error("That address is already in use. Choose a different address.");
    await validateOrder(rest, value);
    await context.reauthorize?.();
    await prisma.externalEffect.update({
      where: { id: outcome.effect.id },
      data: { status: "unknown" },
    });
    let ordered: Record<string, unknown>;
    try {
      ordered = await rest("POST", "/dfy-email-account-orders", orderBody(value, false));
    } catch (error) {
      if (
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number" &&
        [400, 401, 402, 403, 404, 409, 422, 429].includes(error.status)
      )
        await prisma.externalEffect.updateMany({
          where: { id: outcome.effect.id, status: "unknown" },
          data: { status: "failed" },
        });
      throw error;
    }
    if (
      ordered.order_placed === false ||
      (ordered.order_is_valid === false && ordered.order_placed !== true)
    ) {
      await prisma.externalEffect.updateMany({
        where: { id: outcome.effect.id, status: "unknown" },
        data: { status: "failed" },
      });
    }
    if (ordered.order_placed !== true || ordered.order_is_valid !== true)
      throw new Error(
        "The sending-address setup was not confirmed. Check its saved status before trying again.",
      );
    await context.reauthorize?.();
    await prisma.externalEffect.update({
      where: { id: outcome.effect.id },
      data: { status: "completed" },
    });
    return { email, ...(await refreshMailbox(rest, email, value.displayName)) };
  } catch (error) {
    await prisma.externalEffect.updateMany({
      where: { id: outcome.effect.id, status: "executing" },
      data: { status: "failed" },
    });
    // A provider order can have succeeded before a lost response. Retain its claim; never POST twice.
    throw error;
  }
}

async function refreshMailbox(rest: InstantlyRest, email: string, displayName: string) {
  let state = await sendingMailboxState(rest, email);
  if (state.usable && (!("displayName" in state) || state.displayName !== displayName)) {
    await rest("PATCH", `/accounts/${encodeURIComponent(email)}`, {
      first_name: displayName,
      last_name: "",
    });
    state = await sendingMailboxState(rest, email);
    if (!("displayName" in state) || state.displayName !== displayName)
      throw new Error("The sending display name has not been saved yet. Sending must wait.");
  }
  if (state.usable && state.warmup === "paused") {
    await rest("POST", "/accounts/warmup/enable", { emails: [email], include_all_emails: false });
    return { ...state, displayName, warmup: "starting" };
  }
  return { ...state, displayName };
}
