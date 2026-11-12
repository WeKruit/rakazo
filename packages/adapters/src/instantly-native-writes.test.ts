import { boundDirectApprovalRequest } from "@rakazo/core";
import { mailReplyState, type Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  describeCampaignActivation,
  describeReplyToEmail,
  isNativeInstantlyWrite,
  nativeInstantlyWrites,
  ownedInstantly,
  ownedInstantlyRest,
  requireReplySendingMailboxReady,
  runInstantlyWrite,
} from "./instantly-native-writes.js";
import { mailReplyFromAnchor } from "./mail-reply.js";

const ORIGINAL = {
  id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
  subject: "Re: Founding Engineer",
  from_address_email: "ada@example.test",
  to_address_email_list: "team@example.test",
  eaccount: "team@example.test",
  timestamp_email: "2026-10-22T00:59:00Z",
  thread_id: "thread-1",
};
const context = { spaceId: "s", userId: "u", botId: "b" } as never;

it.each(["preserved", "flattened", "conflicting-fallback"])(
  "sends approved paragraph HTML and verifies the real rendered receipt: %s",
  async (mode) => {
    const text =
      'Hi Noah,\r\n\r\nThanks for "A&B" <机会>.\r\n\r\nBest,\r\nRecruiting Team\r\n\r\nP.S. I\'m ready.';
    const html =
      '<p>Hi Noah,<br /><br />Thanks for "A&amp;B" &lt;机会&gt;.<br /><br />Best,<br />Recruiting Team<br /><br />P.S. I\'m ready.</p>';
    const route = {
      connectorId: "mcp",
      resourceId: "server",
      toolName: "native_instantly_reply_to_email",
    };
    const args = {
      reply_to_uuid: ORIGINAL.id,
      subject: "Re: Founding Engineer",
      body: { text, html: "<p>Not approved</p>" },
    };
    let raw: Record<string, unknown> = {};
    const rest = vi.fn(async (method: string, path: string, payload?: unknown) => {
      if (path === `/emails/${ORIGINAL.id}`) return ORIGINAL;
      if (path === "/accounts/team%40example.test") return { email: ORIGINAL.eaccount };
      if (method !== "POST" || path !== "/emails/reply")
        throw new Error("Unexpected synthetic call");
      expect(payload).toMatchObject({ body: { text: text.replace(/\r\n/g, "\n"), html } });
      const returned = mode === "preserved" ? html : html.replaceAll("<br />", " ");
      raw = {
        ...ORIGINAL,
        id: "new-reply",
        ue_type: 3,
        to_address_email_list: ORIGINAL.from_address_email,
        subject: args.subject,
        body: {
          html: `<html><head><title>Ignore this title</title></head><body>${returned}</body></html>`,
          ...(mode === "conflicting-fallback" ? { text } : {}),
        },
      };
      return raw;
    });
    const result = await runInstantlyWrite(
      {} as never,
      rest as never,
      context,
      "server",
      route.toolName,
      args,
    );
    expect(result).toEqual(raw); // Raw provider fields are retained, not filled from approval text.
    expect(rest.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    const reply = mailReplyFromAnchor(route, args, ORIGINAL);
    const projected = mailReplyState(reply, {
      status: "completed",
      request: boundDirectApprovalRequest(route, args, "__rakazoCatalogTool") as Prisma.JsonArray,
      result: {
        structuredContent: { source: "local_native_instantly_rest", result: raw },
      } as Prisma.JsonObject,
      updatedAt: new Date("2026-11-02T04:32:00Z"),
    });
    expect(projected.status).toBe("sent");
    expect(projected.error).toBeUndefined();
    expect(projected.body.includes("\n")).toBe(mode === "preserved");
  },
);

describe("native reply_to_email", () => {
  it("is a registered sending write", () => {
    const tool = nativeInstantlyWrites.find((entry) => entry.name === "reply_to_email");
    expect(tool?.toolName).toBe("native_instantly_reply_to_email");
    expect(tool?.readOnly).toBe(false);
    expect(tool?.description).toContain("confirmation card");
    expect(isNativeInstantlyWrite("native_instantly_reply_to_email")).toBe(true);
    expect(isNativeInstantlyWrite("native_instantly_get_email")).toBe(true);
  });

  it("reads the original, checks the mailbox and posts the documented reply body", async () => {
    const rest = vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path === `/emails/${ORIGINAL.id}`) return ORIGINAL;
      if (method === "GET" && path === "/accounts/team%40example.test")
        return { email: "team@example.test" };
      if (method === "POST" && path === "/emails/reply") return { id: "sent-1" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const result = await runInstantlyWrite(
      {} as never,
      rest as never,
      context,
      "server",
      "native_instantly_reply_to_email",
      {
        reply_to_uuid: ORIGINAL.id,
        body: { text: "收到，谢谢" },
        cc_address_email_list: "copy@example.test",
      },
    );
    expect(result).toEqual({ id: "sent-1" });
    expect(rest).toHaveBeenLastCalledWith("POST", "/emails/reply", {
      reply_to_uuid: ORIGINAL.id,
      eaccount: "team@example.test",
      subject: "Re: Founding Engineer",
      body: { text: "收到，谢谢", html: "<p>收到，谢谢</p>" },
      cc_address_email_list: "copy@example.test",
    });
  });

  it("refuses a mailbox that does not hold the original email", async () => {
    const rest = vi.fn(async (method: string, path: string) => {
      if (path === `/emails/${ORIGINAL.id}`) return ORIGINAL;
      if (path.startsWith("/accounts/")) return { email: "other@example.test" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    await expect(
      runInstantlyWrite(
        {} as never,
        rest as never,
        context,
        "server",
        "native_instantly_reply_to_email",
        {
          reply_to_uuid: ORIGINAL.id,
          eaccount: "other@example.test",
          body: { text: "hi" },
        },
      ),
    ).rejects.toThrow("is not in the other@example.test mailbox");
    expect(rest).not.toHaveBeenCalledWith("POST", "/emails/reply", expect.anything());
  });

  it("describes the reply card without naming the vendor", async () => {
    const display = await describeReplyToEmail(async () => ORIGINAL, {
      reply_to_uuid: ORIGINAL.id,
      body: { text: "收到，谢谢" },
    });
    expect(display).toMatchObject({
      to: "ada@example.test",
      from: "team@example.test",
      subject: "Re: Founding Engineer",
      inReplyTo: "Re: Founding Engineer, 2026-10-22T00:59:00Z",
      body: "收到，谢谢",
    });
    expect(JSON.stringify(display)).not.toContain("Instantly");
  });
});

describe("activation card for one person's own first email", () => {
  const campaign = {
    id: "c-1",
    name: "Founding Engineer",
    status: 0,
    email_list: ["me@x.test"],
    sequences: [
      { steps: [{ variants: [{ subject: "{{rk_subject}}", body: "<p>{{rk_body}}</p>" }] }] },
    ],
  };
  const role = { subject: "Founding role", body: "Hi {{firstName}},\n\nOpen to a chat?" };
  const leads = [
    {
      id: "l1",
      email: "ada@x.test",
      first_name: "Ada",
      payload: { rk_subject: "Ada, your compiler work", rk_body: "Hi Ada,<br /><br />Just you." },
    },
    {
      id: "l2",
      email: "bob@x.test",
      first_name: "Bob",
      payload: { rk_subject: "Founding role", rk_body: "Hi Bob,<br /><br />Open to a chat?" },
    },
  ];
  const read = async (tool: string) =>
    tool === "native_instantly_get_campaign" ? campaign : { items: leads };
  const binding = { leads: {}, roleEmail: role, drafts: {} };

  it("shows that person's own email, which is what their variables hold", async () => {
    const display = await describeCampaignActivation(read, "c-1", null, binding, ["Ada"]);
    expect(display.recipients).toEqual([
      {
        name: "Ada",
        email: "ada@x.test",
        firstEmail: { subject: "Ada, your compiler work", body: "Hi Ada,<br /><br />Just you." },
      },
    ]);
    // Nobody on this card gets the role's email, so it is not shown.
    expect(display).not.toHaveProperty("firstEmail");
    expect(display.refusal).toBeUndefined();
  });

  it("names the sending mailbox from get_campaign when no role says it", async () => {
    const { email_list: _, ...rest } = campaign;
    const fromTool = async (tool: string) =>
      tool === "native_instantly_get_campaign"
        ? { ...rest, sendingMailbox: ["me@x.test"] }
        : { items: leads };
    const display = await describeCampaignActivation(fromTool, "c-1", null, null, ["ada@x.test"]);
    expect(display.mailbox).toBe("me@x.test");
  });

  it("shows the role's email for the people who keep it", async () => {
    const display = await describeCampaignActivation(read, "c-1", null, binding);
    expect(display.recipients.map((r) => r.firstEmail?.subject ?? null)).toEqual([
      "Ada, your compiler work",
      null,
    ]);
    expect(display.firstEmail).toEqual({
      subject: "Founding role",
      body: "<p>Hi {{firstName}},</p><p>Open to a chat?</p>",
    });
  });

  it("shows a waiting person the email the send will add for them", async () => {
    const display = await describeCampaignActivation(
      async (tool) =>
        tool === "native_instantly_get_campaign" ? { ...campaign, status: 1 } : { items: leads },
      "c-1",
      null,
      {
        ...binding,
        staged: { zoe: { email: "zoe@x.test", first_name: "Zoe" } },
        drafts: { "zoe@x.test": { subject: "Zoe, hello", body: "Hi Zoe" } },
      },
      ["zoe@x.test"],
    );
    expect(display.recipients).toEqual([
      {
        name: "Zoe",
        email: "zoe@x.test",
        firstEmail: { subject: "Zoe, hello", body: "Hi Zoe" },
      },
    ]);
  });

  it("refuses a card for someone whose variables hold no email", async () => {
    const display = await describeCampaignActivation(
      async (tool) =>
        tool === "native_instantly_get_campaign"
          ? campaign
          : { items: [...leads, { id: "l3", email: "cy@x.test", first_name: "Cy" }] },
      "c-1",
      null,
      binding,
      ["cy@x.test"],
    );
    expect(display.refusal).toMatch(/No first email is saved for Cy/);
    expect(display.recipients).toEqual([]);
  });
});

describe("native campaign analytics", () => {
  it("reads exact campaign totals through the existing read-only connection boundary", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const rest = vi.fn(async () => ({
      emails_sent_count: 3,
      open_count_unique: 2,
      reply_count_unique: 1,
    }));
    const tool = nativeInstantlyWrites.find(
      (tool) => tool.toolName === "native_instantly_get_campaign_analytics",
    );
    expect(tool?.readOnly).toBe(true);
    const result = await runInstantlyWrite(
      {} as never,
      rest,
      context,
      "server",
      "native_instantly_get_campaign_analytics",
      { campaign_id: id },
    );
    expect(rest).toHaveBeenCalledWith("GET", `/campaigns/analytics/overview?id=${id}`);
    expect(result).toEqual({
      emails_sent_count: 3,
      open_count_unique: 2,
      reply_count_unique: 1,
      observedAt: expect.any(String),
    });
  });
});

it("timestamps a campaign GET before slower lead reads finish", async () => {
  vi.useFakeTimers();
  const started = "2030-01-01T00:00:00.000Z";
  vi.setSystemTime(new Date(started));
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  try {
    const rest = vi.fn(async (_method: string, path: string) => {
      if (path === `/campaigns/${id}`) return { id, name: "Before pause", status: 1 };
      vi.setSystemTime(new Date("2030-01-01T00:00:10.000Z"));
      return { items: [] };
    });
    expect(
      await runInstantlyWrite(
        {} as never,
        rest,
        context,
        "server",
        "native_instantly_get_campaign",
        { campaign_id: id },
      ),
    ).toMatchObject({ id, status: 1, observedAt: started });
  } finally {
    vi.useRealTimers();
  }
});

describe("shared mail account isolation", () => {
  const MINE = "11111111-1111-4111-8111-111111111111";
  const THEIRS = "22222222-2222-4222-8222-222222222222";
  const NEW = "33333333-3333-4333-8333-333333333333";
  const account = () =>
    vi.fn(async (method: string, path: string) =>
      method === "POST" && path === "/campaigns" ? { id: NEW } : { ok: true, path },
    );

  it("reads and changes only this account's own campaigns", async () => {
    const rest = account();
    const own = ownedInstantlyRest(rest as never, {
      campaigns: new Set([MINE]),
      mailboxes: new Set(),
    });
    await expect(own("GET", `/campaigns/${MINE}`)).resolves.toMatchObject({ ok: true });
    await expect(own("POST", `/campaigns/${MINE}/activate`)).resolves.toMatchObject({ ok: true });
    await expect(own("POST", "/leads/list", { campaign: MINE })).resolves.toMatchObject({
      ok: true,
    });
    for (const [method, path, body] of [
      ["GET", `/campaigns/${THEIRS}`],
      ["POST", `/campaigns/${THEIRS}/pause`],
      ["PATCH", `/campaigns/${THEIRS}`, {}],
      ["GET", `/campaigns/analytics/overview?id=${THEIRS}`],
      ["POST", "/leads/list", { contacts: ["ada@example.test"] }],
      ["POST", "/leads/list", { campaign: THEIRS }],
      ["POST", "/leads/add", { campaign_id: THEIRS, leads: [] }],
      ["POST", "/leads/update-interest-status", { lead_email: "ada@example.test" }],
      ["GET", "/workspaces/current"],
    ] as const)
      await expect(own(method, path, body)).rejects.toThrow("does not belong to this account");
    expect(rest).toHaveBeenCalledTimes(3);
  });

  it("adds people to its own campaign without checking the rest of the shared account", async () => {
    const rest = account();
    const own = ownedInstantlyRest(rest as never, {
      campaigns: new Set([MINE]),
      mailboxes: new Set(),
    });
    await own("POST", "/leads/add", { campaign_id: MINE, leads: [], skip_if_in_workspace: true });
    expect(rest).toHaveBeenCalledWith("POST", "/leads/add", {
      campaign_id: MINE,
      leads: [],
      skip_if_in_workspace: false,
    });
  });

  it("never finds another account's campaign by name and owns the one it creates", async () => {
    const rest = account();
    const own = ownedInstantlyRest(rest as never, { campaigns: new Set(), mailboxes: new Set() });
    await expect(own("GET", "/campaigns?search=Founding%20Engineer&limit=100")).resolves.toEqual({
      items: [],
    });
    await own("POST", "/campaigns", { name: "Founding Engineer" });
    await expect(own("GET", `/campaigns/${NEW}`)).resolves.toMatchObject({ ok: true });
    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("refuses a raw campaign create in a role and other accounts' campaigns", async () => {
    const rest = account();
    const inRole = {
      run: {
        findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: "role-1" } })),
      },
    };
    await expect(
      runInstantlyWrite(
        inRole as never,
        rest as never,
        { ...(context as object), runId: "run-1" } as never,
        "server",
        "native_instantly_create_campaign",
        {},
        { campaigns: new Set(), mailboxes: new Set(["me@ours.test"]) },
      ),
    ).rejects.toThrow("ensure_role_campaign");
    await expect(
      runInstantlyWrite(
        {} as never,
        rest as never,
        context,
        "server",
        "native_instantly_get_campaign",
        { campaign_id: THEIRS },
        { campaigns: new Set([MINE]), mailboxes: new Set() },
      ),
    ).rejects.toThrow("does not belong to this account");
    expect(rest).not.toHaveBeenCalled();
  });

  it("outside a role, creates this account's own campaign for one email to a named address", async () => {
    const saved = {
      id: NEW,
      name: "Test note",
      sequences: [{ steps: [{ variants: [{ subject: "Test note", body: "<p>Hello</p>" }] }] }],
    };
    const rest = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === "/accounts/me%40ours.test") return { email: "me@ours.test" };
      if (method === "POST" && path === "/campaigns") {
        expect(body).toMatchObject({
          name: "Test note",
          email_list: ["me@ours.test"],
          campaign_schedule: { schedules: [{ timing: { from: "00:00", to: "23:59" } }] },
        });
        return { id: NEW, name: "Test note" };
      }
      if (method === "GET" && path === `/campaigns/${NEW}`) return saved;
      throw new Error(`unexpected ${method} ${path}`);
    });
    const create = vi.fn(async () => ({}));
    const prisma = {
      run: { findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: null } })) },
      sendingMailboxAssignment: { findMany: vi.fn(async () => []) },
      externalEffect: { create },
    };
    const result = await runInstantlyWrite(
      prisma as never,
      rest as never,
      { ...(context as object), runId: "run-1" } as never,
      "server",
      "native_instantly_create_campaign",
      {
        name: "Test note",
        eaccount: "me@ours.test",
        steps: [{ subject: "Test note", body: "Hello" }],
      },
      { campaigns: new Set(), mailboxes: new Set(["me@ours.test"]) },
    );
    expect(result).toMatchObject({ id: NEW, next: expect.stringContaining("activate_campaign") });
    // Recorded as this account's campaign, so add_leads and activate_campaign may use it.
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "instantly_role_campaign",
        status: "completed",
        idempotencyKey: `instantly-direct-campaign:server:${NEW}`,
        request: { serverId: "server", direct: true },
        result: expect.objectContaining({ campaignId: NEW, eaccount: "me@ours.test" }),
      }),
    });
  });

  it("lists and uses only this account's own sending mailboxes", async () => {
    const rest = vi.fn(async (method: string, path: string) =>
      path.startsWith("/accounts?")
        ? { items: [{ email: "Me@Ours.test" }, { email: "them@other.test" }] }
        : method === "POST" && path === "/campaigns"
          ? { id: NEW }
          : { ok: true },
    );
    const own = ownedInstantlyRest(rest as never, {
      campaigns: new Set([MINE]),
      mailboxes: new Set(["me@ours.test"]),
    });
    await expect(own("GET", "/accounts?limit=100")).resolves.toEqual({
      items: [{ email: "Me@Ours.test" }],
    });
    await expect(own("GET", "/accounts/me%40ours.test")).resolves.toEqual({ ok: true });
    await expect(own("POST", "/campaigns", { email_list: ["me@ours.test"] })).resolves.toEqual({
      id: NEW,
    });
    for (const [method, path, body] of [
      ["GET", "/accounts/them%40other.test"],
      ["POST", "/campaigns", { email_list: ["them@other.test"] }],
      ["PATCH", `/campaigns/${MINE}`, { email_list: ["me@ours.test", "them@other.test"] }],
      ["POST", "/emails/reply", { eaccount: "them@other.test", reply_to_uuid: MINE }],
    ] as const)
      await expect(own(method, path, body)).rejects.toThrow("mailbox does not belong");
  });

  it("finds the campaigns and senders this connection owns", async () => {
    const findMany = vi.fn(async () => [
      { kind: "instantly_role_campaign", result: { campaignId: MINE, eaccount: "Me@Ours.test" } },
      { kind: "instantly_role_campaign", result: { campaignId: MINE } },
      { kind: "instantly_sender_account", result: { email: "second@ours.test" } },
      { kind: "instantly_role_campaign", result: null },
    ]);
    await expect(
      ownedInstantly({ $queryRaw: findMany } as never, "s", "server", "owner"),
    ).resolves.toEqual({ campaigns: [MINE], mailboxes: ["second@ours.test"] });
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0]?.slice(1)).toEqual(["s", "server", "s", "owner"]);
  });
});

describe("reply sender checks before card creation", () => {
  it("checks the exact existing campaign sender without provisioning or POSTing", async () => {
    const original = { ...ORIGINAL, campaign_id: "campaign-proof" };
    const findUnique = vi.fn(async ({ where }: any) =>
      where.kind === "instantly_role_campaign"
        ? {
            result: { eaccount: ORIGINAL.eaccount, campaignId: "campaign-proof" },
          }
        : null,
    );
    const prisma = {
      run: { findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: "role-proof" } })) },
      sendingMailboxAssignment: { findMany: vi.fn(async () => []) },
      externalEffect: { findUnique },
    };
    const rest = vi.fn(async () => ({ email: ORIGINAL.eaccount, status: 1, setup_pending: false }));
    await expect(
      requireReplySendingMailboxReady(
        prisma as never,
        rest,
        { spaceId: "s", userId: "u", botId: "b", runId: "run-proof" } as never,
        "source-proof",
        original,
        ORIGINAL.eaccount,
      ),
    ).resolves.toMatchObject({ usable: true });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          idempotencyKey: "instantly-role-campaign:source-proof:role-proof",
          run: { userId: "u", spaceId: "s" },
          status: "completed",
          kind: "instantly_role_campaign",
          AND: [
            { request: { path: ["serverId"], equals: "source-proof" } },
            { request: { path: ["roleId"], equals: "role-proof" } },
            { result: { path: ["campaignId"], equals: "campaign-proof" } },
          ],
        }),
      }),
    );
    expect(rest.mock.calls).toEqual([["GET", "/accounts/team%40example.test"]]);
  });
  it("returns a blocked sender check from the read-only email tool", async () => {
    const prisma = { externalEffect: { findMany: vi.fn(async () => []) } };
    const rest = vi.fn(async () => ORIGINAL);
    const result = await runInstantlyWrite(
      prisma as never,
      rest as never,
      context,
      "source",
      "native_instantly_get_email",
      { id: ORIGINAL.id, check_sender: true },
      { campaigns: new Set(), mailboxes: new Set() },
    );
    expect(result).toMatchObject({
      replySenderCheck: { ready: false, error: "sender_unavailable" },
    });
    expect(rest.mock.calls).toHaveLength(1);
  });
});

it.each([false, true])(
  "rechecks the prior campaign's exact sender immediately before POST (anchor changed: %s)",
  async (changed) => {
    let reads = 0;
    const original = { ...ORIGINAL, campaign_id: "campaign-proof" };
    const prisma = {
      run: { findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: "role-proof" } })) },
      sendingMailboxAssignment: { findMany: vi.fn(async () => []) },
      externalEffect: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async (input: any) =>
          input.where.kind === "instantly_role_campaign" &&
          input.where.AND[2].result.equals === "campaign-proof"
            ? { result: { eaccount: ORIGINAL.eaccount, campaignId: "campaign-proof" } }
            : null,
        ),
      },
    };
    const rest = vi.fn(async (method: string, path: string) => {
      if (path === `/emails/${ORIGINAL.id}`)
        return {
          ...original,
          campaign_id: changed && ++reads > 1 ? "foreign-campaign" : original.campaign_id,
        };
      if (method === "GET" && path.startsWith("/accounts/"))
        return { email: ORIGINAL.eaccount, status: 1, setup_pending: false };
      if (method === "POST" && path === "/emails/reply") return { id: "sent-proof" };
      throw new Error("Unexpected provider request");
    });
    const owned = { campaigns: new Set([original.campaign_id]), mailboxes: new Set<string>() };
    const result = runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u", runId: "run-proof" } as never,
      "source-proof",
      "native_instantly_reply_to_email",
      { reply_to_uuid: ORIGINAL.id, body: { text: "Exact approved reply" } },
      owned,
    );
    if (changed) await expect(result).rejects.toThrow("sender_unavailable");
    else await expect(result).resolves.toEqual({ id: "sent-proof" });
    expect(rest.mock.calls.filter((call) => call[0] === "POST")).toHaveLength(changed ? 0 : 1);
    expect(owned.mailboxes.size).toBe(0);
  },
);

it("requires positive read-only sender proof and does not echo an unsupported sender error", async () => {
  const read = vi.fn(async () => ({
    ...ORIGINAL,
    replySenderCheck: { ready: false, error: "private-provider-id" },
  }));
  const result = await describeReplyToEmail(read, {
    reply_to_uuid: ORIGINAL.id,
    body: { text: "Exact reply" },
  });
  expect(read).toHaveBeenCalledWith("native_instantly_get_email", {
    id: ORIGINAL.id,
    check_sender: true,
  });
  expect(result.refusal).toBe("sender_unavailable");
  const missing = await describeReplyToEmail(async () => ORIGINAL, {
    reply_to_uuid: ORIGINAL.id,
    body: { text: "Exact reply" },
  });
  expect(missing.refusal).toBe("sender_unavailable");
});
