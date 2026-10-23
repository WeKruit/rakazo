import { getRecruitingWorkspaceCrmTarget } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentCrmScopedArgs, McpConnector, scopedInstantlyCampaign } from "./mcp-connector.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getRecruitingWorkspaceCrmTarget: vi.fn(),
}));

const target = {
  mcpServerId: "crm-server",
  serverRevision: 1,
  organizationId: "10000000-0000-4000-8000-000000000001",
  crmRoleId: "20000000-0000-4000-8000-000000000002",
  crmClientId: "30000000-0000-4000-8000-000000000003",
  clientLabel: "Example Client",
  roleLabel: "Engineer",
};
const candidate = "40000000-0000-4000-8000-000000000004";
const membership = {
  organization_id: target.organizationId,
  candidate_id: candidate,
  role_spec_id: target.crmRoleId,
  client_id: target.crmClientId,
  membership_id: "membership-1",
};
const receipt = (data: unknown) => ({ structuredContent: { data } });

beforeEach(() => vi.mocked(getRecruitingWorkspaceCrmTarget).mockReset());

describe("agent CRM candidate and correspondence scope", () => {
  it.each([
    "list_crm_candidate_correspondence",
    "list_crm_candidate_messages",
    "get_crm_candidate_outreach_context",
    "list_crm_candidate_roles",
  ])("requires current-role membership for %s and preserves exact query", async (tool) => {
    const read = vi.fn(async () => receipt([membership]));
    const args = {
      p_org: target.organizationId,
      p_candidate: candidate,
      p_limit: 25,
      p_cursor: {
        p_org: target.organizationId,
        p_candidate: candidate,
        linked_offset: 5,
        unlinked_offset: 0,
      },
    };
    expect(await agentCrmScopedArgs(tool, args, target, read)).toEqual(args);
    expect(read).toHaveBeenCalledExactlyOnceWith({
      p_org: target.organizationId,
      p_candidate: candidate,
    });
  });
  it.each(["organization_id", "candidate_id", "role_spec_id", "client_id"])(
    "rejects wrong membership %s",
    async (field) => {
      const read = vi.fn(async () => receipt([{ ...membership, [field]: "other" }]));
      await expect(
        agentCrmScopedArgs(
          "get_crm_candidate_outreach_context",
          { p_candidate: candidate },
          target,
          read,
        ),
      ).rejects.toThrow(/verified member/);
    },
  );
  it.each([{}, { isError: true, ...receipt([membership]) }, receipt([])])(
    "rejects absent or failed membership proof",
    async (value) => {
      await expect(
        agentCrmScopedArgs(
          "list_crm_candidate_messages",
          { p_candidate: candidate },
          target,
          async () => value,
        ),
      ).rejects.toThrow(/verified member/);
    },
  );
  it.each([
    { p_org: "other" },
    { p_role: "other" },
    { p_client: "other" },
    { p_cursor: { p_org: target.organizationId, p_candidate: "other" } },
  ])("rejects mismatched query before membership dispatch: %j", async (args) => {
    const read = vi.fn();
    await expect(
      agentCrmScopedArgs(
        "list_crm_candidate_correspondence",
        { p_candidate: candidate, ...args },
        target,
        read,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("does not use organization-wide enumeration as a role fallback", async () => {
    await expect(agentCrmScopedArgs("list_crm_roles", {}, target, vi.fn())).rejects.toThrow(
      /current CRM role workspace/,
    );
  });
  it("preserves the exact role and pagination for role correspondence", async () => {
    const read = vi.fn();
    expect(
      await agentCrmScopedArgs(
        "list_crm_role_correspondence",
        { p_org: target.organizationId, p_role: target.crmRoleId, p_limit: 50, p_offset: 100 },
        target,
        read,
      ),
    ).toEqual({
      p_org: target.organizationId,
      p_role: target.crmRoleId,
      p_limit: 50,
      p_offset: 100,
    });
    expect(read).not.toHaveBeenCalled();
  });
});

function fixture(endpoint = "https://crm.example.test/mcp") {
  const server = {
    id: target.mcpServerId,
    revision: 1,
    endpoint,
    transport: "streamable_http",
    userId: "owner",
    spaceId: "space",
    enabled: true,
  };
  const assignment = {
    server,
    userId: "owner",
    spaceId: "space",
    botId: "bot",
    allowAllTools: true,
    allowedTools: [],
  };
  const prisma = {
    botMcpServer: { findFirst: vi.fn(async () => assignment) },
    run: { findFirst: vi.fn(async () => ({ threadId: "current-thread" })) },
  };
  const connector = new McpConnector(prisma as never, {} as never);
  const callTool = vi.fn(async (name: string, _args?: Record<string, unknown>) =>
    name === "get_crm_role"
      ? receipt({
          role_spec_id: target.crmRoleId,
          client_id: target.crmClientId,
          client_label: target.clientLabel,
          role_label: target.roleLabel,
        })
      : name === "list_crm_candidate_roles"
        ? receipt([membership])
        : receipt({ rows: [], total: 0 }),
  );
  const sessionFor = vi
    .spyOn(
      connector as unknown as { sessionFor: (...args: unknown[]) => Promise<unknown> },
      "sessionFor",
    )
    .mockResolvedValue({
      callTool,
      listTools: async () => ({
        tools: [
          {
            name: "list_emails",
            inputSchema: { type: "object", properties: { campaign_id: { type: "string" } } },
          },
        ],
      }),
    });
  vi.mocked(getRecruitingWorkspaceCrmTarget).mockResolvedValue(target);
  const collect = async (tool = "list_crm_candidates", args: Record<string, unknown> = {}) => {
    const events = [];
    for await (const event of connector.execute(
      {
        tool: `mcp__crm__${tool}`,
        executionId: "test-call",
        route: { connectorId: "mcp", resourceId: server.id, resourceRevision: 1, toolName: tool },
        args,
      },
      {
        operationId: "op",
        traceId: "trace",
        runId: "run",
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        signal: new AbortController().signal,
      },
    ))
      events.push(event);
    return events;
  };
  return { prisma, connector, callTool, sessionFor, collect };
}

describe("CRM connector dispatch", () => {
  it("uses only the authorized run's current thread and rechecks role before dispatch", async () => {
    const f = fixture();
    expect(await f.collect()).toMatchObject([{ type: "result" }]);
    expect(f.prisma.run.findFirst).toHaveBeenCalledWith({
      where: { id: "run", spaceId: "space", userId: "owner", botId: "bot" },
      select: { threadId: true },
    });
    expect(getRecruitingWorkspaceCrmTarget).toHaveBeenCalledWith(
      f.prisma,
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
      { threadId: "current-thread" },
    );
    expect(f.callTool.mock.calls.map(([tool]) => tool)).toEqual([
      "get_crm_role",
      "list_crm_candidates",
    ]);
    expect(f.callTool).toHaveBeenLastCalledWith(
      "list_crm_candidates",
      {
        p_not_reviewed: false,
        p_org: target.organizationId,
        p_client: target.clientLabel,
        p_role: target.roleLabel,
      },
      expect.anything(),
    );
  });
  it.each(["missing", "other-server", "stale-source"])(
    "refuses %s workspace before connecting",
    async (kind) => {
      const f = fixture();
      vi.mocked(getRecruitingWorkspaceCrmTarget).mockResolvedValue(
        kind === "missing"
          ? null
          : {
              ...target,
              ...(kind === "other-server" ? { mcpServerId: "other" } : { serverRevision: 2 }),
            },
      );
      expect(await f.collect()).toMatchObject([{ type: "error" }]);
      expect(f.sessionFor).not.toHaveBeenCalled();
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );
  it("rejects explicit other-role labels without dispatching the candidate read", async () => {
    const f = fixture();
    expect(await f.collect("list_crm_candidates", { p_role: "Other role" })).toMatchObject([
      { type: "error" },
    ]);
    expect(f.callTool.mock.calls.map(([tool]) => tool)).toEqual(["get_crm_role"]);
  });
  it("rejects a changed workspace during membership lookup", async () => {
    const f = fixture();
    vi.mocked(getRecruitingWorkspaceCrmTarget)
      .mockResolvedValueOnce(target)
      .mockResolvedValue({ ...target, crmRoleId: "20000000-0000-4000-8000-000000000099" });
    expect(
      await f.collect("list_crm_candidate_messages", { p_candidate: candidate }),
    ).toMatchObject([{ type: "error" }]);
    expect(f.callTool.mock.calls.map(([tool]) => tool)).toEqual([
      "get_crm_role",
      "list_crm_candidate_roles",
    ]);
  });
});

describe("Instantly campaign selection", () => {
  it("fills only a single exact role campaign and preserves an explicit current one", () => {
    expect(scopedInstantlyCampaign({}, ["campaign-a"])).toBe("campaign-a");
    expect(
      scopedInstantlyCampaign({ campaign_id: "campaign-b" }, ["campaign-a", "campaign-b"]),
    ).toBe("campaign-b");
  });
  it.each([{ campaigns: [] }, { campaigns: ["campaign-a", "campaign-b"] }])(
    "refuses missing or ambiguous campaign identity %j",
    ({ campaigns }) => {
      expect(() => scopedInstantlyCampaign({}, campaigns)).toThrow(/exact campaign/);
    },
  );
  it("never replaces an explicit unrelated campaign", () => {
    expect(() => scopedInstantlyCampaign({ campaign_id: "other" }, ["campaign-a"])).toThrow(
      /exact campaign/,
    );
  });
});

describe("direct Instantly MCP email reads", () => {
  const email = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    organization_id: "123e4567-e89b-42d3-a456-426614174001",
    campaign_id: "123e4567-e89b-42d3-a456-426614174002",
    timestamp_created: "2026-10-22T10:00:00Z",
    timestamp_email: "2026-10-22T10:00:00Z",
    message_id: "<synthetic@example.test>",
    thread_id: "thread-a",
    eaccount: "mailbox@example.test",
    from_address_email: "person@example.test",
    to_address_email_list: "mailbox@example.test",
    subject: "Example",
    body: { text: "Synthetic reply" },
  };
  function scopedFixture() {
    const f = fixture("https://mcp.instantly.ai/mcp");
    vi.spyOn(
      f.connector as unknown as {
        instantlyCampaignScope: () => Promise<{ campaignIds: string[] }>;
      },
      "instantlyCampaignScope",
    ).mockResolvedValue({ campaignIds: [email.campaign_id] });
    return f;
  }
  it("dispatches direct list with exact campaign and unchanged mailbox and cursor", async () => {
    const f = scopedFixture();
    f.callTool.mockResolvedValue({ structuredContent: { items: [email] } } as never);
    expect(
      await f.collect("list_emails", { eaccount: email.eaccount, starting_after: "cursor" }),
    ).toMatchObject([{ type: "result" }]);
    expect(f.callTool).toHaveBeenCalledWith(
      "list_emails",
      { campaign_id: email.campaign_id, eaccount: email.eaccount, starting_after: "cursor" },
      expect.anything(),
    );
  });
  it("refuses direct broad list if remote schema cannot express a campaign filter", async () => {
    const f = scopedFixture();
    f.sessionFor.mockResolvedValue({
      callTool: f.callTool,
      listTools: async () => ({
        tools: [{ name: "list_emails", inputSchema: { type: "object", properties: {} } }],
      }),
    });
    expect(await f.collect("list_emails")).toMatchObject([{ type: "error" }]);
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it.each(["campaign_id", "eaccount"])("rejects mismatched %s from direct list", async (field) => {
    const f = scopedFixture();
    f.callTool.mockResolvedValue({
      structuredContent: {
        items: [
          { ...email, [field]: field === "campaign_id" ? target.crmRoleId : "other@example.test" },
        ],
      },
    } as never);
    expect(
      await f.collect("list_emails", { campaign_id: email.campaign_id, eaccount: email.eaccount }),
    ).toMatchObject([{ type: "error" }]);
  });
  it("blocks a direct remote reply on another role campaign before the send call", async () => {
    const f = scopedFixture();
    f.callTool.mockResolvedValue({
      structuredContent: { ...email, campaign_id: target.crmRoleId },
    } as never);
    expect(
      await f.collect("reply_to_email", {
        reply_to_uuid: email.id,
        eaccount: email.eaccount,
        body: { text: "Synthetic" },
      }),
    ).toMatchObject([{ type: "error" }]);
    expect(f.callTool.mock.calls.map(([tool]) => tool)).toEqual(["get_email"]);
  });
  it("reads imported campaign identity from the exact current CRM role before direct email dispatch", async () => {
    const f = fixture("https://mcp.instantly.ai/mcp");
    f.callTool.mockImplementation(async (name, args) =>
      name === "get_crm_role" && args?.p_view === "campaigns"
        ? receipt({
            organization_id: target.organizationId,
            role_spec_id: target.crmRoleId,
            campaigns: [
              {
                id: email.campaign_id,
                name: "Existing campaign",
                status: 2,
                synced_at: "2026-10-23T00:00:00Z",
              },
            ],
            pagination: "offset",
            offset: 0,
            next_offset: null,
          })
        : ({ structuredContent: { items: [email] } } as never),
    );
    expect(await f.collect("list_emails", { eaccount: email.eaccount })).toMatchObject([
      { type: "result" },
    ]);
    expect(f.callTool).toHaveBeenNthCalledWith(
      1,
      "get_crm_role",
      {
        p_org: target.organizationId,
        p_role: target.crmRoleId,
        p_view: "campaigns",
        p_limit: 50,
        p_offset: 0,
      },
      expect.anything(),
    );
    expect(f.callTool.mock.calls.map(([tool]) => tool)).toEqual(["get_crm_role", "list_emails"]);
  });
  it.each([true, false])(
    "direct get_email requires exact id and current campaign (valid=%s)",
    async (valid) => {
      const f = scopedFixture();
      f.callTool.mockResolvedValue({
        structuredContent: { ...email, campaign_id: valid ? email.campaign_id : target.crmRoleId },
      } as never);
      expect(await f.collect("get_email", { id: email.id })).toMatchObject([
        { type: valid ? "result" : "error" },
      ]);
    },
  );
});
