import type { AdapterContext } from "@rakazo/adapter-kit";
import { toolRequiresApproval, toolRequiresExplicitApproval } from "@rakazo/core";
import * as schedulingDb from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarEvidenceHash } from "./calendar-approval.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import {
  allowlistDrift,
  DISCOVERY_CACHE_TTL_MS,
  DISCOVERY_FAILURE_TTL_MS,
  firstPartyMcpUrl,
  loadMcpCredentialRecord,
  McpConnector,
  requireMcpToolAssignment,
} from "./mcp-connector.js";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { type McpOAuthBroker, StoredMcpOAuthProvider } from "./mcp-oauth.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { schedulingPlanHash } from "./recruiting-scheduling.js";
import { rememberResolvedContactEmails } from "./recruiting-tools.js";
import { migrateSecrets } from "./secret-migration.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => vi.unstubAllGlobals());

const SERVER = {
  id: "server-1",
  slug: "demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

describe("MCP assignment denial identity", () => {
  it.each(["context", "assignment", "revision"])(
    "classifies %s denial without changing its message",
    async (failure) => {
      const findFirst = vi.fn(async () => (failure === "assignment" ? null : ASSIGNMENT));
      const context = {
        spaceId: "w1",
        userId: "u1",
        ...(failure === "context" ? {} : { botId: "bot-1" }),
      };
      await expect(
        requireMcpToolAssignment(
          { botMcpServer: { findFirst } } as never,
          context as never,
          { resourceId: SERVER.id, resourceRevision: failure === "revision" ? 2 : 1 },
          "tool",
        ),
      ).rejects.toMatchObject({
        name: "IsolationError",
        message:
          failure === "context"
            ? "MCP tools require a bot context"
            : failure === "assignment"
              ? "MCP tool is not assigned to this bot"
              : "MCP server changed; rediscover the tool before trying again",
      });
    },
  );
  it("maps local Instantly tools to the assigned get_email + list_emails gate on the official server", async () => {
    const check = (allowedTools: string[], endpoint = "https://mcp.instantly.ai/mcp") =>
      requireMcpToolAssignment(
        {
          botMcpServer: {
            findFirst: vi.fn(async () => ({
              ...ASSIGNMENT,
              allowAllTools: false,
              allowedTools,
              server: { ...SERVER, endpoint },
            })),
          },
        } as never,
        { spaceId: "w1", userId: "u1", botId: "bot-1" } as never,
        { resourceId: SERVER.id, resourceRevision: 1 },
        "native_instantly_ensure_role_campaign",
      );
    await expect(check(["get_email", "list_emails"])).resolves.toMatchObject({ botId: "bot-1" });
    for (const denied of [
      check([]),
      check(["get_email"]),
      check(["get_email", "list_emails"], SERVER.endpoint),
    ])
      await expect(denied).rejects.toMatchObject({
        name: "IsolationError",
        message: "MCP tool is not assigned to this bot",
      });
  });
  it("preserves an unexpected lookup failure by identity", async () => {
    const error = new Error("Database unavailable");
    const failure = requireMcpToolAssignment(
      { botMcpServer: { findFirst: vi.fn().mockRejectedValue(error) } } as never,
      { botId: "bot-1" } as never,
      { resourceId: SERVER.id, resourceRevision: 1 },
      "tool",
    );
    await expect(failure).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(IsolationError);
  });
});

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

describe("local native Instantly thread history", () => {
  const route = {
    connectorId: "mcp",
    resourceId: SERVER.id,
    resourceRevision: 1,
    toolName: "native_instantly_get_thread_history",
  };
  const anchor = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    organization_id: "123e4567-e89b-42d3-a456-426614174001",
    campaign_id: "123e4567-e89b-42d3-a456-426614174002",
    timestamp_created: "2026-10-22T10:00:00Z",
    timestamp_email: "2026-10-22T10:00:00Z",
    message_id: "<original@example.test>",
    thread_id: "opaque:thread + original",
    eaccount: "team@example.test",
    from_address_email: "person@example.test",
    to_address_email_list: "team@example.test",
    subject: "Original reply",
    body: { text: "Full original reply" },
    ue_type: 2,
  };
  function fixture(endpoint = "https://mcp.instantly.ai/mcp") {
    const context = {
      userId: "u1",
      spaceId: "w1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const server = {
      ...SERVER,
      userId: context.userId,
      spaceId: context.spaceId,
      enabled: true,
      endpoint,
      secretId: "key-1",
    };
    const assignment = {
      ...ASSIGNMENT,
      server,
      allowAllTools: false,
      allowedTools: ["get_email", "list_emails"],
    };
    const state = {
      key: "fixture-private-api-key",
      material: undefined as Record<string, unknown> | undefined,
      available: true,
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["get_email", "list_emails"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
      callResult: { content: [], structuredContent: structuredClone(anchor) },
      page: { items: [structuredClone(anchor)] } as Record<string, unknown>,
      status: 200,
      accounts: [] as string[],
      mailboxes: [] as string[],
      campaigns: {} as Record<string, unknown>,
      afterAnchor: () => {},
      afterRest: () => {},
    };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => (state.available ? [assignment] : [])),
        findFirst: vi.fn(async ({ where }) =>
          state.available &&
          where.userId === context.userId &&
          where.spaceId === context.spaceId &&
          where.botId === context.botId &&
          where.serverId === server.id &&
          server.enabled !== false
            ? assignment
            : null,
        ),
      },
      secret: {
        findFirst: vi.fn(async ({ where }) =>
          where.id === server.secretId &&
          where.userId === context.userId &&
          where.spaceId === context.spaceId
            ? { id: server.secretId, ciphertext: "encrypted-record" }
            : null,
        ),
      },
      mcpServer: {
        findFirst: vi.fn(async ({ where }) =>
          where.id === server.id &&
          where.userId === context.userId &&
          where.spaceId === context.spaceId &&
          where.endpoint === server.endpoint &&
          where.transport === server.transport
            ? server
            : null,
        ),
      },
    };
    const secrets = {
      load: vi.fn(async () => JSON.stringify(state.material ?? { secret: state.key })),
    };
    const native = mcpFetch(state, server.endpoint);
    const rest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe("GET");
      expect(new URL(request.url).origin).toBe("https://api.instantly.ai");
      expect(request.headers.get("authorization")).toBe(`Bearer ${state.key}`);
      if (new URL(request.url).pathname === "/api/v2/accounts")
        return Response.json({ items: state.mailboxes.map((email) => ({ email })) });
      const account = new URL(request.url).pathname.match(/^\/api\/v2\/accounts\/(.+)$/);
      if (account)
        return new Response("{}", {
          status: state.accounts.includes(decodeURIComponent(account[1]!)) ? 200 : 404,
        });
      const campaign = new URL(request.url).pathname.match(/^\/api\/v2\/campaigns\/(.+)$/);
      if (campaign) {
        const body = state.campaigns[decodeURIComponent(campaign[1]!)];
        return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
      }
      if (new URL(request.url).pathname === `/api/v2/emails/${anchor.id}`)
        return Response.json(state.callResult.structuredContent);
      expect(new URL(request.url).pathname).toBe("/api/v2/emails");
      state.afterRest();
      return new Response(JSON.stringify(state.page), { status: state.status });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(logicalHref(input, init)).origin === "https://api.instantly.ai")
          return rest(input, init);
        const response = await native(input, init);
        const request = new Request(input, init);
        if (request.method === "POST") {
          const rpc = await request.json();
          if (rpc.method === "tools/call") state.afterAnchor();
        }
        return response;
      }),
    );
    const connector = new McpConnector(prisma as never, secrets as never, {
      network: TEST_NETWORK,
    });
    const collect = async (
      args: Record<string, unknown> = { anchor_id: anchor.id },
      callRoute = route,
      actor = context,
    ) => {
      const events = [];
      for await (const event of connector.execute(
        {
          tool: "instantly__demo__get_thread_history",
          route: callRoute,
          args,
          executionId: "thread-read",
        },
        actor as never,
      ))
        events.push(event);
      return events;
    };
    return { connector, context, state, server, assignment, prisma, secrets, rest, collect };
  }
  it("discovers a separate read-only local tool and retains exact native anchor, REST page and controls", async () => {
    const f = fixture();
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      const tool = tools.find((tool) => tool.route?.toolName === route.toolName);
      expect(tool).toMatchObject({
        name: "instantly__demo__get_thread_history",
        readOnly: true,
        route,
      });
      expect(tool?.description).toMatch(/local native REST integration/i);
      expect(tool!.inputSchema.required).toEqual(["anchor_id"]);
      expect(toolRequiresApproval(tool!.name, true, tool!.readOnly)).toBe(false);
      const events = await f.collect({ anchor_id: anchor.id, limit: 5 });
      expect(events).toEqual([
        {
          type: "result",
          data: {
            structuredContent: {
              source: "local_native_instantly_rest",
              anchor: f.state.callResult,
              page: f.state.page,
              query: {
                search: `thread:${anchor.thread_id}`,
                eaccount: anchor.eaccount,
                mode: "emode_all",
                latest_of_thread: "false",
                preview_only: "false",
                limit: "5",
              },
              coverage: {
                scope: "exact_thread",
                anchorId: anchor.id,
                organizationId: anchor.organization_id,
                account: anchor.eaccount,
                threadId: anchor.thread_id,
                startingAfter: null,
                nextStartingAfter: null,
                anchorPresent: true,
                pageExhausted: true,
                bodiesComplete: true,
                returnedCount: 1,
                checkedAt: expect.any(String),
              },
            },
          },
        },
      ]);
      expect(f.rest).toHaveBeenCalledOnce();
      expect(new URL(logicalHref(...f.rest.mock.calls[0]!)).searchParams.get("search")).toBe(
        `thread:${anchor.thread_id}`,
      );
      expect(f.state.calls).toEqual(["get_email"]);
      expect(JSON.stringify(events)).not.toContain(f.state.key);
    } finally {
      await f.connector.close();
    }
  });
  it("looks up an exact contact through a separate read-only local tool with truthful page coverage", async () => {
    const f = fixture();
    const contactRoute = { ...route, toolName: "native_instantly_search_contact_emails" };
    const outbound = {
      ...anchor,
      id: anchor.campaign_id,
      lead: anchor.from_address_email,
      from_address_email: anchor.eaccount,
      to_address_email_list: `Other <other@example.test>, Person <${anchor.from_address_email}>`,
      body_fallback_reason: "too_large",
      ue_type: 3,
    };
    f.state.page = { items: [anchor, outbound], next_starting_after: "provider-next" };
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      const tool = tools.find((tool) => tool.route?.toolName === contactRoute.toolName);
      expect(tool).toMatchObject({
        name: "instantly__demo__search_contact_emails",
        readOnly: true,
        route: contactRoute,
      });
      expect(tool?.description).toMatch(/local native REST integration/i);
      expect(toolRequiresApproval(tool!.name, true, tool!.readOnly)).toBe(false);
      const args = {
        email: anchor.from_address_email,
        eaccount: anchor.eaccount,
        limit: 5,
        starting_after: "provider-prior",
      };
      const events = await f.collect(args, contactRoute);
      expect(events).toEqual([
        {
          type: "result",
          data: {
            structuredContent: {
              source: "local_native_instantly_rest",
              page: f.state.page,
              query: {
                lead: args.email,
                eaccount: args.eaccount,
                mode: "emode_all",
                latest_of_thread: "false",
                preview_only: "false",
                sort_order: "desc",
                limit: "5",
                starting_after: args.starting_after,
              },
              coverage: {
                scope: "exact_contact",
                contactEmail: args.email,
                account: args.eaccount,
                organizationIds: [anchor.organization_id],
                accounts: [anchor.eaccount],
                startingAfter: args.starting_after,
                nextStartingAfter: "provider-next",
                pageExhausted: false,
                bodiesComplete: false,
                returnedCount: 2,
                checkedAt: expect.any(String),
              },
            },
          },
        },
      ]);
      expect(f.rest).toHaveBeenCalledOnce();
      expect(f.state.calls).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(f.state.key);
      f.state.page = { items: [] };
      expect(await f.collect({ email: args.email }, contactRoute)).toMatchObject([
        {
          type: "result",
          data: {
            structuredContent: {
              page: { items: [] },
              coverage: {
                account: null,
                organizationIds: [],
                accounts: [],
                returnedCount: 0,
                pageExhausted: true,
              },
            },
          },
        },
      ]);
    } finally {
      await f.connector.close();
    }
  });
  it("defaults the contact lookup to the one connected mailbox and reports HTTP status + code", async () => {
    const f = fixture();
    const contactRoute = { ...route, toolName: "native_instantly_search_contact_emails" };
    f.state.mailboxes = ["team@example.test"];
    f.state.page = { items: [] };
    try {
      await f.connector.discoverTools(f.context as never);
      await f.collect({ email: "sumeetparekh1@gmail.com" }, contactRoute);
      const emails = f.rest.mock.calls
        .map((call) => new URL(logicalHref(...call)))
        .find((url) => url.pathname === "/api/v2/emails")!;
      expect(emails.searchParams.get("eaccount")).toBe("team@example.test");
      expect(emails.searchParams.get("lead")).toBe("sumeetparekh1@gmail.com");
      f.state.status = 400;
      f.state.page = { error: "invalid_query", message: "private provider detail" } as never;
      const failed = await f.collect({ email: "sumeetparekh1@gmail.com" }, contactRoute);
      expect(failed).toMatchObject([
        { type: "error", message: expect.stringContaining("HTTP 400 (invalid_query).") },
      ]);
      expect(JSON.stringify(failed)).not.toContain("private provider detail");
    } finally {
      await f.connector.close();
    }
  });
  it("refuses an agent contact lookup with an email not stored for that person", async () => {
    const f = fixture();
    vi.spyOn(
      f.connector as unknown as { instantlyCampaignScope: () => Promise<null> },
      "instantlyCampaignScope",
    ).mockResolvedValue(null);
    const contactRoute = { ...route, toolName: "native_instantly_search_contact_emails" };
    const run = { ...f.context, runId: "run-contact-gate" };
    f.state.page = { items: [] };
    try {
      await f.connector.discoverTools(f.context as never);
      expect(
        await f.collect({ email: "sumeet.parekh@gmail.com", name: "Sumeet" }, contactRoute, run),
      ).toEqual([
        {
          type: "error",
          message: "No stored email for Sumeet; resolve the contact first, never guess an address",
        },
      ]);
      expect(f.rest).not.toHaveBeenCalled();
      rememberResolvedContactEmails(run.runId, [
        { name: "Sumeet Parekh", email: "SumeetParekh1@gmail.com" } as never,
      ]);
      expect(
        await f.collect({ email: "sumeetparekh1@gmail.com", name: "Bob" }, contactRoute, run),
      ).toMatchObject([
        { type: "error", message: expect.stringMatching(/No stored email for Bob/) },
      ]);
      expect(
        await f.collect({ email: "sumeetparekh1@gmail.com", name: "sumeet" }, contactRoute, run),
      ).toMatchObject([{ type: "result" }]);
    } finally {
      await f.connector.close();
    }
  });
  it("checks campaign stop_on_reply once per replied campaign and warns when follow-ups would continue", async () => {
    const f = fixture();
    const contactRoute = { ...route, toolName: "native_instantly_search_contact_emails" };
    const offCampaign = "123e4567-e89b-42d3-a456-426614174009";
    const reply = { ...anchor, lead: anchor.from_address_email };
    const outbound = {
      ...anchor,
      id: "123e4567-e89b-42d3-a456-426614174003",
      campaign_id: offCampaign,
      lead: anchor.from_address_email,
      from_address_email: anchor.eaccount,
      to_address_email_list: anchor.from_address_email,
      ue_type: 1,
    };
    const nonLead = {
      ...anchor,
      id: "123e4567-e89b-42d3-a456-426614174004",
      campaign_id: offCampaign,
      lead: null,
    };
    const secondReply = { ...reply, id: "123e4567-e89b-42d3-a456-426614174005" };
    f.state.page = { items: [reply, secondReply, outbound, nonLead] };
    f.state.campaigns = {
      [anchor.campaign_id]: { id: anchor.campaign_id, stop_on_reply: false },
      [offCampaign]: { id: offCampaign, stop_on_reply: true },
    };
    try {
      await f.connector.discoverTools(f.context as never);
      const events = await f.collect({ email: anchor.from_address_email }, contactRoute);
      expect(events).toMatchObject([
        {
          type: "result",
          data: {
            structuredContent: {
              replyFollowUps: [
                {
                  campaignId: anchor.campaign_id,
                  stopOnReply: false,
                  warning: expect.stringMatching(/stop_on_reply is off/),
                },
              ],
            },
          },
        },
      ]);
      const campaignCalls = f.rest.mock.calls.filter((call) =>
        new URL(logicalHref(...call)).pathname.startsWith("/api/v2/campaigns/"),
      );
      expect(campaignCalls.map((call) => logicalHref(...call))).toEqual([
        `https://api.instantly.ai/api/v2/campaigns/${anchor.campaign_id}`,
      ]);
      expect(new Request(...campaignCalls[0]!).method).toBe("GET");
      f.state.campaigns[anchor.campaign_id] = { id: anchor.campaign_id, stop_on_reply: true };
      expect(await f.collect({ email: anchor.from_address_email }, contactRoute)).toMatchObject([
        {
          data: {
            structuredContent: {
              replyFollowUps: [{ campaignId: anchor.campaign_id, stopOnReply: true }],
            },
          },
        },
      ]);
      delete f.state.campaigns[anchor.campaign_id];
      const unverified = await f.collect({ email: anchor.from_address_email }, contactRoute);
      expect(unverified).toMatchObject([
        {
          type: "result",
          data: {
            structuredContent: {
              replyFollowUps: [
                {
                  campaignId: anchor.campaign_id,
                  stopOnReply: null,
                  warning: expect.stringMatching(/could not be confirmed/),
                },
              ],
            },
          },
        },
      ]);
      f.state.page = { items: [outbound, nonLead] };
      const quiet = await f.collect({ email: anchor.from_address_email }, contactRoute);
      expect(JSON.stringify(quiet)).not.toContain("replyFollowUps");
    } finally {
      await f.connector.close();
    }
  });
  it("lists one mailbox page, including non-campaign mail, scoped by eaccount, subject search and created window", async () => {
    const f = fixture();
    const mailboxRoute = { ...route, toolName: "native_instantly_list_mailbox_emails" };
    const direct = { ...anchor, campaign_id: null, subject: "Direct note" };
    f.state.page = { items: [direct] };
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      const tool = tools.find((tool) => tool.route?.toolName === mailboxRoute.toolName);
      expect(tool).toMatchObject({
        name: "instantly__demo__list_mailbox_emails",
        readOnly: true,
        route: mailboxRoute,
      });
      expect(toolRequiresApproval(tool!.name, true, tool!.readOnly)).toBe(false);
      const args = {
        eaccount: anchor.eaccount,
        search: "Direct note",
        min_timestamp_created: "2026-10-22T00:00:00Z",
        max_timestamp_created: "2026-10-23T00:00:00Z",
        limit: 5,
      };
      const events = await f.collect(args, mailboxRoute);
      const query = {
        eaccount: args.eaccount,
        search: args.search,
        min_timestamp_created: args.min_timestamp_created,
        max_timestamp_created: args.max_timestamp_created,
        sort_order: "desc",
        mode: "emode_all",
        latest_of_thread: "false",
        preview_only: "false",
        limit: "5",
      };
      expect(events).toMatchObject([
        {
          type: "result",
          data: {
            structuredContent: {
              source: "local_native_instantly_rest",
              page: f.state.page,
              query,
              coverage: {
                scope: "mailbox",
                account: args.eaccount,
                pageExhausted: true,
                returnedCount: 1,
              },
            },
          },
        },
      ]);
      expect(f.rest).toHaveBeenCalledOnce();
      const url = new URL(logicalHref(...f.rest.mock.calls[0]!));
      expect(`${url.origin}${url.pathname}`).toBe("https://api.instantly.ai/api/v2/emails");
      expect(Object.fromEntries(url.searchParams)).toEqual(query);
      expect(f.state.calls).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(f.state.key);
    } finally {
      await f.connector.close();
    }
  });
  it.each([
    [{}, false],
    [{ eaccount: "not-an-address" }, false],
    [{ eaccount: anchor.eaccount, lead: anchor.from_address_email }, false],
    [{ eaccount: anchor.eaccount, min_timestamp_created: "yesterday" }, false],
    [{ eaccount: anchor.eaccount, limit: 101 }, false],
    [{ eaccount: "other@example.test" }, true],
    [{ eaccount: anchor.eaccount, max_timestamp_created: "2026-10-22T09:00:00Z" }, true],
  ])("rejects malformed or out-of-scope mailbox listing: %j", async (args, reads) => {
    const f = fixture();
    f.state.page = { items: [anchor] };
    try {
      expect(
        await f.collect(args, { ...route, toolName: "native_instantly_list_mailbox_emails" }),
      ).toMatchObject([{ type: "error" }]);
      expect(f.rest).toHaveBeenCalledTimes(reads ? 1 : 0);
    } finally {
      await f.connector.close();
    }
  });
  it("explains an empty contact lookup whose contact and mailbox arguments are swapped", async () => {
    const f = fixture();
    const contactRoute = { ...route, toolName: "native_instantly_search_contact_emails" };
    f.state.page = { items: [] };
    f.state.accounts = [anchor.eaccount];
    try {
      const swapped = await f.collect(
        { email: anchor.eaccount, eaccount: anchor.from_address_email },
        contactRoute,
      );
      expect(swapped).toEqual([
        {
          type: "error",
          message: expect.stringContaining("pass the contact as email and the mailbox as eaccount"),
        },
      ]);
      expect(JSON.stringify(swapped)).not.toContain(f.state.key);
      expect(
        await f.collect(
          { email: anchor.from_address_email, eaccount: anchor.eaccount },
          contactRoute,
        ),
      ).toMatchObject([{ type: "result" }]);
    } finally {
      await f.connector.close();
    }
  });
  it.each(["lead", "participant", "account", "missing-body", "shape", "http", "count"])(
    "checks exact contact %s without silently widening the search or claiming full bodies",
    async (kind) => {
      const f = fixture();
      const row = { ...anchor, lead: anchor.from_address_email };
      if (kind === "lead") row.lead = "different@example.test";
      if (kind === "participant") row.from_address_email = "different@example.test";
      if (kind === "account") row.eaccount = "different@example.test";
      if (kind === "missing-body") row.body = {} as typeof row.body;
      f.state.page = { items: [row] };
      if (kind === "shape") f.state.page = { items: "invalid" };
      if (kind === "http") f.state.status = 401;
      if (kind === "count") f.state.page = { items: [row, row] };
      try {
        expect(
          await f.collect(
            { email: anchor.from_address_email, eaccount: anchor.eaccount, limit: 1 },
            { ...route, toolName: "native_instantly_search_contact_emails" },
          ),
        ).toMatchObject(
          kind === "missing-body"
            ? [
                {
                  type: "result",
                  data: { structuredContent: { coverage: { bodiesComplete: false } } },
                },
              ]
            : [{ type: "error" }],
        );
        // A returned lead reply also checks its campaign's stop_on_reply once.
        expect(f.rest).toHaveBeenCalledTimes(kind === "missing-body" ? 2 : 1);
        expect(f.state.calls).toEqual([]);
      } finally {
        await f.connector.close();
      }
    },
  );
  it.each(["get_email", "list_emails", "actor", "revision", "credential", "pointer"])(
    "fences contact lookup against changed %s",
    async (kind) => {
      const f = fixture();
      const before = kind === "get_email" || kind === "list_emails" || kind === "actor";
      if (kind === "get_email" || kind === "list_emails")
        f.assignment.allowedTools = f.assignment.allowedTools.filter((name) => name !== kind);
      f.state.afterRest = () => {
        if (kind === "revision") f.server.revision++;
        if (kind === "credential") f.state.key = "rotated-private-key";
        if (kind === "pointer") f.server.secretId = "rotated-secret";
      };
      try {
        const events = await f.collect(
          { email: anchor.from_address_email },
          { ...route, toolName: "native_instantly_search_contact_emails" },
          kind === "actor" ? { ...f.context, spaceId: "foreign" } : f.context,
        );
        expect(events).toMatchObject([{ type: "error" }]);
        // Default-mailbox lookup, then the contact page.
        expect(f.rest).toHaveBeenCalledTimes(before ? 0 : 2);
        expect(JSON.stringify(events)).not.toMatch(/private-key|fixture-private-api-key/);
      } finally {
        await f.connector.close();
      }
    },
  );
  it.each([
    {},
    { email: "not-an-address" },
    { email: anchor.from_address_email, limit: 101 },
    { email: anchor.from_address_email, eaccount: "team@example.test,other@example.test" },
    { email: anchor.from_address_email, starting_after: " " },
    { email: anchor.from_address_email, search: "broad query" },
  ])("rejects malformed contact search before provider reads: %j", async (args) => {
    const f = fixture();
    try {
      expect(
        await f.collect(args, { ...route, toolName: "native_instantly_search_contact_emails" }),
      ).toMatchObject([{ type: "error" }]);
      expect(f.rest).not.toHaveBeenCalled();
      expect(f.state.calls).toEqual([]);
    } finally {
      await f.connector.close();
    }
  });
  it.each(["too_large", "unavailable", "missing-body", "cursor", "empty"])(
    "retains honest %s page coverage without claiming an entire thread",
    async (kind) => {
      const f = fixture();
      if (kind === "too_large" || kind === "unavailable")
        f.state.page = { items: [{ ...anchor, body_fallback_reason: kind }] };
      if (kind === "missing-body") f.state.page = { items: [{ ...anchor, body: {} }] };
      if (kind === "cursor") f.state.page = { items: [anchor], next_starting_after: "opaque-next" };
      if (kind === "empty") f.state.page = { items: [] };
      try {
        const events = await f.collect({
          anchor_id: anchor.id,
          starting_after: "opaque-prior",
          limit: 100,
        });
        expect(events[0]).toMatchObject({
          type: "result",
          data: {
            structuredContent: {
              page: f.state.page,
              coverage: {
                startingAfter: "opaque-prior",
                nextStartingAfter: kind === "cursor" ? "opaque-next" : null,
                anchorPresent: kind !== "empty",
                pageExhausted: kind !== "cursor",
                bodiesComplete: !["too_large", "unavailable", "missing-body"].includes(kind),
              },
            },
          },
        });
        expect(JSON.stringify(events)).not.toContain('"complete":true');
      } finally {
        await f.connector.close();
      }
    },
  );
  it.each([
    "get_email",
    "list_emails",
    "actor",
    "revision",
    "endpoint",
    "disabled",
    "oauth",
    "ambiguous-key",
  ])("denies invalid %s before the REST read", async (kind) => {
    const f = fixture();
    if (kind === "get_email" || kind === "list_emails")
      f.assignment.allowedTools = f.assignment.allowedTools.filter((name) => name !== kind);
    if (kind === "revision") f.server.revision++;
    if (kind === "endpoint") f.server.endpoint = "https://other.example.test/mcp";
    if (kind === "disabled") Object.assign(f.server, { enabled: false });
    if (kind === "oauth")
      f.state.material = { oauth: { tokens: { access_token: "unrelated-audience" } } };
    if (kind === "ambiguous-key")
      f.state.material = {
        secret: f.state.key,
        headers: { Authorization: "Bearer conflicting-private-key" },
      };
    try {
      const events = await f.collect(
        undefined,
        route,
        kind === "actor" ? { ...f.context, userId: "foreign" } : f.context,
      );
      expect(events).toMatchObject([{ type: "error" }]);
      expect(f.rest).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toMatch(
        /fixture-private-api-key|conflicting-private-key|unrelated-audience/,
      );
    } finally {
      await f.connector.close();
    }
  });
  it.each(["after-anchor", "after-rest"])(
    "fences changed grants, revision and credentials %s",
    async (phase) => {
      for (const kind of ["grant", "revision", "credential", "pointer"]) {
        const f = fixture();
        const change = () => {
          if (kind === "grant") f.assignment.allowedTools = [];
          if (kind === "revision") f.server.revision++;
          if (kind === "credential") f.state.key = "changed-private-key";
          if (kind === "pointer") f.server.secretId = "changed-secret";
        };
        if (phase === "after-anchor") f.state.afterAnchor = change;
        else f.state.afterRest = change;
        try {
          expect(await f.collect()).toMatchObject([{ type: "error" }]);
          expect(f.rest).toHaveBeenCalledTimes(phase === "after-rest" ? 1 : 0);
        } finally {
          await f.connector.close();
        }
      }
    },
  );
  it.each([
    "thread_id",
    "organization_id",
    "campaign_id",
    "eaccount",
    "id",
    "shape",
    "http",
    "oversize",
  ])("rejects %s response without inventing an empty successful page", async (kind) => {
    const f = fixture();
    if (["thread_id", "organization_id", "campaign_id", "eaccount"].includes(kind))
      f.state.page = {
        items: [
          {
            ...anchor,
            [kind]:
              kind === "organization_id"
                ? anchor.campaign_id
                : kind === "campaign_id"
                  ? anchor.organization_id
                  : "foreign",
          },
        ],
      };
    if (kind === "id") f.state.callResult.structuredContent.id = anchor.campaign_id;
    if (kind === "shape") f.state.page = { items: "invalid" };
    if (kind === "http") f.state.status = 401;
    if (kind === "oversize") f.state.page = { items: [anchor], extra: "x".repeat(2_000_000) };
    try {
      expect(await f.collect()).toMatchObject([{ type: "error" }]);
      expect(f.rest).toHaveBeenCalledTimes(kind === "id" ? 0 : 1);
    } finally {
      await f.connector.close();
    }
  });
  it.each([
    "current",
    "ordinary",
    "legacy-key",
    "missing-effect",
    "foreign-owner",
    "changed-request",
    "completed-cancel",
    "uncertain-reschedule",
    "executing-cancel",
  ])(
    "revalidates scheduling confirmation after native anchor/account reads: %s",
    async (mutation) => {
      const f = fixture();
      f.assignment.allowedTools.push("reply_to_email");
      const replyRoute = { ...route, toolName: "native_instantly_reply_to_email" };
      const args = {
        reply_to_uuid: anchor.id,
        eaccount: anchor.eaccount,
        subject: "Interview confirmed",
        body: { text: "Exact approved confirmation" },
      };
      const actor = {
        ...f.context,
        runId: "run-1",
        schedulingConfirmationEffectId: "confirmation-1",
      };
      const plan = {
        id: "plan-1",
        createdAt: "2026-10-23T00:00:00Z",
        threadId: "thread-1",
        roleId: "role-1",
        roleTitle: "Engineer",
        expectedRoleRevision: 1,
        originalEmail: {
          sourceId: route.resourceId,
          providerMessageId: anchor.id,
          providerThreadId: anchor.thread_id,
          campaignId: anchor.campaign_id,
          eaccount: anchor.eaccount,
          savedRead: null,
          threadId: "thread-1",
          roleId: "role-1",
          emailId: "original",
          sourceName: "Mailbox",
          sender: anchor.from_address_email,
          subject: "Interview",
          date: null,
          snippet: false,
        },
        candidate: {
          candidateKey: "candidate-1",
          name: "Candidate",
          email: anchor.from_address_email,
          timeZone: "America/New_York",
        },
        interviewer: { name: "Host", email: anchor.eaccount, timeZone: "Europe/London" },
        calendar: {
          sourceId: "cal-1",
          sourceRevision: 1,
          eventTypeId: 42,
          availabilityEffectId: "slots",
          start: "2026-11-01T05:30:00Z",
          end: "2026-11-01T06:00:00Z",
          lengthInMinutes: 30,
        },
        mailSourceId: route.resourceId,
        mailSourceRevision: route.resourceRevision,
        mailRead: { effectId: "mail-read", linkedRunId: "run-1", messageId: null },
        bookingEffectId: "booking-1",
        confirmationEffectId: "confirmation-1",
        bookingStatus: "completed",
        confirmationStatus: "pending",
      } as const;
      const request = ["__rakazoCatalogTool", "direct", { route: replyRoute, args }];
      const evidence = {
        kind: "recruiting_scheduling",
        version: 1,
        planId: plan.id,
        operation: "confirm",
        requestHash: calendarEvidenceHash(request),
        planHash: schedulingPlanHash(plan),
        bookingEffectId: plan.bookingEffectId,
      };
      const confirmationEffect = {
        id: "confirmation-1",
        runId: actor.runId,
        spaceId: actor.spaceId,
        status: "executing",
        idempotencyKey: mutation === "legacy-key" ? "older-reconciled-key" : "thread-read",
        request,
        result: { schedulingApprovalEvidence: evidence },
        run: { threadId: "thread-1", userId: actor.userId, botId: actor.botId },
      };
      if (mutation === "foreign-owner") confirmationEffect.run.userId = "other-owner";
      if (mutation === "changed-request") evidence.requestHash = "0".repeat(64);
      const findUnique = vi.fn().mockResolvedValue(confirmationEffect);
      if (mutation === "missing-effect") findUnique.mockResolvedValue(null);
      Object.assign(f.prisma, { externalEffect: { findUnique } });
      const load = vi
        .spyOn(schedulingDb, "loadVerifiedRecruitingSchedulingPlan")
        .mockResolvedValue(plan);
      let nativeReads = 0;
      let changed = false;
      const bind = vi
        .spyOn(schedulingDb, "bindRecruitingSchedulingOperation")
        .mockImplementation(async () => {
          expect(nativeReads).toBeGreaterThanOrEqual(2);
          if (changed)
            throw new IsolationError("Booking changed while native reply evidence was read");
          return plan;
        });
      vi.spyOn(
        f.connector as unknown as { instantlyCampaignScope: () => Promise<unknown> },
        "instantlyCampaignScope",
      ).mockResolvedValue({ campaignIds: [anchor.campaign_id], workspaceKey: "role-1" });
      f.rest.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST") return Response.json({ id: "sent-confirmation" });
        nativeReads++;
        if (path.includes("/accounts/")) {
          changed = !["current", "legacy-key"].includes(mutation);
          return Response.json({ email: anchor.eaccount });
        }
        return Response.json(anchor);
      });
      try {
        const events = await f.collect(
          args,
          replyRoute,
          mutation === "ordinary" ? ({ ...f.context, runId: "run-1" } as typeof actor) : actor,
        );
        if (mutation === "ordinary") expect(findUnique).not.toHaveBeenCalled();
        else
          expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "confirmation-1" } }),
          );
        const rejectedIdentity = [
          "ordinary",
          "missing-effect",
          "foreign-owner",
          "changed-request",
        ].includes(mutation);
        expect(bind).toHaveBeenCalledTimes(rejectedIdentity ? 0 : 1);
        if (!rejectedIdentity)
          expect(bind).toHaveBeenCalledWith(
            f.prisma,
            expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
            {
              threadId: "thread-1",
              planId: plan.id,
              operation: "confirm",
              effectId: "confirmation-1",
            },
          );
        const posts = f.rest.mock.calls.filter((call) => new Request(...call).method === "POST");
        expect(posts).toHaveLength(
          ["current", "ordinary", "legacy-key"].includes(mutation) ? 1 : 0,
        );
        expect(events[0]).toMatchObject({
          type: ["current", "ordinary", "legacy-key"].includes(mutation) ? "result" : "error",
        });
      } finally {
        load.mockRestore();
        bind.mockRestore();
        await f.connector.close();
      }
    },
  );
  it.each(["native_instantly_get_email", "native_instantly_reply_to_email"])(
    "rejects foreign role campaign before exposing or replying via %s",
    async (toolName) => {
      const f = fixture();
      f.assignment.allowedTools.push("reply_to_email");
      vi.spyOn(
        f.connector as unknown as {
          instantlyCampaignScope: () => Promise<{ campaignIds: string[] }>;
        },
        "instantlyCampaignScope",
      ).mockResolvedValue({ campaignIds: [anchor.organization_id] });
      try {
        const args =
          toolName === "native_instantly_get_email"
            ? { id: anchor.id }
            : {
                reply_to_uuid: anchor.id,
                eaccount: anchor.eaccount,
                body: { text: "Synthetic reply" },
              };
        expect(await f.collect(args, { ...route, toolName })).toMatchObject([{ type: "error" }]);
        expect(f.rest).toHaveBeenCalledTimes(1);
        expect(new Request(...f.rest.mock.calls[0]!).method).toBe("GET");
      } finally {
        await f.connector.close();
      }
    },
  );
  it.each([
    "native_instantly_get_email",
    "native_instantly_list_mailbox_emails",
    "native_instantly_reply_to_email",
  ])("fences a role switch across native awaits for %s", async (toolName) => {
    const f = fixture();
    f.assignment.allowedTools.push("reply_to_email");
    f.state.accounts = [anchor.eaccount];
    const stable = { campaignIds: [anchor.campaign_id], workspaceKey: "role-a" };
    const scope = vi
      .spyOn(
        f.connector as unknown as { instantlyCampaignScope: () => Promise<unknown> },
        "instantlyCampaignScope",
      )
      .mockResolvedValueOnce(stable)
      .mockResolvedValueOnce(stable)
      .mockResolvedValue({ ...stable, workspaceKey: "role-b" });
    try {
      const args =
        toolName === "native_instantly_get_email"
          ? { id: anchor.id }
          : toolName === "native_instantly_list_mailbox_emails"
            ? { eaccount: anchor.eaccount }
            : {
                reply_to_uuid: anchor.id,
                eaccount: anchor.eaccount,
                body: { text: "Synthetic reply" },
              };
      expect(await f.collect(args, { ...route, toolName })).toMatchObject([{ type: "error" }]);
      expect(scope).toHaveBeenCalledTimes(3);
      expect(f.rest.mock.calls.every((call) => new Request(...call).method === "GET")).toBe(true);
      if (toolName === "native_instantly_reply_to_email")
        expect(
          f.rest.mock.calls.some((call) =>
            new URL(logicalHref(...call)).pathname.endsWith("/emails/reply"),
          ),
        ).toBe(false);
    } finally {
      await f.connector.close();
    }
  });
  it("filters existing native mailbox reads by exact current campaign", async () => {
    const f = fixture();
    vi.spyOn(
      f.connector as unknown as {
        instantlyCampaignScope: () => Promise<{ campaignIds: string[] }>;
      },
      "instantlyCampaignScope",
    ).mockResolvedValue({ campaignIds: [anchor.campaign_id] });
    try {
      expect(
        await f.collect(
          { eaccount: anchor.eaccount },
          { ...route, toolName: "native_instantly_list_mailbox_emails" },
        ),
      ).toMatchObject([{ type: "result" }]);
      const emailCall = f.rest.mock.calls.find(
        (call) => new URL(logicalHref(...call)).pathname === "/api/v2/emails",
      )!;
      const url = new URL(logicalHref(...emailCall));
      expect(url.searchParams.get("campaign_id")).toBe(anchor.campaign_id);
      expect(url.searchParams.get("eaccount")).toBe(anchor.eaccount);
    } finally {
      await f.connector.close();
    }
  });
  it.each([
    "get_thread_history",
    route.toolName,
    "search_contact_emails",
    "native_instantly_search_contact_emails",
  ])("handles offered remote %s explicitly without routing it to REST", async (toolName) => {
    const f = fixture();
    f.state.tools.push({ name: toolName, inputSchema: { type: "object" } });
    f.assignment.allowedTools.push(toolName);
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      const isContact = toolName.includes("contact");
      const localName = isContact ? "search_contact_emails" : "get_thread_history";
      expect(tools.some((tool) => tool.name === `instantly__demo__${localName}`)).toBe(false);
      expect(
        await f.collect(
          isContact ? { email: anchor.from_address_email } : undefined,
          isContact ? { ...route, toolName: "native_instantly_search_contact_emails" } : route,
        ),
      ).toMatchObject([{ type: "error" }]);
      expect(f.rest).not.toHaveBeenCalled();
      const remote = tools.find((tool) => tool.name === `mcp__demo__${toolName}`)!;
      expect(remote.readOnly).not.toBe(true);
      if (toolName === localName) {
        expect(await f.collect({}, remote.route as typeof route)).toMatchObject([
          { type: "result" },
        ]);
        expect(f.state.calls).toEqual([toolName]);
      }
    } finally {
      await f.connector.close();
    }
  });
  it.each([
    "get_thread_history",
    route.toolName,
    "search_contact_emails",
    "native_instantly_search_contact_emails",
  ])("does not intercept a third-party remote %s", async (toolName) => {
    const f = fixture("https://unrelated.example.test/mcp");
    f.assignment.allowedTools = [toolName];
    f.state.tools = [{ name: toolName, inputSchema: { type: "object" } }];
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.readOnly).not.toBe(true);
      expect(await f.collect({}, tools[0]!.route as typeof route)).toMatchObject([
        { type: "result" },
      ]);
      expect(f.state.calls).toEqual([toolName]);
      expect(f.rest).not.toHaveBeenCalled();
    } finally {
      await f.connector.close();
    }
  });
  it("preserves local read-only classification through the native lazy catalog without trusting remote hints", async () => {
    const f = fixture();
    const write = {
      name: "send_email",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };
    f.state.tools.push(
      write,
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `extra_${index}`,
        inputSchema: { type: "object" },
      })),
    );
    f.assignment.allowAllTools = true;
    try {
      const tools = await f.connector.discoverTools(f.context as never);
      const execute = tools.find((tool) => tool.route?.toolName === "__catalog_execute")!;
      expect(execute).toBeDefined();
      const resolve = async (toolName: string, args: Record<string, unknown>) =>
        f.connector.resolveCall(
          {
            tool: execute.name,
            route: execute.route,
            executionId: "lazy-history",
            args: { id: `${SERVER.id}:${toolName}`, arguments: args },
          },
          f.context as never,
        );
      const local = await resolve(route.toolName, { anchor_id: anchor.id });
      expect(local!.tool.readOnly).toBe(true);
      expect(toolRequiresApproval(local!.tool.name, true, local!.tool.readOnly)).toBe(false);
      const contact = await resolve("native_instantly_search_contact_emails", {
        email: anchor.from_address_email,
      });
      expect(contact!.tool.readOnly).toBe(true);
      expect(toolRequiresApproval(contact!.tool.name, true, contact!.tool.readOnly)).toBe(false);
      const remote = await resolve("send_email", {});
      expect(remote!.tool.readOnly).not.toBe(true);
      expect(toolRequiresApproval(remote!.tool.name, true, remote!.tool.readOnly)).toBe(true);
    } finally {
      await f.connector.close();
    }
  });
  it.each([
    {},
    { anchor_id: "not-a-uuid" },
    { anchor_id: anchor.id, limit: 0 },
    { anchor_id: anchor.id, limit: 101 },
    { anchor_id: anchor.id, starting_after: " " },
    { anchor_id: anchor.id, search: "anything" },
  ])("rejects malformed input before reading provider data: %j", async (args) => {
    const f = fixture();
    try {
      expect(await f.collect(args)).toMatchObject([{ type: "error" }]);
      expect(f.state.calls).toEqual([]);
      expect(f.rest).not.toHaveBeenCalled();
    } finally {
      await f.connector.close();
    }
  });
  it("reuses a raw Authorization API key only in the official REST bearer header", async () => {
    const f = fixture();
    f.state.material = { headers: { Authorization: f.state.key } };
    try {
      expect(await f.collect()).toMatchObject([{ type: "result" }]);
      expect(f.rest).toHaveBeenCalledOnce();
    } finally {
      await f.connector.close();
    }
  });
});

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

function mcpFetch(
  state: {
    failNext: boolean;
    initializations: number;
    headers?: Record<string, string>[];
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    calls?: string[];
    callError?: Error;
    callResult?: Record<string, unknown>;
  },
  expectedUrl = "https://mcp.example.test/mcp",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    state.headers?.push(Object.fromEntries(request.headers.entries()));
    if (logicalHref(input, init) !== expectedUrl)
      throw new Error(`Unexpected request: ${logicalHref(input, init)}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (message.method === "initialize") {
      state.initializations += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: state.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") {
      if (message.params?.name) state.calls?.push(message.params.name);
      if (state.callError) throw state.callError;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: state.callResult ?? { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("official Autumn task dispatch", () => {
  it.each(["get_task", "get_rows", "reply", "stop_task", "list_tasks"])(
    "denies an unowned %s call before connecting to the provider",
    async (toolName) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const load = vi.fn();
      const connector = new McpConnector(
        {
          botMcpServer: {
            findFirst: vi.fn().mockResolvedValue({
              ...ASSIGNMENT,
              server: { ...SERVER, endpoint: "https://api.autumn.ai/mcp" },
            }),
          },
          recruitingResearchTask: { findFirst: vi.fn().mockResolvedValue(null) },
          externalEffect: { findMany: vi.fn().mockResolvedValue([]) },
        } as never,
        { load } as never,
        { network: TEST_NETWORK },
      );
      const events = [];
      try {
        for await (const event of connector.execute(
          {
            tool: `mcp__autumn__${toolName}`,
            executionId: "isolated-call",
            route: { connectorId: "mcp", resourceId: SERVER.id, resourceRevision: 1, toolName },
            args: { task_id: "foreign-task" },
          },
          {
            spaceId: "w1",
            userId: "u1",
            botId: "bot-1",
            signal: new AbortController().signal,
          } as never,
        ))
          events.push(event);
        expect(events).toEqual([
          expect.objectContaining({
            type: "error",
            message: expect.stringMatching(/scoped research history/i),
          }),
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      } finally {
        await connector.close();
      }
    },
  );
});

it("denies an unowned FullEnrich job before connecting or loading credentials", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const load = vi.fn();
  const connector = new McpConnector(
    {
      botMcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          ...ASSIGNMENT,
          server: { ...SERVER, endpoint: "https://mcp.fullenrich.com/mcp" },
        }),
      },
      externalEffect: { findMany: vi.fn().mockResolvedValue([]) },
    } as never,
    { load } as never,
    { network: TEST_NETWORK },
  );
  try {
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "mcp__fullenrich__get_enrichment_results",
        executionId: "unowned-job",
        route: {
          connectorId: "mcp",
          resourceId: SERVER.id,
          resourceRevision: 1,
          toolName: "get_enrichment_results",
        },
        args: { enrichment_id: "foreign-job" },
      },
      {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never,
    ))
      events.push(event);
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        message: expect.stringMatching(/not available in your workspace/i),
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  } finally {
    await connector.close();
  }
});

describe("MCP connector session cache", () => {
  it.each(["direct", "catalog"])(
    "marks a thrown %s tool call uncertain and preserves returned provider errors",
    async (path) => {
      const state = {
        failNext: false,
        initializations: 0,
        calls: [] as string[],
        callError: new Error("response timed out: fixture-token") as Error | undefined,
        callResult: {
          isError: true,
          content: [{ type: "text", text: "provider rejected fixture-token" }],
        },
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ ...ASSIGNMENT, server: { ...SERVER, secretId: "secret-1" } }]),
            findFirst: vi.fn().mockResolvedValue({
              ...ASSIGNMENT,
              server: { ...SERVER, secretId: "secret-1" },
            }),
          },
          secret: {
            findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }),
          },
        } as never,
        { load: async () => JSON.stringify({ secret: "fixture-token" }) } as never,
        { network: TEST_NETWORK },
      );
      const context = {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never;
      const tool = (await connector.discoverTools(context))[0]!;
      const call = {
        tool: path === "direct" ? tool.name : "connectors_execute_tool",
        args: path === "direct" ? {} : { id: "server-1:echo", arguments: {} },
        route:
          path === "direct" ? tool.route : { connectorId: "mcp", toolName: "__catalog_execute" },
        executionId: "transport-test",
      };
      try {
        const failed = [];
        for await (const event of connector.execute(call, context)) failed.push(event);
        expect(failed).toEqual([
          { type: "error", message: expect.any(String), outcome: "uncertain" },
        ]);
        expect(JSON.stringify(failed)).not.toContain("fixture-token");
        expect(state.calls).toEqual(["echo"]);

        state.callError = undefined;
        const returned = [];
        for await (const event of connector.execute(call, context)) returned.push(event);
        expect(returned).toMatchObject([{ type: "result", data: { isError: true } }]);
        expect(JSON.stringify(returned)).not.toContain("fixture-token");
      } finally {
        await connector.close();
      }
    },
  );

  it.each(["assignment", "authorization", "session", "cancellation"])(
    "keeps a pre-dispatch %s failure an ordinary error",
    async (failure) => {
      const state = { failNext: failure === "session", initializations: 0, calls: [] as string[] };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
            findFirst:
              failure === "authorization"
                ? vi.fn().mockRejectedValue(new Error("lookup failed: Bearer fixture-token"))
                : vi.fn().mockResolvedValue(failure === "assignment" ? null : ASSIGNMENT),
          },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      const controller = new AbortController();
      const context = {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: controller.signal,
      } as never;
      try {
        if (failure === "cancellation") {
          await connector.discoverTools(context);
          controller.abort();
        }
        const events = [];
        for await (const event of connector.execute(
          {
            tool: "mcp__demo__echo",
            args: {},
            route: {
              connectorId: "mcp",
              resourceId: SERVER.id,
              resourceRevision: SERVER.revision,
              toolName: "echo",
            },
            executionId: "before-dispatch",
          },
          context,
        ))
          events.push(event);
        expect(events).toEqual([{ type: "error", message: expect.any(String) }]);
        expect(JSON.stringify(events)).not.toContain("fixture-token");
        expect(state.calls).toEqual([]);
      } finally {
        await connector.close();
      }
    },
  );

  it.each([
    "accepted",
    "live-refresh",
    "live-revoked",
    "live-endpoint",
    "live-later-notification",
    "revoked",
    "disabled",
    "endpoint",
    "transport",
    "revision",
    "foreign-owner",
    "pointer",
    "missing-secret",
    "ref",
    "digest",
    "later-notification",
    "cancelled",
  ])("publishes only the authoritative refreshed MCP connection: %s", async (change) => {
    const controller = new AbortController();
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: controller.signal,
    };
    const initial = {
      oauth: {
        obtainedAt: 1,
        tokens: {
          access_token: "expired-access",
          refresh_token: "initial-refresh",
          token_type: "bearer",
          expires_in: 1,
        },
      },
    };
    const accepted = {
      oauth: {
        obtainedAt: Date.now(),
        tokens: {
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
          token_type: "bearer",
          expires_in: 3600,
        },
      },
    };
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: "initial-secret" } };
    const current: Omit<typeof assignment.server, "secretId"> & {
      secretId: string | null;
      userId: string;
      spaceId: string;
      enabled: boolean;
    } = { ...assignment.server, userId: "u1", spaceId: "w1", enabled: true };
    let row: { id: string; ciphertext: string } | null = {
      id: "initial-secret",
      ciphertext: "initial-ref",
    };
    let notify = (_ref: string) => {};
    let afterLiveRefresh = false;
    const load = vi.fn(async (ref: string) => {
      if (ref === "initial-ref") return JSON.stringify(initial);
      if (
        change === "later-notification" ||
        (afterLiveRefresh && change === "live-later-notification")
      )
        notify(ref);
      if (change === "cancelled") controller.abort();
      return JSON.stringify(change === "digest" ? initial : accepted);
    });
    const findServer = vi.fn(
      async ({
        where,
      }: {
        where: { id: string; spaceId: string; userId: string; enabled: boolean };
      }) =>
        current.id === where.id &&
        current.spaceId === where.spaceId &&
        current.userId === where.userId &&
        current.enabled === where.enabled
          ? current
          : null,
    );
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      mcpServer: { findFirst: findServer },
      secret: { findFirst: vi.fn(async () => row) },
    };
    const refresh = vi.fn();
    let activeMaterial: OAuthMaterial | undefined;
    const providerFor: McpOAuthBroker["providerFor"] = async (
      _server,
      _context,
      loaded,
      persisted,
    ) => {
      if (!loaded) throw new Error("expected loaded OAuth material");
      activeMaterial = loaded.material;
      return new StoredMcpOAuthProvider(SERVER.id, loaded.material, async () => undefined, {
        refreshNetwork: async () => ({ fetch: globalThis.fetch, close: async () => undefined }),
        refresh: async () => {
          refresh();
          Object.assign(loaded.material, structuredClone(accepted));
          row = { id: "accepted-secret", ciphertext: "accepted-ref" };
          current.secretId = row.id;
          persisted?.({ id: row.id, ref: row.ciphertext, material: accepted });
          // The broker adopts its committed grant before flushing the native store notification.
          notify(row.ciphertext);
          if (change === "revoked") current.secretId = null;
          if (change === "disabled") current.enabled = false;
          if (change === "endpoint") current.endpoint = "https://other.example.test/mcp";
          if (change === "transport") current.transport = "sse";
          if (change === "revision") current.revision += 1;
          if (change === "foreign-owner") current.userId = "u2";
          if (change === "pointer") current.secretId = "other-secret";
          if (change === "missing-secret") row = null;
          if (change === "ref") row!.ciphertext = "other-ref";
        },
      });
    };
    const state = { failNext: false, initializations: 0, calls: [] as string[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(
      prisma as never,
      {
        load,
        onChange(listener: (ref: string) => void) {
          notify = listener;
          return () => {};
        },
      } as never,
      { network: TEST_NETWORK },
      { providerFor } as McpOAuthBroker,
    );
    try {
      const tools = await connector.discoverTools(context as never);
      expect(refresh).toHaveBeenCalledOnce();
      const succeeds = change === "accepted" || change.startsWith("live-");
      expect(tools).toHaveLength(succeeds ? 1 : 0);
      expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(
        succeeds ? 1 : 0,
      );
      expect(prisma.secret.findFirst).toHaveBeenLastCalledWith({
        where: { id: "accepted-secret", userId: "u1", spaceId: "w1" },
      });
      if (["missing-secret", "ref"].includes(change)) expect(findServer).not.toHaveBeenCalled();
      else
        expect(findServer).toHaveBeenCalledWith({
          where: { id: SERVER.id, userId: "u1", spaceId: "w1", enabled: true },
        });
      if (change.startsWith("live-")) {
        activeMaterial!.oauth!.obtainedAt = 1;
        const events = [];
        for await (const event of connector.execute(
          {
            tool: tools[0]!.name,
            args: {},
            executionId: "live-refresh",
            route: tools[0]!.route,
          },
          context as never,
        ))
          events.push(event);
        expect(events).toMatchObject([{ type: "result" }]);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1);
        afterLiveRefresh = true;
        if (change === "live-refresh") {
          await connector.discoverTools(context as never);
          expect(state.initializations).toBe(1);
        } else {
          if (change === "live-revoked") current.secretId = null;
          if (change === "live-endpoint") current.endpoint = "https://other.example.test/mcp";
          notify("accepted-ref");
          const denied = [];
          for await (const event of connector.execute(
            {
              tool: tools[0]!.name,
              args: {},
              executionId: "after-live-change",
              route: tools[0]!.route,
            },
            context as never,
          ))
            denied.push(event);
          expect(denied).toMatchObject([{ type: "error" }]);
          expect(state.calls).toEqual(["echo"]);
          expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(
            0,
          );
        }
      } else if (change === "accepted") {
        await connector.discoverTools(context as never);
        expect(refresh).toHaveBeenCalledOnce();
        expect(state.initializations).toBe(1);
      }
    } finally {
      await connector.close();
    }
  });

  it("keeps sessions across unchanged TTL reads and reconnects on observed rotation", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({ ...fake.options, cacheTtlMs: 100 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const reads = fake.fetcher.mock.calls.length;
      await connector.discoverTools(context);
      expect(fake.fetcher).toHaveBeenCalledTimes(reads);
      expect(state.initializations).toBe(1);
      const changed = vi.fn();
      store.onChange(changed);
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      expect(changed).not.toHaveBeenCalled();
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(changed).toHaveBeenCalledExactlyOnceWith(record.ref);
      expect(state.initializations).toBe(2);
      expect(state.headers.some((headers) => headers.authorization === "Bearer rotated")).toBe(
        true,
      );
    } finally {
      await connector.close();
      await store.close();
      vi.useRealTimers();
    }
  });

  it("detects rotation after digest eviction and evicts deleted credentials", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({
      ...fake.options,
      cacheTtlMs: 100,
      cacheMaxEntries: 1,
    });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const changed = vi.fn();
      store.onChange(changed);
      await store.put("unrelated", context);
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(changed).not.toHaveBeenCalledWith(record.ref);
      expect(state.initializations).toBe(2);
      expect(state.headers.some((headers) => headers.authorization === "Bearer rotated")).toBe(
        true,
      );
      fake.values.delete(record.ref.split(":").at(-1)!);
      await vi.advanceTimersByTimeAsync(100);
      // Discovery suppresses per-server errors; no tools from the deleted credential survive.
      await expect(connector.discoverTools(context)).resolves.toEqual([]);
      expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    } finally {
      await connector.close();
      await store.close();
      vi.useRealTimers();
    }
  });

  it("keeps a live session working during a secret-store outage after TTL", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    const previousLogger = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({ ...fake.options, cacheTtlMs: 100 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const reads = fake.fetcher.mock.calls.length;
      fake.offline = true;
      await vi.advanceTimersByTimeAsync(100);
      const tools = await connector.discoverTools(context);
      expect(tools).toHaveLength(1);
      expect(fake.fetcher.mock.calls.length).toBeGreaterThan(reads);
      expect(state.initializations).toBe(1);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer initial");
      const events = [];
      for (const tool of tools) {
        const call = { tool: tool.name, args: {}, executionId: "test", route: tool.route };
        for await (const event of connector.execute(call, context)) events.push(event);
      }
      expect(events).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(1);
      expect(sink.events.filter((event) => event.message !== "discovery.cache")).toHaveLength(2);
      const log = JSON.stringify(sink.events);
      expect(log).toContain("MCP secret revalidation failed");
      expect(log).not.toContain("private response value");
      expect(log).not.toContain(record.ref);
      expect(log).not.toContain(record.id);
      expect(log).not.toContain("Bearer initial");
      // Recovery still revalidates and observes a rotation without a manual read.
      fake.offline = false;
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      expect(await connector.discoverTools(context)).toHaveLength(1);
      expect(state.initializations).toBe(2);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer rotated");
    } finally {
      await connector.close();
      await store.close();
      installLogger(previousLogger);
      vi.useRealTimers();
    }
  });

  it("reconnects a legacy session when migration publishes the old ref through realtime", async () => {
    const fake = infisicalFake();
    const fanout = new InMemoryRealtimeFanout();
    const source = new ComposedSecretStore(new EncryptedSecretStore("fake-key"), undefined, fanout);
    const target = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    const worker = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    await source.start();
    await target.start();
    await worker.start();
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const record = await source.put(
      JSON.stringify({ headers: { Authorization: "Bearer fake" } }),
      context,
    );
    const row = { id: record.id, ciphertext: record.ref };
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => row) },
    };
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, worker, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const result = await migrateSecrets(
        {
          async *rows() {
            yield { id: row.id, recordId: row.id, ref: row.ciphertext, label: "secret" };
          },
          async replace(original, ref) {
            if (original.ref !== row.ciphertext) return false;
            row.ciphertext = ref;
            return true;
          },
          async referenced(ref) {
            return row.ciphertext === ref;
          },
        },
        source,
        target,
        context,
        { direction: "forward" },
      );
      expect(result.migrated).toBe(1);
      await connector.discoverTools(context);
      expect(state.initializations).toBe(2);
    } finally {
      await connector.close();
      await source.close();
      await target.close();
      await worker.close();
      await fanout.close();
    }
  });

  it("keeps large MCP schemas out of the initial runtime tool catalog", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: `Tool ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: `schema-marker-${index}` } },
          required: ["value"],
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const tools = await connector.discoverTools(context);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "connectors_search_tools",
      "connectors_load_tool",
      "connectors_execute_tool",
    ]);
    // Anthropic rejects Claude Code OAuth requests carrying any `mcp_`-prefixed tool name.
    expect(tools.every((tool) => !tool.name.startsWith("mcp_"))).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("schema-marker");
    await connector.close();
  });

  it("exposes 20 MCP tools directly and switches at 21", async () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    for (const count of [20, 21]) {
      const state = {
        failNext: false,
        initializations: 0,
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object" },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
            findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
          },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      const tools = await connector.discoverTools(context);
      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.name).toMatch(/^mcp__demo__/);
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "connectors_search_tools",
          "connectors_load_tool",
          "connectors_execute_tool",
        ]);
      }
      await connector.close();
    }
  });

  it("records a discovery failure as a failed tool completion", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      spaceId: "w1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type: "agent.tool.completed",
      payload: {
        name: "mcp__demo__discovery",
        executionId: "mcp-discovery-demo-run-1-0",
        outcome: "error",
      },
    });
    expect(append.mock.calls[0]?.[0].payload.error).toEqual(expect.any(String));
    await connector.close();
  });

  it("redacts credentials of a connect that failed before the session was cached", async () => {
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    // The connect itself fails, so the session never reaches the cache. The upstream
    // body quotes back the header it was sent, the way a strict server rejects one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected credential local-key", { status: 500 })),
    );
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi.fn().mockReturnValue(JSON.stringify({ headers: { "X-Api-Key": "local-key" } })),
      } as never,
      { network: TEST_NETWORK, events: { append } },
    );

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);

    expect(append).toHaveBeenCalledTimes(1);
    const reason = String(append.mock.calls[0]?.[0].payload.error);
    expect(reason).not.toContain("local-key");
    expect(reason).toContain("[redacted]");
    await connector.close();
  });

  it("redacts the same failed connect for every concurrent waiter", async () => {
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected credential local-key", { status: 500 })),
    );
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([localAssignment]),
        findFirst: vi.fn().mockResolvedValue(localAssignment),
      },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi.fn().mockReturnValue(JSON.stringify({ headers: { "X-Api-Key": "local-key" } })),
      } as never,
      { network: TEST_NETWORK, events: { append } },
    );
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };

    // Both callers land on the same pending connect, so both receive the one
    // rejection it produces. Neither may see the credential it reflected.
    const [first, second] = await Promise.all([
      connector.discoverTools(context as never),
      connector.discoverTools(context as never),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(append).toHaveBeenCalledTimes(2);
    for (const call of append.mock.calls) {
      const message = String(call[0].payload.error);
      expect(message).not.toContain("local-key");
      expect(message).toContain("[redacted]");
    }
    await connector.close();
  });

  it("gives every discovery failure of one run its own executionId", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };

    // Discovery is reached again on every lazy catalog access inside the same run; a
    // failure is memoised, so only a retry after the failure TTL records another event.
    vi.useFakeTimers({ toFake: ["Date"] });
    await connector.discoverTools(context as never);
    vi.setSystemTime(Date.now() + DISCOVERY_FAILURE_TTL_MS);
    await connector.discoverTools(context as never);
    vi.useRealTimers();

    expect(append).toHaveBeenCalledTimes(2);
    const ids = append.mock.calls.map((call) => call[0].payload.executionId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^mcp-discovery-demo-run-1-\d+$/);
    await connector.close();
  });

  it("leaves no discovery event when the failure happens outside a run", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) } } as never,
      {} as never,
      { network: TEST_NETWORK, events: { append } },
    );

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);

    expect(append).not.toHaveBeenCalled();
    await connector.close();
  });

  it("returns no tools when the MCP catalog is empty", async () => {
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );
    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
    await connector.close();
  });

  it("searches, loads, validates, authorizes, and executes one large-catalog tool", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: index === 29 ? "Find the final report" : `Utility ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const [search, load, execute] = await connector.discoverTools(context);
    const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call as never, context)) events.push(event);
      return events;
    };

    const searched = await collect({
      tool: search!.name,
      args: { query: "final report", limit: 2 },
      executionId: "search",
      route: search!.route,
    });
    expect(searched).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "server-1:tool_29",
              name: "mcp__demo__tool_29",
              description: "Find the final report",
              readOnly: false,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain("inputSchema");

    const indexed = await collect({
      tool: search!.name,
      args: {},
      executionId: "index",
      route: search!.route,
    });
    expect(indexed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "demo",
              names: Array.from(
                { length: 30 },
                (_, index) => `tool_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(indexed)).not.toContain("inputSchema");
    expect(search!.description).toContain("demo:");
    expect(search!.description).toContain("tool_00");

    const expanded = await collect({
      tool: search!.name,
      args: { group: "demo" },
      executionId: "group",
      route: search!.route,
    });
    expect(expanded).toEqual([
      {
        type: "result",
        data: {
          group: "demo",
          names: Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`),
        },
      },
    ]);

    const loaded = await collect({
      tool: load!.name,
      args: { id: "server-1:tool_29" },
      executionId: "load",
      route: load!.route,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          id: "server-1:tool_29",
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "mcp__demo__missing", arguments: { value: "x" } },
          executionId: "unknown",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow(
      /Unknown tool ID or name in this bot's current catalog\..*Search again with group and query/,
    );
    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "server-1:tool_29", arguments: {} },
          executionId: "invalid",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");

    const resolved = await connector.resolveCall(
      {
        tool: execute!.name,
        args: { id: "server-1:tool_29", arguments: { value: "ok" } },
        executionId: "execute",
        route: execute!.route,
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "mcp__demo__tool_29" },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });
    expect(await collect(resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["tool_29"]);
    await connector.close();
  });

  it.each([
    ["direct", "stale"],
    ["direct", "missing"],
    ["catalog", "stale"],
    ["catalog", "missing"],
  ] as const)(
    "rejects a %s call with a %s server revision before connecting",
    async (path, revision) => {
      let assignment = ASSIGNMENT;
      const state = {
        failNext: false,
        initializations: 0,
        calls: [] as string[],
        tools: Array.from({ length: path === "direct" ? 1 : 21 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const prisma = {
        botMcpServer: {
          findMany: vi.fn(async () => [assignment]),
          findFirst: vi.fn(async () => assignment),
        },
      };
      const connector = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
      const context = {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never;
      const resolve = async () => {
        const exposed = await connector.discoverTools(context);
        const call = {
          tool: exposed[0]!.name,
          args: { value: "approved fixture" },
          executionId: "fixture",
          route: exposed[0]!.route,
        };
        if (path === "direct") return call;
        const execute = exposed.find((tool) => tool.name === "connectors_execute_tool")!;
        return (await connector.resolveCall(
          {
            ...call,
            tool: execute.name,
            route: execute.route,
            args: { id: "server-1:tool_0", arguments: call.args },
          },
          context,
        ))!.call;
      };
      const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
        const events = [];
        for await (const event of connector.execute(call, context)) events.push(event);
        return events;
      };
      try {
        const old = await resolve();
        assignment = { ...ASSIGNMENT, server: { ...SERVER, revision: 2 } };
        const route = { ...old.route! };
        if (revision === "missing") delete route.resourceRevision;
        const initializations = state.initializations;
        expect(await collect({ ...old, route })).toEqual([
          { type: "error", message: "MCP server changed; rediscover the tool before trying again" },
        ]);
        expect(state.initializations).toBe(initializations);
        expect(state.calls).toEqual([]);
        expect(prisma.botMcpServer.findFirst).toHaveBeenCalledOnce();

        const fresh = await resolve();
        expect(fresh.route?.resourceRevision).toBe(2);
        expect(await collect(fresh)).toMatchObject([{ type: "result" }]);
        expect(state.initializations).toBe(initializations + 1);
        expect(state.calls).toEqual(["tool_0"]);
        expect(prisma.botMcpServer.findFirst).toHaveBeenCalledTimes(2);
      } finally {
        await connector.close();
      }
    },
  );

  it("executes authoritative MCP tools whose names match catalog controls", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["__catalog_search", "__catalog_load", "__catalog_execute"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    for (const tool of await connector.discoverTools(context)) {
      const call = { tool: tool.name, args: {}, executionId: tool.name, route: tool.route };
      await expect(connector.resolveCall(call, context)).resolves.toBeUndefined();
      const events = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    }
    expect(state.calls).toEqual(["__catalog_search", "__catalog_load", "__catalog_execute"]);
    await connector.close();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "blocks OAuth rediscovery to HTTP %s after invalid_client from a public server",
    async (host) => {
      const requests: Array<{ method: string; url: string }> = [];
      const metadataUrl = `http://${host}:8123/private-probe`;
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauth: {
            redirectUri: "https://app.example.test/mcp/oauth/callback",
            tokens: {
              access_token: "fake-stale-access",
              refresh_token: "fake-refresh",
              token_type: "bearer",
            },
            clientInformation: { client_id: "fake-client" },
            discoveryState: {
              authorizationServerUrl: "https://auth.example.test",
              resourceMetadata: {
                resource: SERVER.endpoint,
                authorization_servers: ["https://auth.example.test"],
              },
              authorizationServerMetadata: {
                issuer: "https://auth.example.test",
                authorization_endpoint: "https://auth.example.test/authorize",
                token_endpoint: "https://auth.example.test/token",
                response_types_supported: ["code"],
              },
            },
          },
        },
        async () => undefined,
      );
      const invalidate = vi.spyOn(provider, "invalidateCredentials");
      const connector = new McpConnector(
        { botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) } } as never,
        {} as never,
        {
          network: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              const url = logicalHref(input, init);
              requests.push({ method: request.method, url });
              if (url === SERVER.endpoint) {
                return new Response(null, {
                  status: 401,
                  headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
                });
              }
              if (url === "https://auth.example.test/token") {
                return Response.json({ error: "invalid_client" }, { status: 400 });
              }
              return new Response(null, { status: 404 });
            }),
          },
        },
        { providerFor: vi.fn().mockResolvedValue(provider) } as unknown as McpOAuthBroker,
      );

      try {
        await expect(
          connector.discoverTools({
            spaceId: "w1",
            userId: "u1",
            botId: "bot-1",
            signal: new AbortController().signal,
          } as never),
        ).resolves.toEqual([]);

        expect(requests.slice(0, 2).map((request) => `${request.method} ${request.url}`)).toEqual([
          `POST ${SERVER.endpoint}`,
          "POST https://auth.example.test/token",
        ]);
        expect(invalidate.mock.calls).toEqual([["client"], ["tokens"]]);
        expect(provider.clientInformation()).toBeUndefined();
        await expect(provider.tokens()).resolves.toBeUndefined();
        expect(requests.some((request) => request.url === metadataUrl)).toBe(false);
        // Native invalid_client recovery retains validated discovery instead of following a new challenge.
        expect(provider.discoveryState()?.authorizationServerUrl).toBe("https://auth.example.test");
        expect(requests.every((request) => new URL(request.url).protocol === "https:")).toBe(true);
      } finally {
        await connector.close();
      }
    },
  );

  it("connects to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0 };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(prisma as never, {} as never);

    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("sends stored credentials to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ secret: "local-token", headers: { "X-Api-Key": "local-key" } }),
          ),
      } as never,
    );

    await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(state.headers[0]?.authorization).toBe("Bearer local-token");
    expect(state.headers[0]?.["x-api-key"]).toBe("local-key");
    await connector.close();
  });

  it("evicts a session after a failed call so the next call reconnects instead of reusing a dead session", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: {
        connectorId: "mcp",
        resourceId: "server-1",
        resourceRevision: SERVER.revision,
        toolName: "echo",
      },
    } as never;

    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(1);

    state.failNext = true;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error" }]);

    state.failNext = false;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const contextFor = (spaceId: string, userId: string) =>
      ({ spaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w1", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w2", "u1"));
    expect(state.initializations).toBe(3);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(3);

    await connector.close();
  });
});

describe("MCP connector private endpoints", () => {
  const privateAssignment = {
    ...ASSIGNMENT,
    server: { ...SERVER, endpoint: "http://10.0.0.8:3927/mcp" },
  };
  const lanDnsAssignment = {
    ...ASSIGNMENT,
    server: { ...SERVER, endpoint: "https://mcp.lan.test/mcp" },
  };

  it("does not connect a private IP for a non-owner when the instance escape is off", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const connector = new McpConnector(
      {
        botMcpServer: { findMany: vi.fn().mockResolvedValue([privateAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
      } as never,
      {} as never,
      { network: { fetch, resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }] } },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await connector.close();
  });

  it.each(["http://localhost:3100/api/auth/get-session", "https://127.0.0.1:3100/mcp"])(
    "does not connect loopback %s for a non-owner",
    async (endpoint) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ ...ASSIGNMENT, server: { ...SERVER, endpoint } }]),
          },
          deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
        } as never,
        {} as never,
        { network: { fetch, resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] } },
      );
      const tools = await connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never);
      expect(tools).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      await connector.close();
    },
  );

  it("connects a private IP when the current user is the deployment owner", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state, "http://10.0.0.8:3927/mcp"));
    const connector = new McpConnector(
      {
        botMcpServer: { findMany: vi.fn().mockResolvedValue([privateAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
      } as never,
      {} as never,
      {
        network: {
          fetch: (input, init) => globalThis.fetch(input, init),
          resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("connects a private-resolving DNS name when the current user is the deployment owner", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state, "https://mcp.lan.test/mcp"));
    const connector = new McpConnector(
      {
        botMcpServer: { findMany: vi.fn().mockResolvedValue([lanDnsAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
      } as never,
      {} as never,
      {
        network: {
          fetch: (input, init) => globalThis.fetch(input, init),
          resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });
});

describe("allowlistDrift", () => {
  it("names the allowed tools the server no longer offers", () => {
    const offered = [{ name: "echo" }, { name: "upper" }];
    expect(allowlistDrift(["echo", "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 2,
    });
    expect(allowlistDrift(["echo"], offered).missing).toEqual([]);
    // allowedTools is a Json column, so it can hold anything: it must not throw.
    expect(allowlistDrift(null, offered)).toEqual({
      missing: [],
      offered: 2,
      stringAllowedCount: 0,
    });
    // Non-string JSON values are ignored for both missing and the warning ratio.
    expect(allowlistDrift([42, "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 1,
    });
  });
});

describe.each([
  ["Autumn", "https://api.autumn.ai/mcp", "AUTUMN_API_KEY", "Recruiting research"],
  ["FullEnrich", "https://mcp.fullenrich.com/mcp", "FULLENRICH_API_KEY", "Contact enrichment"],
])("deployment %s credentials", (name, endpoint, env, label) => {
  afterEach(() => vi.unstubAllEnvs());
  const context = {
    userId: "new-user",
    spaceId: "private-space",
    signal: new AbortController().signal,
  };
  const official = {
    secretId: null,
    transport: "streamable_http",
    endpoint,
  };

  it("supplies the platform key in memory without loading or copying another account's secret", async () => {
    vi.stubEnv(env, "platform-service-key");
    const findFirst = vi.fn();
    const load = vi.fn();
    const result = await loadMcpCredentialRecord(
      { secret: { findFirst } } as never,
      { load } as never,
      official,
      context as never,
    );
    expect(JSON.parse(result.plaintext!)).toEqual({ secret: "platform-service-key" });
    expect(result.secret).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.autumn.ai/mcp?redirect=other",
    "https://api.autumn.ai.example.test/mcp",
    "https://other.example.test/mcp",
    "http://api.autumn.ai/mcp",
    "https://mcp.fullenrich.com/mcp?redirect=other",
    "https://mcp.fullenrich.com.example.test/mcp",
    "http://mcp.fullenrich.com/mcp",
  ])("never supplies a platform key to a different endpoint: %s", async (endpoint) => {
    vi.stubEnv(env, "platform-service-key");
    const result = await loadMcpCredentialRecord(
      {} as never,
      {} as never,
      { ...official, endpoint },
      context as never,
    );
    expect(result.plaintext).toBeUndefined();
  });

  it("preserves actor-scoped personal credentials and refuses a missing owned secret", async () => {
    vi.stubEnv(env, "platform-service-key");
    const row = { id: "personal-secret", ciphertext: "encrypted-reference" };
    const findFirst = vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    const load = vi.fn().mockResolvedValue('{"secret":"personal-service-key"}');
    const server = { ...official, secretId: row.id };
    const prisma = { secret: { findFirst } } as never;
    const secrets = { load } as never;
    const personal = await loadMcpCredentialRecord(prisma, secrets, server, context as never);
    expect(JSON.parse(personal.plaintext!)).toEqual({ secret: "personal-service-key" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: row.id, userId: context.userId, spaceId: context.spaceId },
    });
    const missing = await loadMcpCredentialRecord(prisma, secrets, server, context as never);
    expect(missing.plaintext).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfigured platform service before authentication when its key is absent", async () => {
    vi.stubEnv(env, " ");
    await expect(
      loadMcpCredentialRecord({} as never, {} as never, official, context as never),
    ).rejects.toThrow(`${label} is not configured on this server`);
  });

  it("activates the existing service assignment after platform configuration without network or OAuth while unavailable", async () => {
    vi.stubEnv(env, " ");
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const fetch = mcpFetch(state, official.endpoint);
    vi.stubGlobal("fetch", fetch);
    const providerFor = vi.fn().mockResolvedValue(undefined);
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { ...ASSIGNMENT, server: { ...SERVER, ...official, slug: name.toLowerCase() } },
      ]);
    const load = vi.fn();
    const connector = new McpConnector(
      { botMcpServer: { findMany } } as never,
      { load } as never,
      { network: TEST_NETWORK },
      { providerFor } as never,
    );
    const scoped = { ...context, botId: ASSIGNMENT.botId };
    try {
      await expect(connector.discoverTools(scoped as never)).resolves.toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(providerFor).not.toHaveBeenCalled();
      vi.stubEnv(env, "platform-service-key");
      // The failed discovery is memoised for DISCOVERY_FAILURE_TTL_MS.
      vi.setSystemTime(Date.now() + DISCOVERY_FAILURE_TTL_MS);
      await expect(connector.discoverTools(scoped as never)).resolves.toEqual([
        expect.objectContaining({ name: `mcp__${name.toLowerCase()}__echo` }),
      ]);
      expect(
        state.headers.every((headers) => headers.authorization === "Bearer platform-service-key"),
      ).toBe(true);
      expect(load).not.toHaveBeenCalled();
      expect(findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            botId: scoped.botId,
            spaceId: scoped.spaceId,
            userId: scoped.userId,
            server: { enabled: true },
          },
        }),
      );
    } finally {
      await connector.close();
      vi.useRealTimers();
    }
  });
});

describe("first-party product OIDC MCP connection", () => {
  const endpoint = "https://crm.example.test/mcp";
  const context = {
    spaceId: "w1",
    userId: "u1",
    botId: "bot-1",
    signal: new AbortController().signal,
  };
  it("limits the existing endpoint configuration to a credential-free HTTPS resource", () => {
    expect(firstPartyMcpUrl(undefined)).toBeUndefined();
    expect(firstPartyMcpUrl(` ${endpoint} `)).toBe(endpoint);
    for (const url of [
      "http://crm.example.test/mcp",
      `${endpoint}?x=1`,
      `${endpoint}#x`,
      `${endpoint}?`,
      `${endpoint}#`,
      "https://user:secret@crm.example.test/mcp",
    ])
      expect(() => firstPartyMcpUrl(url)).toThrow();
  });
  it.each(["other endpoint", "personal secret", "no assignment"])(
    "does not bridge %s or grant access",
    async (kind) => {
      const state = { failNext: false, initializations: 0 };
      const server = {
        ...SERVER,
        endpoint: kind === "other endpoint" ? `${endpoint}/other` : endpoint,
        secretId: kind === "personal secret" ? "personal-secret" : null,
      };
      vi.stubGlobal("fetch", mcpFetch(state, server.endpoint));
      const accessToken = vi.fn().mockRejectedValue(new Error("Must not access product token"));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi
              .fn()
              .mockResolvedValue(kind === "no assignment" ? [] : [{ ...ASSIGNMENT, server }]),
          },
          secret: { findFirst: vi.fn().mockResolvedValue(null) },
        } as never,
        {} as never,
        { network: TEST_NETWORK, firstParty: { endpoint, accessToken } },
      );
      try {
        await connector.discoverTools(context as never);
        expect(accessToken).not.toHaveBeenCalled();
      } finally {
        await connector.close();
      }
    },
  );
  it("does not retain a completed run's cancellation signal and denies revoked identity before another dispatch", async () => {
    const state = { failNext: false, initializations: 0, calls: [] as string[] };
    vi.stubGlobal("fetch", mcpFetch(state, endpoint));
    let revoked = false;
    const accessToken = vi.fn(async (actor: AdapterContext) => {
      expect(actor.signal.aborted).toBe(false);
      if (revoked) throw new IsolationError("CRM identity disconnected");
      return "current-access";
    });
    const server = { ...SERVER, endpoint };
    const row = { ...ASSIGNMENT, server };
    const connector = new McpConnector(
      {
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([row]),
          findFirst: vi.fn().mockResolvedValue(row),
        },
      } as never,
      {} as never,
      { network: TEST_NETWORK, firstParty: { endpoint, accessToken } },
    );
    const firstRun = new AbortController();
    const call = {
      tool: "mcp__demo__echo",
      executionId: "first-party",
      args: {},
      route: {
        connectorId: "mcp",
        resourceId: server.id,
        resourceRevision: server.revision,
        toolName: "echo",
      },
    };
    try {
      expect(
        await connector.discoverTools({ ...context, signal: firstRun.signal } as never),
      ).toHaveLength(1);
      firstRun.abort();
      const before = [];
      for await (const event of connector.execute(call, context as never)) before.push(event);
      expect(before.at(-1)).toMatchObject({ type: "result" });
      expect(state.initializations).toBe(1);
      revoked = true;
      const after = [];
      for await (const event of connector.execute(call, context as never)) after.push(event);
      expect(after.at(-1)).toMatchObject({ type: "error" });
      expect(state.calls).toEqual(["echo"]);
    } finally {
      await connector.close();
    }
  });
  it("uses the current caller token on every native request and refreshes the precise rejected bearer once", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      headers: [] as Record<string, string>[],
      calls: [] as string[],
      callResult: { content: [{ type: "text", text: "first-access rotated-access" }] },
    };
    const native = mcpFetch(state, endpoint);
    let reject = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (reject && request.headers.get("authorization") === "Bearer first-access") {
          reject = false;
          return new Response(null, { status: 401 });
        }
        return native(input, init);
      }),
    );
    let token = "first-access";
    const accessToken = vi.fn(async (actor: AdapterContext, rejected?: string) => {
      expect(actor.userId).toBe(context.userId);
      expect(actor.spaceId).toBe(context.spaceId);
      if (rejected) {
        expect(rejected).toBe("first-access");
        token = "rotated-access";
      }
      return token;
    });
    const server = { ...SERVER, endpoint };
    const row = { ...ASSIGNMENT, server };
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([row]),
        findFirst: vi.fn().mockResolvedValue(row),
      },
    };
    const put = vi.fn();
    const providerFor = vi.fn();
    const connector = new McpConnector(
      prisma as never,
      { put } as never,
      { network: TEST_NETWORK, firstParty: { endpoint, accessToken } },
      { providerFor } as never,
    );
    try {
      expect(await connector.discoverTools(context as never)).toHaveLength(1);
      const before = accessToken.mock.calls.length;
      reject = true;
      const events = [];
      for await (const event of connector.execute(
        {
          tool: "mcp__demo__echo",
          executionId: "first-party",
          args: {},
          route: {
            connectorId: "mcp",
            resourceId: server.id,
            resourceRevision: server.revision,
            toolName: "echo",
          },
        },
        context as never,
      ))
        events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "result" });
      expect(JSON.stringify(events)).not.toContain("first-access");
      expect(JSON.stringify(events)).not.toContain("rotated-access");
      expect(accessToken.mock.calls.length).toBeGreaterThan(before);
      expect(accessToken.mock.calls.filter(([, rejected]) => rejected !== undefined)).toHaveLength(
        1,
      );
      expect(
        state.headers.some((headers) => headers.authorization === "Bearer rotated-access"),
      ).toBe(true);
      expect(providerFor).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    } finally {
      await connector.close();
    }
  });
});

describe("local native Instantly campaign and lead tools", () => {
  const CAMPAIGN = "123e4567-e89b-42d3-a456-4266141740c1";
  const route = (name: string) => ({
    connectorId: "mcp",
    resourceId: SERVER.id,
    resourceRevision: 1,
    toolName: `native_instantly_${name}`,
  });
  function fixture() {
    const context = {
      userId: "u1",
      spaceId: "w1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };
    const server = {
      ...SERVER,
      userId: "u1",
      spaceId: "w1",
      enabled: true,
      endpoint: "https://mcp.instantly.ai/mcp",
      secretId: "key-1",
    };
    const assignment = {
      ...ASSIGNMENT,
      server,
      allowAllTools: false,
      allowedTools: ["get_email", "list_emails"],
    };
    const state = {
      key: "fixture-private-api-key",
      accounts: ["team@example.test"],
      campaign: { id: CAMPAIGN, status: 0, stop_on_reply: true } as Record<string, unknown>,
      existingLeads: [] as { id: string; email: string }[],
      campaigns: [] as Record<string, unknown>[],
      activeRoleId: null as string | null,
      deleted: false,
      effects: new Map<string, Record<string, unknown>>(),
      requests: [] as { method: string; path: string; body?: unknown }[],
    };
    const prisma = {
      botMcpServer: { findFirst: vi.fn(async () => assignment) },
      secret: { findFirst: vi.fn(async () => ({ id: "key-1", ciphertext: "encrypted" })) },
      mcpServer: { findFirst: vi.fn(async () => server) },
      run: {
        findFirst: vi.fn(async ({ where }) =>
          where.id === "run-1" ? { thread: { activeRecruitingRoleId: state.activeRoleId } } : null,
        ),
      },
      recruitingRole: {
        findFirst: vi.fn(async ({ where }) =>
          where.id === "role-1" && where.spaceId === "w1" && where.userId === "u1"
            ? { id: "role-1", title: "Founding Engineer" }
            : null,
        ),
      },
      recruitingCandidate: {
        findMany: vi.fn(async ({ where }) =>
          (where.candidateKey.in as string[])
            .filter((key) => key !== "not-shortlisted")
            .map((candidateKey) => ({ candidateKey })),
        ),
      },
      externalEffect: {
        findUnique: vi.fn(async ({ where }) => state.effects.get(where.idempotencyKey) ?? null),
        findFirst: vi.fn(async () => {
          const bound = [...state.effects.values()].filter(
            (e) => e.kind === "instantly_role_campaign",
          );
          return bound.at(-1) ?? null;
        }),
        create: vi.fn(async ({ data }) => {
          const effect = { id: `effect-${state.effects.size}`, ...data };
          state.effects.set(data.idempotencyKey, effect);
          return effect;
        }),
        update: vi.fn(async ({ where, data }) => {
          const effect = [...state.effects.values()].find((e) => e.id === where.id)!;
          Object.assign(effect, data);
          return effect;
        }),
      },
    };
    const secrets = { load: vi.fn(async () => JSON.stringify({ secret: state.key })) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(logicalHref(input, init), init);
        const url = new URL(request.url);
        expect(url.origin).toBe("https://api.instantly.ai");
        expect(request.headers.get("authorization")).toBe(`Bearer ${state.key}`);
        const text = await request.text();
        const body = text ? JSON.parse(text) : undefined;
        const path = `${url.pathname}${url.search}`;
        state.requests.push({ method: request.method, path, ...(body ? { body } : {}) });
        const account = url.pathname.match(/^\/api\/v2\/accounts\/(.+)$/);
        if (account)
          return new Response("{}", {
            status: state.accounts.includes(decodeURIComponent(account[1]!)) ? 200 : 404,
          });
        if (url.pathname === "/api/v2/accounts")
          return Response.json({ items: state.accounts.map((email) => ({ email })) });
        if (url.pathname === "/api/v2/campaigns" && request.method === "GET")
          return Response.json({ items: state.campaigns });
        if (url.pathname === "/api/v2/campaigns") return Response.json({ id: CAMPAIGN, ...body });
        if (url.pathname === `/api/v2/campaigns/${CAMPAIGN}`) {
          if (state.deleted) return new Response("{}", { status: 404 });
          if (request.method === "PATCH") Object.assign(state.campaign, body);
          return Response.json(state.campaign);
        }
        if (url.pathname.startsWith(`/api/v2/campaigns/${CAMPAIGN}/`))
          return Response.json(state.campaign);
        const listed = state.campaigns.find((c) => url.pathname === `/api/v2/campaigns/${c.id}`);
        if (listed) return Response.json(listed);
        if (url.pathname === "/api/v2/leads/list" && body.campaign && !body.contacts)
          return Response.json({ items: body.campaign === "with-leads" ? [{ id: "l" }] : [] });
        if (url.pathname === "/api/v2/leads/list")
          return Response.json({
            items: state.existingLeads.filter((lead) =>
              (body.contacts as string[] | undefined)?.some(
                (email) => email.toLowerCase() === lead.email,
              ),
            ),
          });
        if (url.pathname === "/api/v2/leads/add")
          return Response.json({
            status: "success",
            leads_uploaded: body.leads.length,
            created_leads: body.leads.map((lead: { email: string }, index: number) => ({
              index,
              id: `lead-${lead.email}`,
              email: lead.email,
            })),
          });
        if (url.pathname === "/api/v2/leads/update-interest-status")
          return Response.json({ message: "queued" }, { status: 202 });
        return new Response("unexpected", { status: 500 });
      }),
    );
    const connector = new McpConnector(prisma as never, secrets as never, {
      network: TEST_NETWORK,
    });
    const run = async (name: string, args: Record<string, unknown>) => {
      const events = [];
      for await (const event of connector.execute(
        { tool: `instantly__demo__${name}`, route: route(name), args, executionId: name },
        context as never,
      ))
        events.push(event);
      return events;
    };
    const result = (events: unknown[]) =>
      (events[0] as { data: { structuredContent: { result: Record<string, unknown> } } }).data
        .structuredContent.result;
    return { state, run, result, prisma };
  }

  it("creates a draft stop-on-reply campaign from an own mailbox", async () => {
    const f = fixture();
    const events = await f.run("create_campaign", {
      name: "Internal test",
      eaccount: "team@example.test",
      steps: [{ subject: "Hi", body: "Hello<br/>there" }],
    });
    expect(events[0]).toMatchObject({ type: "result" });
    expect(f.state.requests).toEqual([
      { method: "GET", path: "/api/v2/accounts/team%40example.test" },
      {
        method: "POST",
        path: "/api/v2/campaigns",
        body: {
          name: "Internal test",
          campaign_schedule: {
            schedules: [
              {
                name: "Weekdays",
                timing: { from: "09:00", to: "17:00" },
                days: {
                  "0": false,
                  "1": true,
                  "2": true,
                  "3": true,
                  "4": true,
                  "5": true,
                  "6": false,
                },
                timezone: "America/Chicago",
              },
            ],
          },
          sequences: [
            {
              steps: [
                {
                  type: "email",
                  delay: 0,
                  delay_unit: "days",
                  variants: [{ subject: "Hi", body: "Hello<br/>there" }],
                },
              ],
            },
          ],
          email_list: ["team@example.test"],
          stop_on_reply: true,
          stop_on_auto_reply: true,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(f.state.key);
  });

  it("get_campaign reads status and stop on reply with one GET", async () => {
    const f = fixture();
    const events = await f.run("get_campaign", { campaign_id: CAMPAIGN });
    expect(events[0]).toMatchObject({
      type: "result",
      data: {
        structuredContent: {
          result: { id: CAMPAIGN, status: 0, stop_on_reply: true },
        },
      },
    });
    expect(f.state.requests).toEqual([{ method: "GET", path: `/api/v2/campaigns/${CAMPAIGN}` }]);
  });

  it("refuses a foreign sending mailbox without creating anything", async () => {
    const f = fixture();
    const events = await f.run("create_campaign", {
      name: "x",
      eaccount: "someone@else.test",
    });
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toMatch(/not one of your connected/);
    expect(f.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("sends exact REST calls for leads, interest, pause and activate", async () => {
    const f = fixture();
    await f.run("add_leads", {
      campaign_id: CAMPAIGN,
      leads: [{ email: "admin1@wekruit.com", first_name: "Adam" }],
    });
    await f.run("list_leads", { campaign_id: CAMPAIGN, email: "admin1@wekruit.com" });
    await f.run("update_lead_interest", { lead_email: "admin1@wekruit.com", interest_value: 1 });
    await f.run("pause_campaign", { campaign_id: CAMPAIGN });
    await f.run("activate_campaign", { campaign_id: CAMPAIGN });
    expect(f.state.requests).toEqual([
      { method: "GET", path: `/api/v2/campaigns/${CAMPAIGN}` },
      {
        method: "POST",
        path: "/api/v2/leads/add",
        body: {
          campaign_id: CAMPAIGN,
          leads: [{ email: "admin1@wekruit.com", first_name: "Adam" }],
          skip_if_in_workspace: false,
        },
      },
      {
        method: "POST",
        path: "/api/v2/leads/list",
        body: { campaign: CAMPAIGN, contacts: ["admin1@wekruit.com"], limit: 50 },
      },
      {
        method: "POST",
        path: "/api/v2/leads/update-interest-status",
        body: { lead_email: "admin1@wekruit.com", interest_value: 1 },
      },
      { method: "POST", path: `/api/v2/campaigns/${CAMPAIGN}/pause` },
      { method: "POST", path: `/api/v2/campaigns/${CAMPAIGN}/activate` },
    ]);
  });

  it("refuses to enroll leads into an active campaign", async () => {
    const f = fixture();
    f.state.campaign.status = 1;
    const events = await f.run("add_leads", {
      campaign_id: CAMPAIGN,
      leads: [{ email: "admin1@wekruit.com" }],
    });
    expect(events[0]).toMatchObject({ type: "error" });
    expect(f.state.requests.some((r) => r.path === "/api/v2/leads/add")).toBe(false);
  });

  it("gates activation behind an explicit one-time approval; lead/campaign writes are not read-only", async () => {
    expect(
      toolRequiresExplicitApproval("instantly__demo__activate_campaign", {
        connectorId: "mcp",
        toolName: "native_instantly_activate_campaign",
      }),
    ).toBe(true);
    for (const name of ["create_campaign", "add_leads", "ensure_role_campaign", "pause_campaign"])
      expect(toolRequiresApproval(`instantly__demo__${name}`, true, false)).toBe(true);
  });

  it("ensure_role_campaign is idempotent and keeps stop_on_reply on", async () => {
    const f = fixture();
    const first = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(first).toMatchObject({
      created: true,
      campaignId: CAMPAIGN,
      eaccount: "team@example.test",
      campaignName: "Founding Engineer",
    });
    const create = f.state.requests.find((r) => r.method === "POST")!;
    expect(create).toMatchObject({
      path: "/api/v2/campaigns",
      body: { name: "Founding Engineer", stop_on_reply: true, email_list: ["team@example.test"] },
    });
    expect(JSON.stringify(create.body)).not.toContain("[role");
    f.state.requests.length = 0;
    const second = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(second).toMatchObject({
      created: false,
      campaignId: CAMPAIGN,
      stopOnReplyPatched: false,
    });
    // An empty mapped campaign with no same-title alternative stays mapped; nothing is created.
    expect(f.state.requests.filter((r) => r.method !== "GET")).toEqual([
      { method: "POST", path: "/api/v2/leads/list", body: { campaign: CAMPAIGN, limit: 1 } },
    ]);
    expect(f.prisma.externalEffect.create).toHaveBeenCalledTimes(1);
    f.state.campaign.stop_on_reply = false;
    f.state.requests.length = 0;
    const third = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(third).toMatchObject({ created: false, stopOnReplyPatched: true });
    expect(f.state.requests.find((r) => r.method === "PATCH")).toEqual({
      method: "PATCH",
      path: `/api/v2/campaigns/${CAMPAIGN}`,
      body: { stop_on_reply: true },
    });
    expect(await f.run("ensure_role_campaign", { role_id: "other-role" })).toMatchObject([
      { type: "error" },
    ]);
  });

  it("create_campaign in a role conversation binds the role, so ensure_role_campaign reuses it", async () => {
    const f = fixture();
    f.state.activeRoleId = "role-1";
    await f.run("create_campaign", {
      name: "Dyna Data Infra — internal test",
      eaccount: "team@example.test",
    });
    f.state.requests.length = 0;
    const ensured = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(ensured).toMatchObject({ created: false, campaignId: CAMPAIGN });
    expect(f.state.requests.filter((r) => r.path === "/api/v2/campaigns")).toEqual([]);
    expect(f.prisma.externalEffect.create).toHaveBeenCalledTimes(1);
    // A second create never steals an existing mapping.
    await f.run("create_campaign", { name: "Another", eaccount: "team@example.test" });
    expect(f.prisma.externalEffect.create).toHaveBeenCalledTimes(1);
  });

  it("ensure_role_campaign adopts an unbound same-title draft (leads first) before creating", async () => {
    const f = fixture();
    f.state.campaigns = [
      { id: "active", name: "Founding Engineer", status: 1, timestamp_created: "2026-10-23" },
      { id: "empty", name: "founding engineer", status: 0, timestamp_created: "2026-10-22" },
      {
        id: "with-leads",
        name: "Founding Engineer",
        status: 2,
        timestamp_created: "2026-10-01",
        stop_on_reply: true,
      },
      { id: "prefix", name: "Founding Engineer v2", status: 0, timestamp_created: "2026-10-23" },
    ];
    const ensured = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(ensured).toMatchObject({ adopted: true, created: false, campaignId: "with-leads" });
    expect(
      f.state.requests.some((r) => r.method === "POST" && r.path === "/api/v2/campaigns"),
    ).toBe(false);
    expect(f.prisma.externalEffect.create).toHaveBeenCalledTimes(1);
  });

  it("repairs an empty mapped campaign to the same-title campaign that has the leads", async () => {
    const f = fixture();
    await f.run("ensure_role_campaign", { role_id: "role-1" });
    f.state.campaigns = [
      {
        id: CAMPAIGN,
        name: "Founding Engineer [role role-1]",
        status: 0,
        timestamp_created: "2026-10-23",
      },
      {
        id: "with-leads",
        name: "Founding Engineer",
        status: 0,
        timestamp_created: "2026-10-01",
        stop_on_reply: true,
      },
    ];
    f.state.requests.length = 0;
    const repaired = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(repaired).toMatchObject({ created: false, adopted: true, campaignId: "with-leads" });
    expect(f.prisma.externalEffect.create).toHaveBeenCalledTimes(1);
    expect(f.prisma.externalEffect.update).toHaveBeenCalledTimes(1);
    expect(f.state.requests.some((r) => r.path.endsWith("/activate"))).toBe(false);
    expect(
      f.state.requests.some((r) => r.method === "POST" && r.path === "/api/v2/campaigns"),
    ).toBe(false);
    const again = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(again).toMatchObject({ created: false, campaignId: "with-leads" });
  });

  it("re-adopts when the mapped campaign was deleted (404)", async () => {
    const f = fixture();
    await f.run("ensure_role_campaign", { role_id: "role-1" });
    f.state.deleted = true;
    f.state.campaigns = [
      {
        id: "empty",
        name: "Founding Engineer",
        status: 0,
        timestamp_created: "2026-10-22",
        stop_on_reply: true,
      },
    ];
    const readopted = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(readopted).toMatchObject({ adopted: true, campaignId: "empty" });
    expect(f.prisma.externalEffect.update).toHaveBeenCalledTimes(1);
  });

  it("add_shortlist_leads ensures the role campaign itself when the role has none", async () => {
    const f = fixture();
    const out = f.result(
      await f.run("add_shortlist_leads", {
        role_id: "role-1",
        candidates: [{ candidate_key: "a", email: "a@x.test" }],
      }),
    );
    expect(out).toMatchObject({ campaignId: CAMPAIGN, added: ["a"] });
    expect(f.state.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      "POST /api/v2/campaigns",
    );
    expect(f.state.effects.size).toBe(1);
  });

  it("resolves the role from the conversation when role_id is omitted", async () => {
    const f = fixture();
    expect((await f.run("ensure_role_campaign", {}))[0]).toMatchObject({
      type: "error",
      message: expect.stringMatching(/no linked recruiting role/),
    });
    f.state.activeRoleId = "role-1";
    const ensured = f.result(await f.run("ensure_role_campaign", {}));
    expect(ensured).toMatchObject({ created: true, campaignId: CAMPAIGN });
    expect(f.state.effects.has(`instantly-role-campaign:${SERVER.id}:role-1`)).toBe(true);
    const added = f.result(
      await f.run("add_shortlist_leads", {
        candidates: [{ candidate_key: "a", email: "a@x.test" }],
      }),
    );
    expect(added).toMatchObject({ added: ["a"] });
  });

  it("activate_campaign without campaign_id ensures and activates the role's own campaign", async () => {
    const f = fixture();
    f.state.activeRoleId = "role-1";
    const events = await f.run("activate_campaign", {});
    expect(events[0]).toMatchObject({ type: "result" });
    const paths = f.state.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /api/v2/campaigns");
    expect(paths.at(-1)).toBe(`POST /api/v2/campaigns/${CAMPAIGN}/activate`);
  });

  it("picks the default mailbox: last used on this connection, else the first connected", async () => {
    const f = fixture();
    f.state.accounts = ["first@example.test", "second@example.test"];
    const first = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(first).toMatchObject({ eaccount: "first@example.test" });
    // A later role reuses the mailbox the space last bound, even when it is no longer first.
    f.state.accounts = ["other@example.test", "first@example.test"];
    f.prisma.recruitingRole.findFirst.mockImplementationOnce(async () => ({
      id: "role-2",
      title: "Designer",
    }));
    const second = f.result(await f.run("ensure_role_campaign", { role_id: "role-2" }));
    expect(second).toMatchObject({ eaccount: "first@example.test" });
    f.state.accounts = [];
    f.prisma.recruitingRole.findFirst.mockImplementationOnce(async () => ({
      id: "role-3",
      title: "PM",
    }));
    expect((await f.run("ensure_role_campaign", { role_id: "role-3" }))[0]).toMatchObject({
      type: "error",
      message: expect.stringMatching(/No Instantly mailbox is connected/),
    });
  });

  it("add_shortlist_leads dedups, skips missing emails and records candidate -> lead ids", async () => {
    const f = fixture();
    await f.run("ensure_role_campaign", { role_id: "role-1" });
    f.state.existingLeads = [{ id: "lead-existing", email: "b@x.test" }];
    f.state.requests.length = 0;
    const out = f.result(
      await f.run("add_shortlist_leads", {
        role_id: "role-1",
        candidates: [
          { candidate_key: "a", email: "a@x.test", first_name: "A" },
          { candidate_key: "b", email: "B@x.test" },
          { candidate_key: "c", email: null },
          { candidate_key: "not-shortlisted", email: "n@x.test" },
        ],
      }),
    );
    expect(out).toMatchObject({
      added: ["a"],
      alreadyInCampaign: ["b"],
      skippedMissingEmail: ["c"],
      notShortlisted: ["not-shortlisted"],
      leads: {
        a: { leadId: "lead-a@x.test", email: "a@x.test" },
        b: { leadId: "lead-existing", email: "B@x.test" },
      },
    });
    expect(f.state.requests.find((r) => r.path === "/api/v2/leads/add")?.body).toEqual({
      campaign_id: CAMPAIGN,
      skip_if_in_workspace: false,
      leads: [{ email: "a@x.test", first_name: "A" }],
    });
    const again = f.result(await f.run("ensure_role_campaign", { role_id: "role-1" }));
    expect(again.leads).toMatchObject({ a: { leadId: "lead-a@x.test" } });
  });
});

describe("MCP discovery tool-list cache", () => {
  function fixture() {
    const state = { failNext: false, initializations: 0, lists: 0 };
    const fetch = mcpFetch(state);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST" && (await request.clone().text()).includes('"tools/list"'))
        state.lists += 1;
      return fetch(input, init);
    });
    let assignment = {
      ...ASSIGNMENT,
      server: { ...SERVER },
    } as Record<string, unknown> & { server: typeof SERVER };
    const prisma = { botMcpServer: { findMany: vi.fn(async () => [assignment]) } };
    const connector = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    return {
      state,
      connector,
      context,
      prisma,
      setAssignment: (next: Partial<typeof assignment>) => {
        assignment = { ...assignment, ...next };
      },
    };
  }

  it("serves a warm discovery from the cache without a remote tools/list", async () => {
    const sink = createTestSink();
    const previousLogger = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const f = fixture();
    try {
      const first = await f.connector.discoverTools(f.context);
      expect(f.state.lists).toBe(1);
      const second = await f.connector.discoverTools(f.context);
      expect(second).toEqual(first);
      expect(f.state.lists).toBe(1);
      // Authorization is never cached: the assignment is read on every discovery.
      expect(f.prisma.botMcpServer.findMany).toHaveBeenCalledTimes(2);
      expect(
        sink.events
          .filter((event) => event.message === "discovery.cache")
          .map((event) => event.hit),
      ).toEqual([false, true]);
    } finally {
      await f.connector.close();
      installLogger(previousLogger);
    }
  });

  it("applies assignment changes at once and lists again after a server change or TTL", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      expect(await f.connector.discoverTools(f.context)).toHaveLength(1);
      // Allowlist narrowed: filtered from the cached list, no remote call needed.
      f.setAssignment({ allowAllTools: false, allowedTools: [] });
      expect(await f.connector.discoverTools(f.context)).toEqual([]);
      expect(f.state.lists).toBe(1);
      // Server or credential write bumps the revision (or secretId): a miss.
      f.setAssignment({ allowAllTools: true, server: { ...SERVER, revision: 2 } });
      const tools = await f.connector.discoverTools(f.context);
      expect(f.state.lists).toBe(2);
      expect(tools[0]!.route?.resourceRevision).toBe(2);
      await f.connector.discoverTools(f.context);
      expect(f.state.lists).toBe(2);
      await vi.advanceTimersByTimeAsync(DISCOVERY_CACHE_TTL_MS);
      await f.connector.discoverTools(f.context);
      expect(f.state.lists).toBe(3);
    } finally {
      await f.connector.close();
      vi.useRealTimers();
    }
  });

  it("skips a server that just failed discovery until the failure TTL or a version change", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    const previousLogger = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const f = fixture();
    try {
      f.state.failNext = true;
      expect(await f.connector.discoverTools(f.context)).toEqual([]);
      const attempted = f.state.initializations;
      f.state.failNext = false;
      // Within the window: no connect, no tools/list, and one `discovery.skipped` log.
      expect(await f.connector.discoverTools(f.context)).toEqual([]);
      expect(await f.connector.discoverTools(f.context)).toEqual([]);
      expect(f.state.initializations).toBe(attempted);
      expect(f.state.lists).toBe(0);
      expect(sink.events.filter((event) => event.message === "discovery.skipped")).toHaveLength(1);
      // A server/credential write changes the version and retries at once.
      f.setAssignment({ server: { ...SERVER, revision: 2 } });
      expect(await f.connector.discoverTools(f.context)).toHaveLength(1);
      expect(f.state.lists).toBe(1);
      // TTL expiry retries.
      f.state.failNext = true;
      await vi.advanceTimersByTimeAsync(DISCOVERY_CACHE_TTL_MS);
      expect(await f.connector.discoverTools(f.context)).toEqual([]);
      f.state.failNext = false;
      await vi.advanceTimersByTimeAsync(DISCOVERY_FAILURE_TTL_MS);
      expect(await f.connector.discoverTools(f.context)).toHaveLength(1);
    } finally {
      await f.connector.close();
      installLogger(previousLogger);
      vi.useRealTimers();
    }
  });
});
