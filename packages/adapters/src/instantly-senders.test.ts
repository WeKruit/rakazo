import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import type { InstantlyRest } from "./instantly-native-writes.js";
import {
  InstantlyRestError,
  nativeInstantlyWrites,
  runInstantlyWrite,
} from "./instantly-native-writes.js";
import {
  adoptLegacySender,
  asksSenderCompanyName,
  defaultSendingMailbox,
  ensureSendingIdentity,
  isSenderRead,
  requireSendingMailboxReady,
  sendingMailboxState,
} from "./instantly-senders.js";

let approvedArgs: Record<string, unknown> = {};
let approvedAnswer = "allow";
const approvalRequest = () =>
  boundDirectApprovalRequest(
    {
      connectorId: "mcp",
      resourceId: "source",
      resourceRevision: 1,
      toolName: "native_instantly_ensure_sender",
    },
    approvedArgs,
    "__rakazoCatalogTool",
  );
const context: AdapterContext = {
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  runId: "run",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
  reauthorize: vi.fn(async () => undefined),
  senderConfirmationEffectId: "approval",
};
type Row = {
  id: string;
  kind: string;
  status: string;
  idempotencyKey: string;
  result: Record<string, unknown>;
  request: Record<string, unknown>;
  run: { userId: string; spaceId: string };
  spaceId: string;
};
function fixture(limit = 2, senderSelfSetup = true) {
  const rows: Row[] = [];
  const assignments: { email: string; userId: string; displayName: string; createdAt: Date }[] = [];
  const observed = [
    {
      email: "existing@product.test",
      domain: "product.test",
      email_provider: 1,
      first_name: "Existing",
      last_name: "",
      timestamp_cancelled: null,
    },
  ];
  const accounts = new Map<string, Record<string, unknown>>();
  let inTx = false;
  let orderCount = 0;
  let loseResponse = false;
  let txTail: Promise<void> = Promise.resolve();
  const matches = (row: Row, where: any) =>
    (!where.kind || row.kind === where.kind) &&
    (!where.spaceId || row.spaceId === where.spaceId) &&
    (!where.id || row.id === where.id) &&
    (!where.idempotencyKey || row.idempotencyKey === where.idempotencyKey) &&
    (!where.status ||
      (typeof where.status === "string"
        ? row.status === where.status
        : where.status.in.includes(row.status))) &&
    (!where.run || (row.run.userId === where.run.userId && row.run.spaceId === where.run.spaceId));
  const effect = {
    findMany: vi.fn(async ({ where }: any) => rows.filter((row) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null),
    count: vi.fn(async ({ where }: any) => rows.filter((row) => matches(row, where)).length),
    findUnique: vi.fn(async ({ where }: any) =>
      where.id === "approval"
        ? {
            id: "approval",
            status: "executing",
            runId: "run",
            spaceId: "space",
            request: approvalRequest(),
            run: { userId: "owner", spaceId: "space", botId: "bot", threadId: "thread" },
          }
        : (rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null),
    ),
    create: vi.fn(async ({ data }: any) => {
      const row: Row = {
        id: `effect-${rows.length}`,
        ...data,
        run: { userId: context.userId, spaceId: context.spaceId },
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((value) => value.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const found = rows.filter((row) => matches(row, where));
      found.forEach((row) => {
        Object.assign(row, data);
      });
      return { count: found.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const row = rows.find((value) => value.idempotencyKey === where.idempotencyKey);
      if (row) {
        Object.assign(row, update);
        return row;
      }
      return effect.create({ data: create });
    }),
  };
  const fake = {
    externalEffect: effect,
    sendingMailboxAssignment: {
      findMany: vi.fn(async ({ where }: any) =>
        assignments.filter((row) => row.userId === where.userId),
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ sendingMailboxLimit: limit, senderSelfSetup })),
    },
    run: {
      findFirst: vi.fn(async ({ where }: any) => ({
        id: where.id,
        botId: "bot",
        threadId: "thread",
        sourceMessageId: "source",
        thread: { activeRecruitingRoleId: "role" },
      })),
    },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
    mcpServer: { findFirst: vi.fn(async () => ({ revision: 1 })) },
    event: {
      findMany: vi.fn(async () => [
        {
          payload: {
            effectId: "approval",
            answeredByUserId: "owner",
            answer: approvedAnswer,
            requestHash: createHash("sha256")
              .update(stableJsonValue(approvalRequest()))
              .digest("hex"),
          },
        },
      ]),
    },
    $queryRaw: vi.fn(async () => [{ owned: true, foreign: false }]),
    $executeRaw: vi.fn(async () => 1),
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = txTail;
      let release!: () => void;
      txTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      inTx = true;
      try {
        return await callback(fake);
      } finally {
        inTx = false;
        release();
      }
    },
  };
  const rest = vi.fn<InstantlyRest>(async (method, path, body) => {
    expect(inTx).toBe(false);
    if (method === "GET" && path.startsWith("/dfy-email-account-orders/accounts?"))
      return { items: observed, next_starting_after: null };
    if (method === "POST" && path === "/dfy-email-account-orders") {
      const value = body as {
        simulation: boolean;
        order_type: string;
        items: {
          domain: string;
          accounts: { email_address_prefix: string; first_name: string; last_name: string }[];
        }[];
      };
      expect(value.order_type).toBe("extra_accounts");
      expect(value.items[0]!.domain).toBe("product.test");
      if (value.simulation) return { simulation: true, order_is_valid: true, order_placed: false };
      orderCount++;
      const who = value.items[0]!.accounts[0]!;
      const email = `${who.email_address_prefix}@product.test`;
      observed.push({
        email,
        domain: "product.test",
        email_provider: 1,
        first_name: who.first_name,
        last_name: who.last_name,
        timestamp_cancelled: null,
      });
      accounts.set(email, {
        email,
        first_name: who.first_name,
        last_name: who.last_name,
        status: 1,
        setup_pending: false,
        warmup_status: 0,
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("connection lost after order");
      }
      return { order_is_valid: true, order_placed: true };
    }
    if (method === "GET" && path.startsWith("/accounts/")) {
      const account = accounts.get(decodeURIComponent(path.slice("/accounts/".length)));
      if (!account) throw Object.assign(new Error("not found"), { status: 404 });
      return account;
    }
    if (method === "POST" && path === "/accounts/warmup/enable") {
      const value = body as { emails: string[]; include_all_emails: boolean };
      expect(value.include_all_emails).toBe(false);
      expect(value.emails).toHaveLength(1);
      accounts.get(value.emails[0]!)!.warmup_status = 1;
      return { id: "background-job", status: "pending" };
    }
    if (method === "PATCH" && path.startsWith("/accounts/")) {
      Object.assign(accounts.get(decodeURIComponent(path.slice("/accounts/".length)))!, body);
      return {};
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return {
    prisma: fake as unknown as PrismaClient,
    effect,
    rows,
    assignments,
    rest,
    observed,
    accounts,
    orders: () => orderCount,
    loseNextResponse: () => {
      loseResponse = true;
    },
  };
}
function approve(
  email: string,
  name = "Acme",
  choice = "use",
  extra: Record<string, unknown> = {},
) {
  approvedArgs = { operation: "confirm", email, display_name: name, ...extra };
  approvedAnswer = choice === "use" ? "allow" : "deny";
}
beforeEach(() => {
  vi.clearAllMocks();
});
it("proposes only an existing-domain address without ordering or exposing other mailboxes", async () => {
  const f = fixture();
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect(read).toMatchObject({ senders: [], defaultMailbox: null, mailboxLimit: 2 });
  expect(f.rest).not.toHaveBeenCalled();
  const proposal = (await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "propose",
    display_name: "Acme",
  })) as { email: string };
  expect(proposal.email).toMatch(/^acme\.[a-f0-9]{8}@product\.test$/);
  expect(JSON.stringify(proposal)).not.toContain("existing@product.test");
  expect(f.orders()).toBe(0);
  expect(f.rows).toHaveLength(0);
});
it("requires the genuine exact-address card, then orders once, warms up and reuses the first sender", async () => {
  const f = fixture();
  const email = "chosen@product.test";
  approve(email, "Acme", "change");
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "confirm",
      email,
      display_name: "Acme",
    }),
  ).rejects.toThrow("not confirmed");
  expect(f.orders()).toBe(0);
  approve(email);
  const first = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "confirm",
    email,
    display_name: "Acme",
  });
  expect(first).toMatchObject({
    email,
    displayName: "Acme",
    usable: true,
    warmup: "starting",
    readyAt: null,
  });
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "confirm",
    email,
    display_name: "Acme",
  });
  expect(f.orders()).toBe(1);
  expect(f.rows).toHaveLength(1);
  expect(await defaultSendingMailbox(f.prisma, context)).toBe(email);
  expect(await requireSendingMailboxReady(f.prisma, f.rest, context, email)).toMatchObject({
    usable: true,
    warmup: "active",
    readyAt: null,
  });
});
it("retains an uncertain paid order and reconciles it without a duplicate purchase", async () => {
  const f = fixture();
  const email = "uncertain@product.test";
  approve(email);
  f.loseNextResponse();
  const args = { operation: "confirm", email, display_name: "Acme" };
  await expect(ensureSendingIdentity(f.prisma, f.rest, context, "source", args)).rejects.toThrow(
    "connection lost",
  );
  expect(f.rows[0]?.status).toBe("unknown");
  expect(await ensureSendingIdentity(f.prisma, f.rest, context, "source", args)).toMatchObject({
    state: "setup_pending",
  });
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", { operation: "read" });
  expect(f.rows[0]?.status).toBe("completed");
  expect(f.orders()).toBe(1);
});
it("enforces the account limit and refuses another account's claimed address", async () => {
  const f = fixture(1);
  const email = "one@product.test";
  approve(email);
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "confirm",
    email,
    display_name: "Acme",
  });
  expect(
    await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "propose",
      display_name: "Other",
    }),
  ).toMatchObject({ state: "limit_reached", mailboxLimit: 1 });
  approve("two@product.test", "Other");
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "confirm",
      email: "two@product.test",
      display_name: "Other",
    }),
  ).rejects.toThrow("up to 1");
  f.rows[0]!.run.userId = "another-owner";
  approve(email);
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "confirm",
      email,
      display_name: "Acme",
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(f.orders()).toBe(1);
});
it("blocks unprovisioned, paused, unknown or changed senders using real state, with no guessed warmup date", async () => {
  const f = fixture();
  const email = "ready@product.test";
  approve(email);
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "confirm",
    email,
    display_name: "Acme",
  });
  f.accounts.get(email)!.setup_pending = true;
  await expect(requireSendingMailboxReady(f.prisma, f.rest, context, email)).rejects.toThrow(
    "must wait",
  );
  f.accounts.get(email)!.setup_pending = false;
  f.accounts.get(email)!.status = 2;
  await expect(requireSendingMailboxReady(f.prisma, f.rest, context, email)).rejects.toThrow(
    "must wait",
  );
  f.accounts.get(email)!.status = 1;
  f.accounts.get(email)!.first_name = "Changed";
  await expect(requireSendingMailboxReady(f.prisma, f.rest, context, email)).rejects.toThrow(
    "display name changed",
  );
  expect(await sendingMailboxState(f.rest, "absent@product.test")).toMatchObject({
    state: "provisioning",
    usable: false,
    readyAt: null,
  });
  await expect(
    requireSendingMailboxReady(f.prisma, f.rest, context, "unowned@product.test"),
  ).rejects.toThrow("Confirm this account");
});

it("keeps a confirmed pending sender's zero-recipient draft editable while refusing actual dispatch", async () => {
  const f = fixture();
  const email = "pending@product.test";
  approve(email);
  let campaign: Record<string, unknown> | undefined;
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  const rest = vi.fn<InstantlyRest>(async (method, path, body) => {
    if (method === "GET" && path === `/accounts/${encodeURIComponent(email)}`)
      throw new InstantlyRestError(404, "not provisioned");
    if (path === "/accounts?limit=100") return { items: [] };
    if (method === "POST" && path === "/campaigns") {
      campaign = { ...(body as object), id, status: 0 };
      return campaign;
    }
    if (method === "GET" && path === `/campaigns/${id}`) return campaign!;
    if (path === "/leads/list") return { items: [] };
    return f.rest(method, path, body);
  });
  const confirmed = await ensureSendingIdentity(f.prisma, rest, context, "source", {
    operation: "confirm",
    email,
    display_name: "Acme",
  });
  expect(confirmed).toMatchObject({ state: "provisioning", usable: false });
  Object.assign(f.prisma, {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
  });
  const owned = { campaigns: new Set<string>(), mailboxes: new Set([email]) };
  await runInstantlyWrite(
    f.prisma,
    rest,
    context,
    "source",
    "native_instantly_create_role_draft",
    {
      role_id: "role",
      client_nonce: "pending-draft",
      name: "Engineer",
      eaccount: email,
      steps: [{ subject: "Hello", body: "Saved draft", delay_days: 0 }],
    },
    owned,
  );
  expect(campaign).toMatchObject({ email_list: [], status: 0 });
  expect(f.rows.find((row) => row.kind === "instantly_role_campaign")?.result.eaccount).toBe(email);
  await expect(
    runInstantlyWrite(
      f.prisma,
      rest,
      context,
      "source",
      "native_instantly_activate_campaign",
      { campaign_id: id },
      { campaigns: new Set([id]), mailboxes: new Set([email]) },
    ),
  ).rejects.toThrow("must wait");
  expect(
    rest.mock.calls.some(([method, path]) => method === "POST" && path.endsWith("/activate")),
  ).toBe(false);
});

it("does not treat a No-first ordinary question card or injected tool argument as paid approval", async () => {
  const f = fixture();
  const email = "denied@product.test";
  approve(email);
  const ordinaryCard = {
    kind: "ask",
    text: `Acme <${email}>`,
    actions: [
      { id: "no", label: "No" },
      { id: "yes", label: "Yes" },
    ],
    answer: "no",
  };
  expect(ordinaryCard.actions[0]!.label).toBe("No");
  await expect(
    ensureSendingIdentity(
      f.prisma,
      f.rest,
      { ...context, senderConfirmationEffectId: undefined },
      "source",
      { operation: "confirm", email, display_name: "Acme" },
    ),
  ).rejects.toThrow("native approval");
  await expect(
    ensureSendingIdentity(
      f.prisma,
      f.rest,
      { ...context, senderConfirmationEffectId: undefined },
      "source",
      { operation: "confirm", email, display_name: "Acme", senderConfirmationEffectId: "approval" },
    ),
  ).rejects.toThrow();
  expect(f.orders()).toBe(0);
  expect(f.rows).toHaveLength(0);
});
it("refuses stale source or edited arguments after the native address approval", async () => {
  const f = fixture();
  approve("approved@product.test");
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "confirm",
      email: "changed@product.test",
      display_name: "Acme",
    }),
  ).rejects.toBeInstanceOf(Error);
  vi.mocked(f.prisma.mcpServer.findFirst).mockResolvedValueOnce({ revision: 2 } as never);
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", approvedArgs),
  ).rejects.toBeInstanceOf(Error);
  expect(f.orders()).toBe(0);
});
it.each(["structured", 400, 402, 408] as const)(
  "releases quota only for a definite no-order response: %s",
  async (rejection) => {
    const f = fixture(1);
    const email = "rejected@product.test";
    approve(email);
    const rest: InstantlyRest = async (method, path, body) => {
      if (
        method === "POST" &&
        path === "/dfy-email-account-orders" &&
        (body as { simulation?: boolean })?.simulation === false
      ) {
        if (rejection === "structured") return { order_placed: false, order_is_valid: false };
        throw new InstantlyRestError(rejection, "provider rejected or timed out");
      }
      return f.rest(method, path, body);
    };
    await expect(
      ensureSendingIdentity(f.prisma, rest, context, "source", approvedArgs),
    ).rejects.toThrow();
    expect(f.rows[0]?.status).toBe(rejection === 408 ? "unknown" : "failed");
    expect(f.orders()).toBe(0);
  },
);
it("keeps the claim after provider success followed by a 403 authorization failure", async () => {
  const f = fixture();
  approve("succeeded@product.test");
  let checks = 0;
  const live = {
    ...context,
    reauthorize: async () => {
      checks++;
      if (checks === 3)
        throw Object.assign(new Error("access revoked after placement"), { status: 403 });
    },
  };
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, live, "source", approvedArgs),
  ).rejects.toThrow("access revoked");
  expect(f.rows[0]?.status).toBe("unknown");
  expect(f.orders()).toBe(1);
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", approvedArgs);
  expect(f.orders()).toBe(1);
});
it("attaches an exclusively proven owned legacy sender, changes its name and never places an order", async () => {
  const f = fixture(1);
  const email = "legacy@product.test";
  f.accounts.set(email, {
    email,
    first_name: "Previous",
    last_name: "",
    setup_pending: false,
    status: 1,
    warmup_status: 1,
  });
  const proposal = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "propose",
    display_name: "Acme",
    existing_email: email,
  });
  expect(proposal).toMatchObject({ mode: "attach", email, displayName: "Acme" });
  approve(email, "Acme", "use", { mode: "attach" });
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", approvedArgs);
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", approvedArgs);
  expect(f.rows.filter((row) => row.kind === "instantly_sender_account")).toHaveLength(1);
  expect(f.accounts.get(email)?.first_name).toBe("Acme");
  expect(f.orders()).toBe(0);
  expect(f.rest.mock.calls.some(([, path]) => path.startsWith("/dfy-email-account-orders"))).toBe(
    false,
  );
});
it("keeps an account's exclusively used campaign mailbox as its sender without a card or rename", async () => {
  const f = fixture();
  const email = "legacy@product.test";
  f.accounts.set(email, {
    email,
    first_name: "Previous",
    last_name: "Sender",
    setup_pending: false,
    status: 1,
    warmup_status: 1,
  });
  vi.mocked(f.prisma.$queryRaw)
    .mockResolvedValueOnce([{ email }])
    .mockResolvedValueOnce([{ owned: true, foreign: false }]);
  expect(await adoptLegacySender(f.prisma, f.rest, context, "source")).toBe(email);
  expect(await defaultSendingMailbox(f.prisma, context)).toBe(email);
  expect(f.rows.find((row) => row.kind === "instantly_sender_account")?.result).toMatchObject({
    email,
    displayName: "Previous Sender",
    attached: true,
  });
  expect(f.rest.mock.calls.every(([method]) => method === "GET")).toBe(true);
  expect(await adoptLegacySender(f.prisma, f.rest, context, "source")).toBeNull();
});
it("never adopts a campaign mailbox another account also used", async () => {
  const f = fixture();
  vi.mocked(f.prisma.$queryRaw)
    .mockResolvedValueOnce([{ email: "shared@product.test" }])
    .mockResolvedValueOnce([{ owned: true, foreign: true }]);
  expect(await adoptLegacySender(f.prisma, f.rest, context, "source")).toBeNull();
  expect(f.rows.some((row) => row.kind === "instantly_sender_account")).toBe(false);
});
it("refuses a legacy sender shared with another owner before altering its display name", async () => {
  const f = fixture();
  const email = "ambiguous@product.test";
  vi.mocked(f.prisma.$queryRaw).mockResolvedValueOnce([{ owned: true, foreign: true }]);
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "propose",
      display_name: "Acme",
      existing_email: email,
    }),
  ).rejects.toThrow("not exclusively owned");
  expect(f.rest).not.toHaveBeenCalled();
  expect(f.orders()).toBe(0);
});

it("never lets a recruiter set up or buy a sender unless the deployment allows self setup", async () => {
  const f = fixture(2, false);
  expect(
    await ensureSendingIdentity(f.prisma, f.rest, context, "source", { operation: "read" }),
  ).toMatchObject({
    senders: [],
    selfSetup: false,
    missingSender: true,
    next: expect.stringContaining("cannot email candidates yet"),
  });
  const read = (await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  })) as { next: string };
  expect(read.next).not.toMatch(/@|contact us|emailing/);
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "propose",
      display_name: "Acme",
    }),
  ).rejects.toThrow("cannot email candidates yet");
  approve("chosen@product.test");
  await expect(
    ensureSendingIdentity(f.prisma, f.rest, context, "source", {
      operation: "confirm",
      email: "chosen@product.test",
      display_name: "Acme",
    }),
  ).rejects.toThrow("cannot email candidates yet");
  expect(f.rest).not.toHaveBeenCalled();
  expect(f.orders()).toBe(0);
  expect(f.rows).toHaveLength(0);
});

it("tells an account with a product mailbox that it never sends from the recruiter's own email", async () => {
  const f = fixture();
  vi.mocked(f.prisma.externalEffect.findMany).mockImplementation((async (args: {
    where: { kind?: string };
  }) =>
    args.where.kind === "instantly_sender_account"
      ? [
          {
            result: {
              email: "jo@send.example.test",
              displayName: "Jo",
              domain: "send.example.test",
              attached: true,
            },
          },
        ]
      : []) as never);
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect(read).toMatchObject({ next: expect.stringContaining("never the recruiter's own email") });
});

it("tells a self-signup account without a mailbox to send from its own email", async () => {
  const f = fixture(2, false);
  vi.mocked(f.prisma.user.findUnique).mockResolvedValue({ usageCreditLimit: 10_000 } as never);
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect(read).toMatchObject({ senders: [], next: expect.stringContaining("own connected email") });
  expect(JSON.stringify(read)).not.toContain("cannot email candidates yet");
  // 11-11 staging: "no sending mailbox" was said three times; the Gmail card is the one ask.
  expect(read).toMatchObject({ next: expect.stringContaining("request_connection once") });
  expect(JSON.stringify(read)).not.toContain("Integrations");
  // 11-13 staging: "I have no Gmail" ended on "nothing for you to do".
  expect(read).toMatchObject({ next: expect.stringContaining("never say there is nothing to do") });
  // 11-13 staging: "can't connect" got "no other way", and "is the draft kept" got "can't confirm".
  expect(read).toMatchObject({ next: expect.stringContaining("ready to copy") });
  expect(read).toMatchObject({ next: expect.stringContaining("answer yes") });
});

it("asks no company name until the turn read the sending email", () => {
  // Kruit once asked "which company name" first on an account that cannot set one up.
  expect(asksSenderCompanyName("请提供用于准备发件地址的公司名称")).toBe(true);
  expect(asksSenderCompanyName("Which company name should candidates see?")).toBe(true);
  expect(asksSenderCompanyName("这个岗位的地点是？")).toBe(false);
  expect(isSenderRead("instantly__mail__ensure_sender", { operation: "read" })).toBe(true);
  expect(
    isSenderRead("connectors_execute_tool", {
      id: "srv:native_instantly_ensure_sender",
      operation: "read",
    }),
  ).toBe(true);
  expect(
    isSenderRead("connectors_execute_tool", {
      id: "srv:native_instantly_ensure_sender",
      arguments: { operation: "read" },
    }),
  ).toBe(true);
  expect(isSenderRead("instantly__mail__ensure_sender", { operation: "propose" })).toBe(false);
  const description = nativeInstantlyWrites.find(
    (tool) => tool.name === "ensure_sender",
  )?.description;
  expect(description).toContain("Always call read first");
  expect(description).not.toContain("First ask the company name");
});

it("records an owner-assigned mailbox as this account's sender on its first read", async () => {
  const f = fixture(2, false);
  const email = "trial@product.test";
  f.accounts.set(email, {
    email,
    first_name: "Previous",
    last_name: "",
    setup_pending: false,
    status: 1,
    warmup_status: 1,
  });
  f.assignments.push({ email, userId: "owner", displayName: "Jane Agency", createdAt: new Date() });
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect(read).toMatchObject({
    senders: [{ email, displayName: "Jane Agency", state: "active" }],
    defaultMailbox: email,
  });
  expect(f.accounts.get(email)?.first_name).toBe("Jane Agency");
  expect(f.rows.filter((row) => row.kind === "instantly_sender_account")).toHaveLength(1);
  expect(f.rows[0]!.request).toMatchObject({ serverId: "source", adopted: "owner_assignment" });
  expect(f.orders()).toBe(0);
  await ensureSendingIdentity(f.prisma, f.rest, context, "source", { operation: "read" });
  expect(f.rows.filter((row) => row.kind === "instantly_sender_account")).toHaveLength(1);
});
it("adopts every mailbox the owner assigned, keeping each one's name when none is given", async () => {
  const f = fixture(2, false);
  const emails = ["noah@a.test", "liu@b.test", "n.liu@c.test"];
  for (const email of emails) {
    f.accounts.set(email, {
      email,
      first_name: "Noah",
      last_name: "Liu",
      setup_pending: false,
      status: 1,
      warmup_status: 1,
    });
    f.assignments.push({ email, userId: "owner", displayName: "", createdAt: new Date() });
  }
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect((read as { senders: { email: string; displayName: string }[] }).senders).toEqual(
    emails.map((email) => expect.objectContaining({ email, displayName: "Noah Liu" })),
  );
  expect(f.rows.filter((row) => row.kind === "instantly_sender_account")).toHaveLength(3);
  expect(f.accounts.get("liu@b.test")?.first_name).toBe("Noah");
});
it("never adopts an assigned mailbox another account already holds", async () => {
  const f = fixture(2, false);
  const email = "held@product.test";
  f.accounts.set(email, { email, first_name: "Other", status: 1, setup_pending: false });
  f.rows.push({
    id: "foreign",
    kind: "instantly_sender_account",
    status: "completed",
    idempotencyKey: `instantly-sender-mailbox:${email}`,
    result: { email, displayName: "Other", domain: "product.test", attached: true },
    request: { serverId: "source" },
    run: { userId: "someone-else", spaceId: "elsewhere" },
    spaceId: "elsewhere",
  });
  f.assignments.push({ email, userId: "owner", displayName: "", createdAt: new Date() });
  const read = await ensureSendingIdentity(f.prisma, f.rest, context, "source", {
    operation: "read",
  });
  expect(read).toMatchObject({ senders: [], defaultMailbox: null });
  expect(f.accounts.get(email)?.first_name).toBe("Other");
});
