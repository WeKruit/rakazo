import { createHash } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { AdapterContext, ArtifactStore, ConnectorCall } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { readInstantlyEmail } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  RecruitingAssessmentSnapshotSchema,
  RecruitingCrmCandidatesReadSchema,
} from "@rakazo/contracts";
import { catalogApprovalRequest } from "@rakazo/core";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type * as DbExports from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./recruiting.js";
import type { RouterDeps } from "./router.js";
import { createRouter as createNativeRouter } from "./router.js";

const createRouter = (deps: RouterDeps) =>
  createNativeRouter({ env: { deploymentModelConfigured: false } as RouterDeps["env"], ...deps });

vi.mock("@rakazo/core/node/pdf-text", () => ({ extractPdfText: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbExports>();
  return {
    ...actual,
    confirmRecruitingBrief: vi.fn(),
    editRecruitingCriteria: vi.fn(),
    createRecruitingRole: vi.fn(),
    bindRecruitingRole: vi.fn(),
    getRecruitingWorkspace: vi.fn(),
    getRecruitingWorkspaceCrmTarget: vi.fn(),
    getRecruitingWorkspaceRoleId: vi.fn(),
    listRecruitingCandidateLinkedinUrls: vi.fn(),
    listSyncedRecruitingCrmRoleContacts: vi.fn(),
    getRecruitingCrmTarget: vi.fn(),
    getRecruitingCrmCandidateSyncs: vi.fn(),
    readRecruitingNativeCorrespondence: vi.fn(async () => null),
    reviseRecruitingRole: vi.fn(),
    listRecruitingAssessments: vi.fn(),
    listRecruitingFeedback: vi.fn(),
    getRecruitingAssessment: vi.fn(),
    listRecruitingResearch: vi.fn(),
    listRecruitingCandidates: vi.fn(),
    listRecruitingCandidateSources: vi.fn(),
    setRecruitingCandidateShortlist: vi.fn(),
  };
});
const prisma = {
  event: { findFirst: vi.fn(async () => null) },
} as unknown as PrismaClient;
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("saved recruiting correspondence", () => {
  beforeEach(() =>
    vi.mocked(db.readRecruitingNativeCorrespondence).mockReset().mockResolvedValue(null),
  );
  const target = {
    kind: "group" as const,
    groupId: "role-group",
    threadId: "role-thread",
    groupName: "Role",
    memberBotIds: ["main"],
    members: [],
  };
  const email = {
    id: "d1495a46-b3f5-4afe-8e0f-8886bedb6932",
    timestamp_created: "2026-10-22T01:00:00Z",
    timestamp_email: "2026-10-22T00:59:00Z",
    message_id: "<original@example.test>",
    subject: "Original subject",
    from_address_email: "person@example.test",
    to_address_email_list: "team@example.test",
    body: { text: "Original provider body" },
    organization_id: "58713398-41d5-40cb-a2d2-0b2ecd1af269",
    campaign_id: "917ea6c3-b928-47a8-b11f-d19178e68d48",
    eaccount: "team@example.test",
  };
  function fixture({
    result = {
      isError: false,
      structuredContent: { items: [email], next_starting_after: null },
    } as unknown,
    enabled = true,
    permission = true,
    current = true,
  } = {}) {
    const request = [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: "mail",
          resourceRevision: 1,
          toolName: "list_emails",
        },
        args: {
          campaign_id: email.campaign_id,
          email_type: "received",
          limit: 2,
          privateKey: "never-return-arguments",
        },
      },
    ];
    const retained = {
      id: "effect",
      request,
      status: "completed",
      updatedAt: new Date("2026-10-22T01:00:00Z"),
      run: { botId: "main" },
    };
    const client = {
      mcpServer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "mail",
            name: "Instantly",
            endpoint: "https://mcp.instantly.ai/mcp",
            secretId: "encrypted-reference",
            revision: 1,
            enabled,
            assignments: permission
              ? [{ botId: "main", allowAllTools: false, allowedTools: ["list_emails"] }]
              : [],
          },
        ]),
      },
      externalEffect: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([retained])
          .mockResolvedValueOnce([{ id: "effect", result }]),
      },
      thread: { findFirst: vi.fn().mockResolvedValue(current ? { id: "role-thread" } : null) },
    };
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({ role: { id: "role" } } as never);
    return { client, prisma: client as unknown as PrismaClient, retained };
  }
  const crmIdentity = { endpoint: "https://crm.example.test/mcp", connected: true };
  const crmCandidate = "9dbe8bb7-8fbc-4f73-9fef-5deae2b32dc7";
  it.each(["sent_recorded", "scheduled", "unknown"] as const)(
    "projects scoped native %s and exact full reads without an old campaign snapshot",
    async (status) => {
      const f = fixture();
      f.client.externalEffect.findMany.mockReset().mockResolvedValue([]);
      const mailServer = {
        ...actor,
        id: "mail",
        name: "Instantly",
        revision: 1,
        enabled: true,
        endpoint: "https://mcp.instantly.ai/mcp",
        transport: "streamable_http",
        secretId: null,
      };
      const grant = {
        ...actor,
        serverId: "mail",
        botId: "main",
        allowAllTools: false,
        allowedTools: ["get_email", "reply_to_email"],
      };
      f.client.mcpServer.findMany.mockResolvedValue([
        { ...mailServer, assignments: [grant] },
      ] as never);
      Object.assign(f.client, { botMcpServer: { findMany: vi.fn(async () => [grant]) } });
      Object.assign(f.client, {
        $transaction: async (callback: (tx: typeof f.client) => Promise<unknown>) =>
          callback(f.client),
      });
      const membership = vi.fn(async () => [actor]);
      Object.assign(f.client, { $queryRaw: membership });
      const anchor = { ...email, ue_type: 2, thread_id: "provider-thread" };
      const outbound = {
        ...anchor,
        id: "d1495a46-b3f5-4afe-8e0f-8886bedb6933",
        message_id: "<reply@example.test>",
        from_address_email: "team@example.test",
        to_address_email_list: "person@example.test",
        ue_type: status === "scheduled" ? 4 : 3,
        body: { text: "Exact native reply" },
      };
      const read = {
        id: "native-email-read",
        status: "completed",
        request: catalogApprovalRequest(
          "connectors_execute_tool",
          { id: "mail:get_email", arguments: { id: anchor.id } },
          "__rakazoCatalogTool",
          { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: "get_email" },
        ),
        result: { structuredContent: anchor },
        run: { id: "run", sourceMessageId: "human" },
        createdAt: new Date(email.timestamp_created),
        updatedAt: new Date(email.timestamp_created),
      };
      const evidence = {
        roleId: "role",
        bindingEffectId: "binding",
        target: { crmRoleId: "50000000-0000-4000-8000-000000000005" },
        crmSource: { endpoint: crmIdentity.endpoint, transport: "streamable_http" },
        partial: false,
        authorizations: ["get_email", "reply_to_email"].map((tool) => ({
          server: { ...mailServer },
          botId: "main",
          tool,
        })),
        records: [
          {
            scope: { candidateId: crmCandidate },
            source: {
              id: "mail",
              name: "Instantly",
              endpoint: "https://mcp.instantly.ai/mcp",
              transport: "streamable_http",
            },
            emailRead: read,
            reads: [read],
            args: {
              reply_to_uuid: anchor.id,
              eaccount: "team@example.test",
              to: "person@example.test",
              subject: anchor.subject,
              body_text: outbound.body.text,
              skip_validation: false,
            },
            effect: {
              id: "native-reply",
              status: status === "unknown" ? "uncertain" : "completed",
              result: {
                status,
                sourceReadEffectId: read.id,
                receipt: {
                  emailId: outbound.id,
                  messageId: outbound.message_id,
                  threadId: outbound.thread_id,
                  organizationId: outbound.organization_id,
                  replyToEmailId: anchor.id,
                  timestampCreated: outbound.timestamp_created,
                  timestampEmail: outbound.timestamp_email,
                },
                providerResult: { structuredContent: outbound },
              },
              run: { id: "run", sourceMessageId: "human" },
              createdAt: new Date(email.timestamp_created),
              updatedAt: new Date(email.timestamp_created),
            },
          },
        ],
      };
      vi.mocked(db.readRecruitingNativeCorrespondence).mockResolvedValue(evidence as never);
      const output = await api.getRecruitingCorrespondence(
        f.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(output.emails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerMessageId: anchor.id, body: anchor.body.text }),
        ]),
      );
      expect(output.emails.some((row) => row.providerMessageId === outbound.id)).toBe(
        status !== "unknown",
      );
      if (status === "sent_recorded") {
        const fresh = {
          ...read,
          id: "fresh-outbound-read",
          request: catalogApprovalRequest(
            "connectors_execute_tool",
            { id: "mail:get_email", arguments: { id: outbound.id } },
            "__rakazoCatalogTool",
            { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: "get_email" },
          ),
          result: { structuredContent: { ...outbound, body: { text: "Fresh full readback" } } },
          updatedAt: new Date(Date.parse(email.timestamp_created) + 1000),
        };
        evidence.records[0]!.reads.push(fresh);
        expect(
          (
            await api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity)
          ).emails.find((row) => row.providerMessageId === outbound.id)?.body,
        ).toBe("Fresh full readback");
        fresh.result.structuredContent.thread_id = "another-provider-thread";
        expect(
          (
            await api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity)
          ).emails.find((row) => row.providerMessageId === outbound.id)?.body,
        ).toBe(outbound.body.text);
        evidence.records[0]!.reads.pop();
      }
      grant.allowedTools = [];
      await expect(
        api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      grant.allowedTools = ["get_email", "reply_to_email"];
      f.client.mcpServer.findMany.mockResolvedValue([
        { ...mailServer, revision: 2, assignments: [grant] },
      ] as never);
      await expect(
        api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      f.client.mcpServer.findMany.mockResolvedValue([
        { ...mailServer, assignments: [grant] },
      ] as never);
      membership.mockResolvedValue([]);
      await expect(
        api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      membership.mockResolvedValue([actor]);
      Object.assign(read.result, { isError: true });
      evidence.records[0]!.effect.status = "approved";
      expect(
        (await api.getRecruitingCorrespondence(f.prisma, actor, target, "inbox", crmIdentity))
          .emails,
      ).toEqual([]);
    },
  );
  const crmTarget = {
    mcpServerId: "mail",
    serverRevision: 1,
    organizationId: email.organization_id,
    crmRoleId: "a33ee28b-1d32-46ba-a167-2274af9be079",
    crmClientId: "cce1292a-de54-45a4-abd9-e3f5185f8872",
    clientLabel: "Client",
    roleLabel: "Role",
  };
  function crmFixture() {
    const message = {
      id: "stored-message",
      organization_id: email.organization_id,
      candidate_id: null,
      lead_email: "person@example.test",
      thread_id: "original-thread",
      direction: "received",
      timestamp_email: email.timestamp_email,
      campaign_id: "original-campaign",
      from_address: "person@example.test",
      to_address: "team@example.test",
      subject: "Stored original",
      body_text: "Stored full body\n".repeat(4000),
    };
    const data = {
      organization_id: email.organization_id,
      candidate_id: crmCandidate,
      messages: [message],
      pagination: "offset",
      next_cursor: null as unknown,
    };
    const result = { structuredContent: { data } };
    const state = fixture({ result });
    Object.assign(state.retained.run, { id: "historical-completed-run" });
    const call = state.retained.request[2] as unknown as {
      route: { toolName: string };
      args: Record<string, unknown>;
    };
    call.route.toolName = "list_crm_candidate_correspondence";
    call.args = { p_org: email.organization_id, p_candidate: crmCandidate, p_limit: 10 };
    const server = {
      id: "mail",
      name: "Recruiting CRM",
      endpoint: crmIdentity.endpoint,
      transport: "streamable_http",
      secretId: null as string | null,
      enabled: true,
      revision: 1,
      assignments: [{ botId: "main", allowAllTools: false, allowedTools: [call.route.toolName] }],
    };
    state.client.mcpServer.findMany.mockResolvedValue([server] as never);
    const binding = { roleId: "role", bindingEffectId: "binding", target: crmTarget };
    vi.mocked(db.getRecruitingCrmTarget).mockReset().mockResolvedValue(binding);
    const sync = {
      effectId: "import",
      bindingEffectId: "binding",
      target: crmTarget,
      status: "synced",
      receipt: { organization_id: email.organization_id, candidate_id: crmCandidate },
    };
    vi.mocked(db.listRecruitingCandidateSources).mockReset();
    vi.mocked(db.getRecruitingCrmCandidateSyncs)
      .mockReset()
      .mockResolvedValue([sync] as never);
    const imports = {
      findFirst: vi.fn().mockResolvedValue({
        effectId: "import",
        occurrence: { candidateKey: "linkedin:/in/person" },
      }),
    };
    Object.assign(state.client, { recruitingCrmImport: imports });
    return { ...state, call, server, binding, sync, data, message, result, imports };
  }
  function crmMembershipFixture() {
    const state = crmFixture();
    state.message.body_text = "Original legacy candidate correspondence.";
    const membership = structuredClone(state.retained);
    membership.id = "role-membership-read";
    membership.updatedAt = new Date("2026-10-22T01:01:00Z");
    const call = membership.request[2] as unknown as {
      route: { toolName: string; resourceRevision: number };
      args: Record<string, unknown>;
    };
    call.route.toolName = "list_crm_candidate_roles";
    call.args = { p_org: email.organization_id, p_candidate: crmCandidate };
    const row = {
      membership_id: "6e47e057-9093-4fb9-a2d3-1cbe21be04f4",
      organization_id: email.organization_id,
      candidate_id: crmCandidate,
      role_spec_id: crmTarget.crmRoleId,
      client_id: crmTarget.crmClientId,
      client_label: "Client",
      role_label: "Role",
      created_at: "2026-10-21T00:00:00Z",
    };
    const membershipResult = { structuredContent: { data: [row] } };
    state.server.assignments[0]!.allowedTools.push("list_crm_candidate_roles");
    state.imports.findFirst.mockResolvedValue(null);
    state.client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([membership, state.retained])
      .mockResolvedValueOnce([
        { id: membership.id, result: membershipResult },
        { id: state.retained.id, result: state.result },
      ]);
    return { ...state, membership, membershipCall: call, membershipResult, row };
  }
  it.each(["direct", "catalog", "text"])(
    "projects a legacy CRM member's full mail from a %s receipt without an Autumn import",
    async (format) => {
      const state = crmMembershipFixture();
      if (format === "catalog")
        state.membership.request = catalogApprovalRequest(
          "mcp_execute_tool",
          { id: "mail:list_crm_candidate_roles", arguments: state.membershipCall.args },
          "__rakazoCatalogTool",
          {
            connectorId: "mcp",
            resourceId: "mail",
            resourceRevision: 1,
            toolName: "list_crm_candidate_roles",
          },
        ) as never;
      if (format === "text") {
        const result = state.membershipResult as Record<string, unknown>;
        result.content = [{ type: "text", text: JSON.stringify(result.structuredContent) }];
        delete result.structuredContent;
      }
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result).toMatchObject({
        status: "ready",
        partial: false,
        emails: [{ body: state.message.body_text }],
      });
      expect(state.imports.findFirst).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
      expect(state.client.thread.findFirst).toHaveBeenCalledWith({
        where: {
          id: "role-thread",
          spaceId: actor.spaceId,
          userId: actor.userId,
          activeRecruitingRoleId: "role",
          activeRecruitingRole: { crmBindingEffectId: "binding" },
        },
        select: { id: true },
      });
    },
  );
  it.each([
    "failed",
    "failed-effect",
    "malformed",
    "empty",
    "organization",
    "candidate",
    "role",
    "client",
    "membership-id",
    "permission",
    "revision",
  ])(
    "does not revive older membership or import evidence after the latest CRM membership %s",
    async (boundary) => {
      const state = crmMembershipFixture();
      const old = structuredClone(state.membership);
      old.id = "older-membership";
      old.updatedAt = new Date("2026-10-21T00:00:00Z");
      const oldResult = structuredClone(state.membershipResult);
      if (boundary === "failed") Object.assign(state.membershipResult, { isError: true });
      if (boundary === "failed-effect") state.membership.status = "failed";
      if (boundary === "malformed")
        Object.assign(state.membershipResult, { structuredContent: { data: {} } });
      if (boundary === "empty") state.membershipResult.structuredContent.data = [];
      if (boundary === "organization") state.row.organization_id = crmCandidate;
      if (boundary === "candidate") state.row.candidate_id = email.organization_id;
      if (boundary === "role") state.row.role_spec_id = email.organization_id;
      if (boundary === "client") state.row.client_id = email.organization_id;
      if (boundary === "membership-id") state.row.membership_id = "not-a-membership-id";
      if (boundary === "permission")
        state.server.assignments[0]!.allowedTools = [state.call.route.toolName];
      if (boundary === "revision") state.membershipCall.route.resourceRevision = 2;
      state.imports.findFirst.mockResolvedValue({ effectId: "import" });
      state.client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([state.membership, state.retained, old])
        .mockResolvedValueOnce([
          { id: state.membership.id, result: state.membershipResult },
          { id: state.retained.id, result: state.result },
          { id: old.id, result: oldResult },
        ]);
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result.emails).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(state.message.body_text);
      expect(state.imports.findFirst).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
    },
  );
  it.each(["valid", "revision", "missing-subject"])(
    "does not count a %s membership-only read as a checked Inbox or mail permission",
    async (proof) => {
      const state = crmMembershipFixture();
      state.server.assignments[0]!.allowedTools = ["list_crm_candidate_roles"];
      if (proof === "revision") state.membershipCall.route.resourceRevision = 2;
      if (proof === "missing-subject") delete state.membershipCall.args.p_candidate;
      state.client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([state.membership])
        .mockResolvedValueOnce([{ id: state.membership.id, result: state.membershipResult }]);
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result).toMatchObject({
        status: "not_checked",
        checkedAt: null,
        emails: [],
        connections: [{ status: "needs_access", checkIssue: null }],
      });
      expect(db.getRecruitingCrmTarget).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "exact"])(
    "keeps %s membership evidence honest when retained CRM history is truncated",
    async (proof) => {
      const state = crmMembershipFixture();
      const others = Array.from({ length: proof === "exact" ? 198 : 199 }, (_, index) => {
        const read = structuredClone(state.membership);
        read.id = `other-membership-${index}`;
        (read.request[2] as unknown as { args: Record<string, unknown> }).args.p_candidate =
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        return read;
      });
      const negative = structuredClone(state.membership);
      negative.id = "last-membership-observation";
      negative.updatedAt = new Date("2026-10-21T00:00:00Z");
      state.imports.findFirst.mockResolvedValue({ effectId: "import" });
      state.client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([
          state.retained,
          ...(proof === "exact" ? [state.membership] : []),
          ...others,
          negative,
        ])
        .mockResolvedValueOnce([
          { id: state.retained.id, result: state.result },
          { id: state.membership.id, result: state.membershipResult },
          { id: negative.id, result: { structuredContent: { data: [] } } },
        ]);
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result.status).toBe(proof === "exact" ? "ready" : "unsupported");
      expect(result.partial).toBe(true);
      expect(result.emails).toHaveLength(proof === "exact" ? 1 : 0);
      expect(state.imports.findFirst).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
    },
  );
  it("projects CRM full stored bodies using the historical run's current binding and exact verified candidate import", async () => {
    const state = crmFixture();
    const result = await api.getRecruitingCorrespondence(
      state.prisma,
      actor,
      target,
      "inbox",
      crmIdentity,
    );
    expect(result).toMatchObject({
      status: "ready",
      roleId: "role",
      partial: false,
      connections: [{ name: "Recruiting CRM", status: "configured" }],
      emails: [
        { body: state.message.body_text, snippet: false, sender: state.message.from_address },
      ],
    });
    expect(result.emails[0]!.body.length).toBeGreaterThan(50_000);
    expect(db.getRecruitingCrmTarget).toHaveBeenCalledWith(state.prisma, actor, {
      runId: "historical-completed-run",
      roleId: "role",
    });
    expect(state.imports.findFirst.mock.calls[0]![0].where).toMatchObject({
      bindingEffectId: "binding",
      occurrence: { roleId: "role" },
      effect: { spaceId: actor.spaceId, run: { userId: actor.userId, spaceId: actor.spaceId } },
    });
    expect(state.imports.findFirst.mock.calls[0]![0].where.effect.AND).toContainEqual({
      result: { path: ["structuredContent", "data", "candidate_id"], equals: crmCandidate },
    });
    expect(db.getRecruitingCrmCandidateSyncs).toHaveBeenCalledWith(state.prisma, actor, {
      roleId: "role",
      effectIds: ["import"],
    });
    expect(db.listRecruitingCandidateSources).not.toHaveBeenCalled();
    expect(state.client.thread.findFirst.mock.calls[0]![0].where).toMatchObject({
      activeRecruitingRole: { crmBindingEffectId: "binding" },
    });
    expect(JSON.stringify(result)).not.toMatch(/original-thread|original-campaign|linkedin:/);
  });
  it("rejects a CRM display if the role or binding changes before the final ownership fence", async () => {
    const state = crmFixture();
    state.client.thread.findFirst.mockResolvedValue(null);
    await expect(
      api.getRecruitingCorrespondence(state.prisma, actor, target, "inbox", crmIdentity),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.client.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "role-thread",
        userId: actor.userId,
        spaceId: actor.spaceId,
        activeRecruitingRoleId: "role",
        activeRecruitingRole: { crmBindingEffectId: "binding" },
      },
      select: { id: true },
    });
  });
  it("preserves the native CRM source ownership rejection without returning a saved body", async () => {
    const state = crmFixture();
    vi.mocked(db.getRecruitingCrmCandidateSyncs).mockRejectedValueOnce(new IsolationError());
    await expect(
      api.getRecruitingCorrespondence(state.prisma, actor, target, "inbox", crmIdentity),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.each(["endpoint", "transport", "assignment", "disabled", "revision"])(
    "does not expose CRM bodies when the current %s boundary differs",
    async (boundary) => {
      const state = crmFixture();
      if (boundary === "endpoint") state.server.endpoint = "https://unrelated.example.test/mcp";
      if (boundary === "transport") state.server.transport = "sse";
      if (boundary === "assignment") state.server.assignments = [];
      if (boundary === "disabled") state.server.enabled = false;
      if (boundary === "revision") state.server.revision = 2;
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result.emails).toEqual([]);
      expect(db.listRecruitingCandidateSources).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
    },
  );
  it("describes reconnect honestly while retaining the caller's authorized saved CRM observation", async () => {
    const state = crmFixture();
    const result = await api.getRecruitingCorrespondence(state.prisma, actor, target, "inbox", {
      ...crmIdentity,
      connected: false,
    });
    expect(result.connections[0]!.status).toBe("needs_connection");
    expect(result.emails[0]!.body).toBe(state.message.body_text);
  });
  it.each(["connected", "reconnect", "none"] as const)(
    "uses the native personal CRM OAuth status %s instead of requiring product SSO",
    async (status) => {
      const state = crmFixture();
      state.server.secretId = "personal-credential";
      const oauth = { statusFor: vi.fn().mockResolvedValue(status) };
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        { ...crmIdentity, connected: false },
        oauth,
      );
      expect(oauth.statusFor).toHaveBeenCalledWith(
        expect.objectContaining({ id: "mail", secretId: "personal-credential" }),
        actor,
      );
      expect(result.connections[0]!.status).toBe(
        status === "connected" ? "configured" : "needs_connection",
      );
      expect(result.emails[0]!.body).toBe(state.message.body_text);
      expect(JSON.stringify(result)).not.toContain("personal-credential");
    },
  );
  it("keeps authorized saved mail readable during a personal CRM secret-store outage", async () => {
    const state = crmFixture();
    state.server.secretId = "personal-credential";
    const oauth = {
      statusFor: vi.fn().mockRejectedValue(new SecretStoreUnavailableError(503, "private failure")),
    };
    const result = await api.getRecruitingCorrespondence(
      state.prisma,
      actor,
      target,
      "inbox",
      { ...crmIdentity, connected: false },
      oauth,
    );
    expect(result.connections[0]!.status).toBe("unavailable");
    expect(result.emails[0]!.body).toBe(state.message.body_text);
    expect(JSON.stringify(result)).not.toMatch(/private failure|personal-credential/);
  });
  it.each(["organization", "candidate", "binding", "server", "status", "missing"])(
    "rejects a CRM import whose verified %s does not match the current binding",
    async (mismatch) => {
      const state = crmFixture();
      if (mismatch === "organization") state.sync.receipt.organization_id = crmCandidate;
      if (mismatch === "candidate") state.sync.receipt.candidate_id = email.organization_id;
      if (mismatch === "binding") state.sync.bindingEffectId = "previous-binding";
      if (mismatch === "server") state.sync.target = { ...crmTarget, mcpServerId: "another" };
      if (mismatch === "status") state.sync.status = "unknown";
      if (mismatch === "missing") state.imports.findFirst.mockResolvedValue(null);
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result).toMatchObject({ status: "unsupported", emails: [] });
    },
  );
  it("checks multiple CRM candidates from one provider page in one exact-receipt batch", async () => {
    const state = crmFixture();
    const secondCandidate = "8c680339-a85d-4aa5-87fe-230268e079a7";
    const second = structuredClone(state.retained);
    second.id = "second-effect";
    (second.request[2] as unknown as { args: Record<string, unknown> }).args.p_candidate =
      secondCandidate;
    const secondData = {
      ...state.data,
      candidate_id: secondCandidate,
      messages: [{ ...state.message, id: "second-message", body_text: "Second original" }],
    };
    state.client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([state.retained, second])
      .mockResolvedValueOnce([
        { id: state.retained.id, result: state.result },
        { id: second.id, result: { structuredContent: { data: secondData } } },
      ]);
    state.imports.findFirst
      .mockResolvedValueOnce({ effectId: "import", occurrence: { candidateKey: "first-person" } })
      .mockResolvedValueOnce({
        effectId: "second-import",
        occurrence: { candidateKey: "second-person" },
      });
    vi.mocked(db.getRecruitingCrmCandidateSyncs).mockResolvedValue([
      { ...state.sync, sourceEffectId: "shared-provider-page" },
      {
        ...state.sync,
        effectId: "second-import",
        sourceEffectId: "shared-provider-page",
        receipt: { ...state.sync.receipt, candidate_id: secondCandidate },
      },
    ] as never);
    const result = await api.getRecruitingCorrespondence(
      state.prisma,
      actor,
      target,
      "inbox",
      crmIdentity,
    );
    expect(result.status).toBe("ready");
    expect(result.emails).toHaveLength(2);
    expect(db.getRecruitingCrmCandidateSyncs).toHaveBeenCalledExactlyOnceWith(state.prisma, actor, {
      roleId: "role",
      effectIds: ["import", "second-import"],
    });
    expect(db.listRecruitingCandidateSources).not.toHaveBeenCalled();
    expect(db.getRecruitingCrmTarget).toHaveBeenCalledTimes(1);
  });
  it.each(["p_org", "p_candidate"])(
    "fails closed on a missing CRM %s before semantic deduplication",
    async (field) => {
      const state = crmFixture();
      delete state.call.args[field];
      state.retained.status = "failed";
      expect(
        await api.getRecruitingCorrespondence(state.prisma, actor, target, "inbox", crmIdentity),
      ).toMatchObject({ status: "unsupported", emails: [] });
      expect(state.imports.findFirst).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
    },
  );
  it.each(["envelope-org", "envelope-candidate", "row-org", "row-candidate", "body", "cursor"])(
    "does not project a malformed CRM %s",
    async (mismatch) => {
      const state = crmFixture();
      if (mismatch === "envelope-org") state.data.organization_id = crmCandidate;
      if (mismatch === "envelope-candidate") state.data.candidate_id = email.organization_id;
      if (mismatch === "row-org") state.message.organization_id = crmCandidate;
      if (mismatch === "row-candidate")
        Object.assign(state.message, { candidate_id: email.organization_id });
      if (mismatch === "body") Object.assign(state.message, { body_text: 7 });
      if (mismatch === "cursor")
        state.data.next_cursor = {
          p_org: crmCandidate,
          p_candidate: crmCandidate,
          linked_offset: 1,
          unlinked_offset: 0,
        };
      expect(
        await api.getRecruitingCorrespondence(state.prisma, actor, target, "inbox", crmIdentity),
      ).toMatchObject({ status: "unsupported", emails: [] });
      expect(state.imports.findFirst).not.toHaveBeenCalled();
      expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
    },
  );
  it.each(["more", "last", "empty", "failed", "failed-effect"])(
    "uses the newest CRM candidate page, preserving %s coverage and failure over older bodies",
    async (page) => {
      const state = crmFixture();
      const cursor = {
        p_org: email.organization_id,
        p_candidate: crmCandidate,
        linked_offset: 1,
        unlinked_offset: 0,
      };
      if (page === "more") state.data.next_cursor = cursor;
      else state.call.args.p_cursor = cursor;
      if (page === "empty") state.data.messages = [];
      if (page === "failed") Object.assign(state.result, { isError: true });
      if (page === "failed-effect") state.retained.status = "failed";
      const old = structuredClone(state.retained);
      old.id = "old-effect";
      old.updatedAt = new Date("2026-10-21T00:00:00Z");
      (old.request[2] as unknown as { args: unknown }).args = {
        p_org: email.organization_id,
        p_candidate: crmCandidate,
        p_limit: 1,
      };
      state.client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([state.retained, old])
        .mockResolvedValueOnce([
          { id: "effect", result: state.result },
          {
            id: old.id,
            result: {
              structuredContent: {
                data: {
                  ...state.data,
                  messages: [{ ...state.message, body_text: "stale original" }],
                },
              },
            },
          },
        ]);
      const result = await api.getRecruitingCorrespondence(
        state.prisma,
        actor,
        target,
        "inbox",
        crmIdentity,
      );
      expect(result.status).toBe(
        page.startsWith("failed") ? "failed" : page === "empty" ? "empty" : "ready",
      );
      expect(result.partial).toBe(true);
      expect(JSON.stringify(result)).not.toContain("stale original");
      if (page === "empty" || page.startsWith("failed")) {
        expect(state.imports.findFirst).not.toHaveBeenCalled();
        expect(db.getRecruitingCrmCandidateSyncs).not.toHaveBeenCalled();
      }
    },
  );
  it("projects the real native read envelope and allowlisted mail fields under current actor/thread/role permissions", async () => {
    const { client, prisma, retained } = fixture();
    Object.assign(retained.run, {
      id: "original-read-run",
      sourceMessageId: "original-read-message",
    });
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      emails: [
        {
          sender: email.from_address_email,
          sourceName: "Instantly",
          sourceId: "mail",
          providerMessageId: email.id,
          savedRead: {
            messageId: "original-read-message",
            linkedRunId: "original-read-run",
            effectId: "effect",
          },
          subject: email.subject,
          body: email.body.text,
          snippet: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /privateKey|never-return-arguments|encrypted-reference|saved-campaign/,
    );
    expect(client.externalEffect.findMany.mock.calls[0]![0].where).toMatchObject({
      spaceId: "space",
      run: {
        spaceId: "space",
        userId: "owner",
        threadId: "role-thread",
        botId: { in: ["main"] },
        OR: [
          { initialRecruitingRoleRevisionId: null },
          { initialRecruitingRoleRevision: { roleId: "role" } },
        ],
      },
    });
    expect(client.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "role-thread",
        spaceId: "space",
        userId: "owner",
        activeRecruitingRoleId: "role",
      },
      select: { id: true },
    });
  });
  it.each([
    [{ isError: true, content: [{ type: "text", text: "private-provider-failure" }] }, "failed"],
    [{ structuredContent: { id: "selected", date: "invalid-date" } }, "unsupported"],
  ])(
    "retains valid mail while exposing only the affected service's saved check issue: %j",
    async (result, status) => {
      const { client, prisma, retained } = fixture();
      const gmail = {
        id: "gmail",
        name: "Gmail",
        endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [{ botId: "main", allowAllTools: false, allowedTools: ["get_message"] }],
      };
      client.mcpServer.findMany.mockResolvedValueOnce([
        ...(await client.mcpServer.findMany()),
        gmail,
      ]);
      const check = {
        ...retained,
        id: "gmail-check",
        updatedAt: new Date("2026-10-22T01:01:00Z"),
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: "gmail",
              resourceRevision: 1,
              toolName: "get_message",
            },
            args: { messageId: "selected" },
          },
        ],
      };
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([check, retained])
        .mockResolvedValueOnce([
          { id: check.id, result },
          { id: retained.id, result: { structuredContent: { items: [email] } } },
        ]);
      const output = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(output).toMatchObject({
        status: "ready",
        partial: true,
        emails: [{ body: email.body.text }],
        connections: [
          { name: "Instantly", status: "configured", checkIssue: null },
          {
            name: "Gmail",
            status: "configured",
            checkIssue: { status, checkedAt: check.updatedAt.toISOString() },
          },
        ],
      });
      expect(output.emails).toHaveLength(1);
      expect(JSON.stringify(output)).not.toContain("private-provider-failure");
    },
  );
  it("displays native opaque Instantly thread IDs without weakening outbound anchor validation", async () => {
    const row = { ...email, thread_id: "provider-opaque-thread" };
    const { prisma } = fixture({
      result: { structuredContent: { items: [row], next_starting_after: null } },
    });
    expect(readInstantlyEmail(row)).toEqual(row);
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      emails: [{ sender: row.from_address_email, subject: row.subject, body: row.body.text }],
    });
    expect(JSON.stringify(result)).not.toContain(row.thread_id);
  });
  it.each([
    ["list_emails", null],
    ["get_email", null],
    ["get_email", "too_large"],
    ["get_email", "unavailable"],
  ] as const)(
    "projects an HTML-only %s body with %s fallback as safe readable text with honest preview status",
    async (toolName, fallbackReason) => {
      const html =
        '<p>Hello &amp; welcome, Avery &#128075;</p><p>Can we speak Thursday? <a href="https://cal.com/example/intro">Book time</a> or <a href="mailto:avery@example.test">email me</a>.</p><p><a href="https://example.test/job">https://example.test/job</a> <a href="javascript:unsafeLink()">Original label</a> <a href="data:text/html,unsafeData">Data label</a></p><div>Regards,<br>Avery</div><script>unsafeScript()</script><style>unsafeStyle{}</style>';
      const row = {
        ...email,
        body: { html },
        content_preview: "Short provider preview",
        body_fallback_reason: fallbackReason,
      };
      const { client, prisma, retained } = fixture({
        result: { structuredContent: { items: [row] } },
      });
      if (toolName === "get_email") {
        client.mcpServer.findMany.mockResolvedValueOnce([
          {
            id: "mail",
            name: "Instantly",
            endpoint: "https://mcp.instantly.ai/mcp",
            secretId: "encrypted-reference",
            revision: 1,
            enabled: true,
            assignments: [
              { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
            ],
          },
        ]);
        const detail = {
          ...retained,
          id: "detail",
          request: [
            "__rakazoCatalogTool",
            "direct",
            {
              route: { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName },
              args: { id: email.id },
            },
          ],
        };
        client.externalEffect.findMany
          .mockReset()
          .mockResolvedValueOnce([detail, retained])
          .mockResolvedValueOnce([
            { id: retained.id, result: { structuredContent: { items: [email] } } },
            { id: detail.id, result: { structuredContent: row } },
          ]);
      }
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(result.emails).toHaveLength(1);
      expect(result.emails[0]!.body).toContain("Hello & welcome, Avery 👋");
      expect(result.emails[0]!.body).toContain("Can we speak Thursday?");
      expect(result.emails[0]!.body).toContain("Book time (https://cal.com/example/intro)");
      expect(result.emails[0]!.body).toContain("email me (mailto:avery@example.test)");
      expect(result.emails[0]!.body.match(/https:\/\/example\.test\/job/g)).toHaveLength(1);
      expect(result.emails[0]!.body).not.toMatch(/javascript:|data:text|unsafeLink|unsafeData/);
      expect(result.emails[0]!.body).toContain("Regards,\nAvery");
      expect(result.emails[0]!.body).not.toMatch(
        /unsafeScript|unsafeStyle|<\/?(?:p|a|script|style)\b/,
      );
      expect(result.emails[0]!.snippet).toBe(toolName === "list_emails" || fallbackReason !== null);
      if (fallbackReason !== null) expect(result.partial).toBe(true);
      expect(row.body.html).toBe(html);
    },
  );
  it("prefers the original plain-text body over HTML and provider previews", async () => {
    const { prisma } = fixture({
      result: {
        structuredContent: {
          items: [
            {
              ...email,
              body: { ...email.body, html: "<p>Other HTML</p>" },
              content_preview: "Short preview",
            },
          ],
        },
      },
    });
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      emails: [{ body: email.body.text, snippet: true }],
    });
  });
  it("removes only the terminal provider truncation annotation from an Inbox preview", async () => {
    const annotation = "[truncated — use get_email for full content]";
    const candidateText = `Original candidate text, including ${annotation} in a quoted sentence.`;
    const body = `${candidateText}\n\n${annotation}\n`;
    const result = {
      structuredContent: {
        items: [{ ...email, body: { text: body } }],
        next_starting_after: "saved-next-page",
      },
    };
    const { prisma } = fixture({ result });
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      partial: true,
      emails: [{ body: `${candidateText}\n\n\n`, snippet: true }],
    });
    expect(result.structuredContent.items[0]!.body.text).toBe(body);
  });
  it("shows the latest selected campaign check without merging earlier variants or account-wide exploration", async () => {
    const { client, prisma, retained } = fixture();
    const variant = [
      "__rakazoCatalogTool",
      "direct",
      {
        ...(retained.request[2] as object),
        args: { campaign_id: email.campaign_id, email_type: "all", limit: 10 },
      },
    ];
    const global = [
      "__rakazoCatalogTool",
      "direct",
      {
        ...(retained.request[2] as object),
        args: { email_type: "all", limit: 100 },
      },
    ];
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([
        retained,
        { ...retained, id: "older-variant", request: variant },
        { ...retained, id: "global", request: global },
      ])
      .mockResolvedValueOnce([
        { id: retained.id, result: { structuredContent: { items: [email] } } },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      partial: false,
      emails: [{ subject: email.subject }],
    });
    // The unscoped read is this role's check too (its own query); the same-campaign variant is not.
    expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({
      in: [retained.id, "global"],
    });
  });
  it("presents an unscoped mailbox read made in the role thread as this role's check", async () => {
    const { client, prisma, retained } = fixture();
    retained.request[2] = {
      ...(retained.request[2] as object),
      args: { email_type: "all", limit: 100 },
    } as never;
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([retained])
      .mockResolvedValueOnce([
        { id: retained.id, result: { structuredContent: { items: [email] } } },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      checkedAt: retained.updatedAt.toISOString(),
      emails: [{ subject: email.subject }],
    });
  });
  it("projects remote-MCP reads whose route sits at request[3] with a display-name catalog id", async () => {
    // Prod 2026-10-23 15:32: list_emails ×2 + get_email through the remote Instantly MCP (catalog
    // form, args.id = tool display name, no campaign_id) → Inbox still said "Not checked yet".
    const { client, prisma, retained } = fixture();
    const route = {
      connectorId: "mcp",
      resourceId: "mail",
      resourceRevision: 1,
      toolName: "list_emails",
    };
    const remote = (
      id: string,
      toolName: string,
      args: Record<string, unknown>,
      updatedAt: string,
    ) => ({
      ...retained,
      id,
      updatedAt: new Date(updatedAt),
      request: [
        "__rakazoCatalogTool",
        "connectors_execute_tool",
        { id: `mcp__instantly__${toolName}`, arguments: args },
        { ...route, toolName },
      ],
    });
    const reply = {
      id: "a7f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      body: { text: "收到，谢谢。周四可以聊。", html: "<p>收到，谢谢。周四可以聊。</p>" },
      lead: "admin1@wekruit.com",
      step: null,
      subject: "Re: Founding Engineer",
      ue_type: 2,
      eaccount: "team@example.test",
      is_unread: true,
      thread_id: "thread-1",
      message_id: "<reply@wekruit.com>",
      campaign_id: email.campaign_id,
      timestamp_email: "2026-10-23T15:31:00Z",
      timestamp_created: "2026-10-23T15:31:05Z",
      from_address_email: "admin1@wekruit.com",
      to_address_email_list: "team@example.test",
      organization_id: email.organization_id,
    };
    const list1 = remote(
      "list-1",
      "list_emails",
      { email_type: "all", limit: 10 },
      "2026-10-23T15:32:43Z",
    );
    const list2 = remote(
      "list-2",
      "list_emails",
      { lead: reply.lead, limit: 10 },
      "2026-10-23T15:32:51Z",
    );
    const detail = remote("detail", "get_email", { id: reply.id }, "2026-10-23T15:32:54Z");
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [
          { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
        ],
      },
    ]);
    const preview = {
      ...reply,
      body: { text: "收到，谢谢。[truncated — use get_email for full content]" },
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([detail, list2, list1])
      .mockResolvedValueOnce([
        {
          id: list1.id,
          result: { structuredContent: { items: [preview], next_starting_after: null } },
        },
        {
          id: list2.id,
          result: { structuredContent: { items: [preview], next_starting_after: null } },
        },
        { id: detail.id, result: { structuredContent: reply } },
      ]);
    const output = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(output).toMatchObject({
      status: "ready",
      checkedAt: detail.updatedAt.toISOString(),
      emails: [
        {
          providerMessageId: reply.id,
          sender: "admin1@wekruit.com",
          subject: "Re: Founding Engineer",
          body: "收到，谢谢。周四可以聊。",
          snippet: false,
          date: reply.timestamp_email,
        },
      ],
    });
    expect(output.emails).toHaveLength(1);
  });
  it.each([false, true])(
    "keeps the latest cursor page partial when its output cursor is empty, including an empty last page: %s",
    async (empty) => {
      const { client, prisma, retained } = fixture();
      const lastEmail = {
        ...email,
        id: "11b17967-b2b4-432d-95ef-990d05596c03",
        subject: "Last page",
      };
      const lastRequest = [
        "__rakazoCatalogTool",
        "direct",
        {
          ...(retained.request[2] as object),
          args: {
            campaign_id: email.campaign_id,
            email_type: "received",
            limit: 2,
            starting_after: "next-page",
          },
        },
      ];
      const saved = [
        {
          id: "first-page",
          result: { structuredContent: { items: [email], next_starting_after: "next-page" } },
        },
        {
          id: retained.id,
          result: {
            structuredContent: { items: empty ? [] : [lastEmail], next_starting_after: null },
          },
        },
      ];
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([
          { ...retained, request: lastRequest },
          { ...retained, id: "first-page", updatedAt: new Date("2026-10-22T00:59:00Z") },
        ])
        .mockImplementationOnce(async ({ where }) =>
          saved.filter((row) => where.id.in.includes(row.id)),
        );
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(result).toMatchObject({
        status: empty ? "empty" : "ready",
        partial: true,
        emails: empty ? [] : [expect.objectContaining({ subject: lastEmail.subject })],
      });
      expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({
        in: [retained.id],
      });
    },
  );
  it.each([
    [{ items: [] }, "empty"],
    [{ items: "malformed" }, "unsupported"],
  ])(
    "keeps the latest selected campaign observation instead of resurrecting older filter variants: %j",
    async (body, status) => {
      const { client, prisma, retained } = fixture();
      const older = {
        ...retained,
        id: "older",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            ...(retained.request[2] as object),
            args: { campaign_id: email.campaign_id, email_type: "all", limit: 10 },
          },
        ],
      };
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([retained, older])
        .mockResolvedValueOnce([{ id: retained.id, result: { structuredContent: body } }]);
      expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
        status,
        emails: [],
      });
      expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({
        in: [retained.id],
      });
    },
  );
  it.each([true, false])(
    "keeps a non-campaign Unibox email (campaign_id null=%s, else absent) in the Inbox without inventing a campaign",
    async (nullCampaign) => {
      const { campaign_id: _campaign, ...direct } = email;
      const item = {
        ...direct,
        ...(nullCampaign ? { campaign_id: null } : {}),
        subject: "Direct reply",
      };
      const { prisma } = fixture({
        result: { structuredContent: { items: [item] } },
      });
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(result).toMatchObject({
        status: "ready",
        emails: [{ subject: "Direct reply", sender: email.from_address_email }],
      });
      expect(JSON.stringify(result)).not.toContain(email.campaign_id);
    },
  );
  it("does not display a returned message from a different campaign than the native scoped read", async () => {
    const { prisma } = fixture({
      result: {
        structuredContent: {
          items: [{ ...email, campaign_id: "d0843b17-c57a-4d9c-8fd5-434c0f708b63" }],
        },
      },
    });
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "unsupported",
      emails: [],
    });
  });
  it.each([
    [{ structuredContent: { items: [] } }, "empty"],
    [{ isError: true }, "failed"],
    [{ structuredContent: { items: "malformed" } }, "unsupported"],
  ])(
    "never revives old email details after the latest campaign check: %j",
    async (result, status) => {
      const { client, prisma, retained } = fixture();
      client.mcpServer.findMany.mockResolvedValueOnce([
        {
          id: "mail",
          name: "Instantly",
          endpoint: "https://mcp.instantly.ai/mcp",
          secretId: "encrypted-reference",
          revision: 1,
          enabled: true,
          assignments: [
            { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
          ],
        },
      ]);
      const detail = {
        ...retained,
        id: "old-detail",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: "mail",
              resourceRevision: 1,
              toolName: "get_email",
            },
            args: { id: email.id },
          },
        ],
      };
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([retained, detail])
        .mockResolvedValueOnce([
          { id: retained.id, result },
          { id: detail.id, result: { structuredContent: email } },
        ]);
      expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
        status,
        emails: [],
      });
    },
  );
  it.each([
    [{ structuredContent: { items: [] } }, "empty"],
    [{ isError: true }, "failed"],
    [{ structuredContent: { items: "malformed" } }, "unsupported"],
  ])("does not revive older unscoped mail after a campaign check: %j", async (result, status) => {
    const { client, prisma, retained } = fixture();
    const older = {
      ...retained,
      id: "older-unscoped",
      updatedAt: new Date("2026-10-21T01:00:00Z"),
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          ...(retained.request[2] as object),
          args: { email_type: "all", limit: 10 },
        },
      ],
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([retained, older])
      .mockResolvedValueOnce([
        { id: retained.id, result },
        { id: older.id, result: { structuredContent: { items: [email] } } },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status,
      emails: [],
    });
  });
  it("keeps a newer unscoped observation after an older empty campaign check", async () => {
    const { client, prisma, retained } = fixture();
    const newer = {
      ...retained,
      id: "newer-unscoped",
      updatedAt: new Date("2026-10-23T01:00:00Z"),
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          ...(retained.request[2] as object),
          args: { email_type: "all", limit: 10 },
        },
      ],
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([newer, retained])
      .mockResolvedValueOnce([
        { id: retained.id, result: { structuredContent: { items: [] } } },
        { id: newer.id, result: { structuredContent: { items: [email] } } },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      emails: [{ providerMessageId: email.id }],
    });
  });
  it("prefers a newer unscoped body over an older campaign snapshot of the same mail", async () => {
    const { client, prisma, retained } = fixture();
    const newer = {
      ...retained,
      id: "newer-unscoped",
      updatedAt: new Date("2026-10-23T01:00:00Z"),
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          ...(retained.request[2] as object),
          args: { email_type: "all", limit: 10 },
        },
      ],
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([newer, retained])
      .mockResolvedValueOnce([
        { id: retained.id, result: { structuredContent: { items: [email] } } },
        {
          id: newer.id,
          result: {
            structuredContent: { items: [{ ...email, body: { text: "Latest preview" } }] },
          },
        },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      emails: [{ body: "Latest preview" }],
    });
  });
  it("does not let an unrelated detail failure turn a checked-empty role snapshot into a failure", async () => {
    const { client, prisma, retained } = fixture();
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [
          { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
        ],
      },
    ]);
    const detail = {
      ...retained,
      id: "old-detail",
      updatedAt: new Date("2026-10-22T01:05:00Z"),
      status: "failed",
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "mail",
            resourceRevision: 1,
            toolName: "get_email",
          },
          args: { id: email.id },
        },
      ],
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([retained, detail])
      .mockResolvedValueOnce([
        { id: retained.id, result: { structuredContent: { items: [] } } },
        { id: detail.id, result: { isError: true } },
      ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "empty",
      partial: false,
      checkedAt: retained.updatedAt.toISOString(),
      emails: [],
    });
  });
  it.each([false, true])(
    "supplements a listed message only when detail campaign identity also matches: %s",
    async (differentCampaign) => {
      const { client, prisma, retained } = fixture();
      client.mcpServer.findMany.mockResolvedValueOnce([
        {
          id: "mail",
          name: "Instantly",
          endpoint: "https://mcp.instantly.ai/mcp",
          secretId: "encrypted-reference",
          revision: 1,
          enabled: true,
          assignments: [
            { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
          ],
        },
      ]);
      const detail = {
        ...retained,
        id: "detail",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: "mail",
              resourceRevision: 1,
              toolName: "get_email",
            },
            args: { id: email.id },
          },
        ],
      };
      const otherCampaignId = "d0843b17-c57a-4d9c-8fd5-434c0f708b63";
      const otherCampaign = {
        ...retained,
        id: "other-campaign",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            ...(retained.request[2] as object),
            args: { campaign_id: otherCampaignId, email_type: "received", limit: 10 },
          },
        ],
      };
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([detail, retained, ...(differentCampaign ? [otherCampaign] : [])])
        .mockResolvedValueOnce([
          { id: retained.id, result: { structuredContent: { items: [email] } } },
          {
            id: detail.id,
            result: {
              structuredContent: {
                ...email,
                campaign_id: differentCampaign ? otherCampaignId : email.campaign_id,
                body: { text: "Full saved detail" },
              },
            },
          },
          ...(differentCampaign
            ? [{ id: otherCampaign.id, result: { structuredContent: { items: [] } } }]
            : []),
        ]);
      const output = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(output).toMatchObject({
        status: "ready",
        partial: differentCampaign,
        emails: [
          {
            body: differentCampaign ? email.body.text : "Full saved detail",
            snippet: differentCampaign,
          },
        ],
      });
      expect(output.emails).toHaveLength(1);
    },
  );
  it("projects a candidate reply read through the native thread history in a specialist sub-run", async () => {
    // Live gap: the Outreach sub-run read the reply via native get_thread_history (no official
    // list_emails/get_email on this space) and the Inbox still said "Not checked yet".
    const { client, prisma, retained } = fixture();
    const reply = {
      ...email,
      id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
      campaign_id: null,
      thread_id: "thread-1",
      subject: "Re: Original subject",
      body: { text: "收到，谢谢。周四可以聊。" },
    };
    const history = {
      ...retained,
      id: "history",
      run: { botId: "outreach" },
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "mail",
            resourceRevision: 1,
            toolName: "native_instantly_get_thread_history",
          },
          args: { anchor_id: reply.id, limit: 100 },
        },
      ],
    };
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [
          { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
          { botId: "outreach", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
        ],
      },
    ]);
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([history])
      .mockResolvedValueOnce([
        {
          id: history.id,
          result: {
            structuredContent: {
              source: "local_native_instantly_rest",
              anchor: { structuredContent: reply },
              page: { items: [reply], next_starting_after: null },
              coverage: { scope: "exact_thread" },
            },
          },
        },
      ]);
    const output = await api.getRecruitingCorrespondence(
      prisma,
      actor,
      { ...target, memberBotIds: ["main", "outreach"] },
      "inbox",
    );
    expect(output).toMatchObject({
      status: "ready",
      partial: false,
      emails: [{ providerMessageId: reply.id, body: reply.body.text, snippet: false }],
    });
    expect(client.externalEffect.findMany.mock.calls[0]![0].where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([
            {
              request: {
                path: ["2", "route", "toolName"],
                equals: "native_instantly_get_thread_history",
              },
            },
          ]),
        }),
      ]),
    );
  });
  it("projects a standalone get_email read of a reply without a campaign list snapshot", async () => {
    const { client, prisma, retained } = fixture();
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [
          { botId: "main", allowAllTools: false, allowedTools: ["list_emails", "get_email"] },
        ],
      },
    ]);
    const detail = {
      ...retained,
      id: "detail",
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "mail",
            resourceRevision: 1,
            toolName: "get_email",
          },
          args: { id: email.id },
        },
      ],
    };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([detail])
      .mockResolvedValueOnce([{ id: detail.id, result: { structuredContent: email } }]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "ready",
      emails: [{ body: email.body.text, snippet: false }],
    });
  });
  it.each([{ enabled: false }, { permission: false }])(
    "does not fetch provider payloads after native permission is unavailable: %j",
    async (options) => {
      const { client, prisma } = fixture(options);
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(result.status).toBe("not_checked");
      expect(result.emails).toEqual([]);
      expect(client.externalEffect.findMany).not.toHaveBeenCalled();
    },
  );
  it("does not advertise a configured mailbox when only unrelated tools are assigned", async () => {
    const { client, prisma } = fixture();
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [{ botId: "main", allowAllTools: false, allowedTools: ["list_campaigns"] }],
      },
    ]);
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(result.connections).toEqual([
      { name: "Instantly", status: "needs_access", checkIssue: null },
    ]);
    expect(result.emails).toEqual([]);
    expect(client.externalEffect.findMany).not.toHaveBeenCalled();
  });
  it.each([
    [{ isError: false, structuredContent: { items: [] } }, "empty"],
    [{ isError: true, structuredContent: { items: [email] } }, "failed"],
    [
      { isError: false, structuredContent: { narrative: "an interview was booked" } },
      "unsupported",
    ],
  ])(
    "distinguishes checked-empty, provider failure and unsupported output",
    async (result, expected) => {
      const { prisma } = fixture({ result });
      const output = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
      expect(output.status).toBe(expected);
      expect(output.emails).toEqual([]);
    },
  );
  it("does not reuse a prior query result when the most recent identical read returned empty", async () => {
    const { client, prisma, retained } = fixture({
      result: { isError: false, structuredContent: { items: [] } },
    });
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([retained, { ...retained, id: "older" }])
      .mockResolvedValueOnce([
        { id: "effect", result: { isError: false, structuredContent: { items: [] } } },
        { id: "older", result: { isError: false, structuredContent: { items: [email] } } },
      ]);
    const output = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(output.status).toBe("empty");
    expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({ in: ["effect"] });
  });
  it("rejects a role switch while the saved receipts are being read", async () => {
    const { prisma } = fixture({ current: false });
    await expect(
      api.getRecruitingCorrespondence(prisma, actor, target, "inbox"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  async function gmailObservation(
    tool: string,
    args: Record<string, unknown>,
    body: unknown,
    previous?: { tool: string; args: Record<string, unknown>; body: unknown },
    failed = false,
    page?: { limit?: number; cursor?: string },
  ) {
    const { client, prisma, retained } = fixture();
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "gmail",
        name: "Gmail",
        endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [{ botId: "main", allowAllTools: true, allowedTools: [] }],
      },
    ]);
    const request = (toolName: string, args: Record<string, unknown>) => [
      "__rakazoCatalogTool",
      "direct",
      {
        route: { connectorId: "mcp", resourceId: "gmail", resourceRevision: 1, toolName },
        args,
      },
    ];
    const rows = [
      { ...retained, status: failed ? "failed" : retained.status, request: request(tool, args) },
    ];
    const results = [{ id: retained.id, result: { structuredContent: body } }];
    if (previous) {
      rows.push({
        ...retained,
        id: "older",
        request: request(previous.tool, previous.args),
        updatedAt: new Date("2026-10-21T00:00:00Z"),
      });
      results.push({ id: "older", result: { structuredContent: previous.body } });
    }
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(results);
    return api.getRecruitingCorrespondence(
      prisma,
      actor,
      target,
      "inbox",
      undefined,
      undefined,
      page,
    );
  }
  const gmailMessage = {
    id: "gmail-message",
    threadId: "gmail-thread",
    sender: "person@example.test",
    toRecipients: ["team@example.test"],
    subject: "Selected message",
    date: "2026-10-22T01:00:00Z",
    plaintextBody: "Provider plain text",
    snippet: "Provider preview",
    htmlBody: "<script>untrusted()</script>",
    viewUrl: "https://mail.google.com/mail/u/0/#all/gmail-message",
  };
  it("projects an explicitly selected Gmail message using the official camelCase plain-text schema", async () => {
    const result = await gmailObservation(
      "get_message",
      { messageId: gmailMessage.id, messageFormat: "PLAIN_TEXT" },
      gmailMessage,
    );
    expect(result).toMatchObject({
      status: "ready",
      partial: true,
      emails: [
        {
          id: "gmail:gmail-message",
          sender: gmailMessage.sender,
          recipients: gmailMessage.toRecipients,
          subject: gmailMessage.subject,
          date: gmailMessage.date,
          body: gmailMessage.plaintextBody,
          snippet: false,
          url: gmailMessage.viewUrl,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("untrusted()");
  });
  it("does not report a superseded Gmail check issue after the latest observation succeeds", async () => {
    const result = await gmailObservation(
      "get_message",
      { messageId: gmailMessage.id, messageFormat: "PLAIN_TEXT" },
      gmailMessage,
      {
        tool: "get_message",
        args: { messageId: gmailMessage.id, messageFormat: "FULL_CONTENT" },
        body: {},
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      partial: true,
      connections: [{ name: "Gmail", status: "configured", checkIssue: null }],
      emails: [{ body: gmailMessage.plaintextBody }],
    });
  });
  it("projects only messages from the exact selected Gmail thread, newest first", async () => {
    const result = await gmailObservation(
      "get_thread",
      { threadId: gmailMessage.threadId },
      {
        id: gmailMessage.threadId,
        messages: [gmailMessage, { ...gmailMessage, id: "second", subject: "Newest message" }],
      },
    );
    expect(result.status).toBe("ready");
    expect(result.emails.map((message) => message.subject)).toEqual([
      "Newest message",
      gmailMessage.subject,
    ]);
  });
  it.each([
    {},
    { threads: [{ id: "unselected", messages: [gmailMessage] }], nextPageToken: "next" },
  ])(
    "does not associate Gmail search discovery with the role or call undisplayed matches empty: %j",
    async (body) => {
      expect(await gmailObservation("search_threads", {}, body)).toMatchObject({
        status: "not_checked",
        partial: true,
        emails: [],
      });
    },
  );
  it.each([
    ["get_message", { messageId: "another-message" }, gmailMessage],
    [
      "get_thread",
      { threadId: "another-thread" },
      { id: gmailMessage.threadId, messages: [gmailMessage] },
    ],
    [
      "get_thread",
      { threadId: gmailMessage.threadId },
      { id: gmailMessage.threadId, messages: [{ ...gmailMessage, threadId: "another-thread" }] },
    ],
  ])("rejects a Gmail selected-read identity mismatch for %s", async (tool, args, body) => {
    expect(
      await gmailObservation(tool as string, args as Record<string, unknown>, body),
    ).toMatchObject({ status: "unsupported", emails: [] });
  });
  it.each([
    ["MINIMAL", gmailMessage],
    [
      "FULL_CONTENT",
      { id: gmailMessage.id, htmlBody: gmailMessage.htmlBody, snippet: gmailMessage.snippet },
    ],
  ])("keeps Gmail %s summaries or HTML-only bodies as previews", async (messageFormat, body) => {
    expect(
      await gmailObservation("get_message", { messageId: gmailMessage.id, messageFormat }, body),
    ).toMatchObject({
      status: "ready",
      emails: [{ body: gmailMessage.snippet, snippet: true }],
    });
  });
  it("bounds Gmail body display without claiming a truncated body is complete", async () => {
    const result = await gmailObservation(
      "get_message",
      { messageId: gmailMessage.id },
      { ...gmailMessage, plaintextBody: "a".repeat(50_001) },
    );
    expect(result.emails[0]?.body).toHaveLength(50_000);
    expect(result.emails[0]?.snippet).toBe(true);
  });
  it("keeps missing Gmail metadata unknown and bounds selected thread display", async () => {
    const metadata = await gmailObservation(
      "get_message",
      {
        messageId: gmailMessage.id,
        messageFormat: "METADATA_ONLY",
      },
      { id: gmailMessage.id },
    );
    expect(metadata.emails).toEqual([
      {
        id: "gmail:gmail-message",
        sourceName: "Gmail",
        sourceId: "gmail",
        providerMessageId: "gmail-message",
        savedRead: null,
        sender: null,
        recipients: [],
        subject: "",
        body: "",
        snippet: true,
        date: null,
        url: null,
      },
    ]);
    const thread = await gmailObservation(
      "get_thread",
      { threadId: gmailMessage.threadId },
      {
        id: gmailMessage.threadId,
        messages: Array.from({ length: 51 }, (_, index) => ({
          ...gmailMessage,
          id: `message-${index}`,
        })),
      },
    );
    expect(thread.emails).toHaveLength(50);
    expect(thread.partial).toBe(true);
    expect(thread.nextCursor).toBe("50");
  });
  it("pages inbox emails by opaque cursor without overlap or skips", async () => {
    const body = {
      id: gmailMessage.threadId,
      messages: Array.from({ length: 5 }, (_, index) => ({ ...gmailMessage, id: `m-${index}` })),
    };
    const read = (page: { limit?: number; cursor?: string }) =>
      gmailObservation(
        "get_thread",
        { threadId: gmailMessage.threadId },
        body,
        undefined,
        false,
        page,
      );
    const ids = (page: { emails: Array<{ providerMessageId: string }> }) =>
      page.emails.map((email) => email.providerMessageId);
    const first = await read({ limit: 2 });
    expect(ids(first)).toEqual(["m-4", "m-3"]);
    expect(first.nextCursor).toBe("2");
    const second = await read({ limit: 2, cursor: first.nextCursor! });
    expect(ids(second)).toEqual(["m-2", "m-1"]);
    expect(second.nextCursor).toBe("4");
    const last = await read({ limit: 2, cursor: second.nextCursor! });
    expect(ids(last)).toEqual(["m-0"]);
    expect(last).toMatchObject({ nextCursor: null, status: "ready" });
    expect(ids(await read({}))).toEqual(["m-4", "m-3", "m-2", "m-1", "m-0"]);
  });
  it.each([
    { ...gmailMessage, date: "not-a-date" },
    { ...gmailMessage, toRecipients: "not-an-array" },
  ])(
    "rejects malformed Gmail display fields without exposing an unvalidated record",
    async (body) => {
      expect(
        await gmailObservation("get_message", { messageId: gmailMessage.id }, body),
      ).toMatchObject({ status: "unsupported", emails: [] });
    },
  );
  it("does not replace a newer selected Gmail preview with an older thread body", async () => {
    const result = await gmailObservation(
      "get_message",
      { messageId: gmailMessage.id, messageFormat: "MINIMAL" },
      {
        ...gmailMessage,
        snippet: "Latest preview",
      },
      {
        tool: "get_thread",
        args: { threadId: gmailMessage.threadId },
        body: { id: gmailMessage.threadId, messages: [gmailMessage] },
      },
    );
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]).toMatchObject({ body: "Latest preview", snippet: true });
  });
  it("does not revive older Gmail full content after a newer selected format failed validation", async () => {
    expect(
      await gmailObservation(
        "get_message",
        { messageId: gmailMessage.id, messageFormat: "MINIMAL" },
        {},
        {
          tool: "get_message",
          args: { messageId: gmailMessage.id, messageFormat: "FULL_CONTENT" },
          body: gmailMessage,
        },
      ),
    ).toMatchObject({ status: "unsupported", emails: [] });
  });
  it.each([false, true])(
    "does not revive an older Gmail thread body after a newer selected message is invalid or failed: %s",
    async (failed) => {
      expect(
        await gmailObservation(
          "get_message",
          { messageId: gmailMessage.id },
          failed ? gmailMessage : { ...gmailMessage, date: "not-a-date" },
          {
            tool: "get_thread",
            args: { threadId: gmailMessage.threadId },
            body: { id: gmailMessage.threadId, messages: [gmailMessage] },
          },
          failed,
        ),
      ).toMatchObject({ status: failed ? "failed" : "unsupported", emails: [] });
    },
  );
  it.each([false, true])(
    "does not revive an older Gmail message after its selected thread is invalid or failed: %s",
    async (failed) => {
      expect(
        await gmailObservation(
          "get_thread",
          { threadId: gmailMessage.threadId },
          { id: gmailMessage.threadId, messages: failed ? [gmailMessage] : "not-an-array" },
          {
            tool: "get_message",
            args: { messageId: gmailMessage.id },
            body: gmailMessage,
          },
          failed,
        ),
      ).toMatchObject({ status: failed ? "failed" : "unsupported", emails: [] });
    },
  );
  it.each([false, true, undefined])(
    "projects the observed Cal text-only empty result without assuming pagination: %s",
    async (hasNextPage) => {
      const { client, prisma, retained } = fixture();
      client.mcpServer.findMany.mockResolvedValueOnce([
        {
          id: "mail",
          name: "Cal.com",
          endpoint: "https://mcp.cal.com/mcp",
          secretId: "encrypted-reference",
          revision: 2,
          enabled: true,
          assignments: [{ botId: "main", allowAllTools: false, allowedTools: ["get_bookings"] }],
        },
      ]);
      const request = [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "mail",
            resourceRevision: 2,
            toolName: "get_bookings",
          },
          args: { status: "upcoming", take: 10 },
        },
      ];
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([{ ...retained, request }])
        .mockResolvedValueOnce([
          {
            id: "effect",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "success",
                    data: [],
                    pagination: { hasNextPage },
                  }),
                },
              ],
            },
          },
        ]);
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "interview");
      expect(result).toMatchObject({
        status: "empty",
        checkedAt: retained.updatedAt.toISOString(),
        events: [],
        partial: hasNextPage !== false,
        connections: [{ name: "Cal.com", status: "configured" }],
      });
    },
  );
  async function calObservation(
    tool: string,
    args: Record<string, unknown>,
    body: unknown,
    previous?: { args: Record<string, unknown>; body: unknown },
  ) {
    const { client, prisma, retained } = fixture();
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "calendar",
        name: "Cal.com",
        endpoint: "https://mcp.cal.com/mcp",
        secretId: "encrypted-reference",
        revision: 2,
        enabled: true,
        assignments: [{ botId: "main", allowAllTools: false, allowedTools: [tool] }],
      },
    ]);
    const request = (args: Record<string, unknown>) => [
      "__rakazoCatalogTool",
      "direct",
      {
        route: { connectorId: "mcp", resourceId: "calendar", resourceRevision: 2, toolName: tool },
        args,
      },
    ];
    const retainedRows = [{ ...retained, request: request(args) }];
    const resultRows = [
      { id: "effect", result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
    ];
    if (previous) {
      retainedRows.push({
        ...retained,
        id: "older",
        updatedAt: new Date("2026-10-21T00:00:00Z"),
        request: request(previous.args),
      });
      resultRows.push({
        id: "older",
        result: { content: [{ type: "text", text: JSON.stringify(previous.body) }] },
      });
    }
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce(retainedRows)
      .mockResolvedValueOnce(resultRows);
    return api.getRecruitingCorrespondence(prisma, actor, target, "interview");
  }
  it("replaces an earlier availability window with the latest empty observation for that event type", async () => {
    const result = await calObservation(
      "get_availability",
      { eventTypeId: 42, start: "2026-10-23", timeZone: "UTC" },
      { status: "success", data: {} },
      {
        args: {
          eventTypeId: 42,
          start: "2026-10-22",
          timeZone: "America/Los_Angeles",
          format: "range",
        },
        body: {
          status: "success",
          data: { "2026-10-23": [{ start: "2026-10-23T13:00:00Z", end: "2026-10-23T13:30:00Z" }] },
        },
      },
    );
    expect(result).toMatchObject({ status: "empty", events: [], partial: false });
  });
  it("keeps distinct rescheduling subjects separate", async () => {
    const result = await calObservation(
      "get_availability",
      { eventTypeId: 42, bookingUidToReschedule: "one" },
      { status: "success", data: {} },
      {
        args: { eventTypeId: 42, bookingUidToReschedule: "two" },
        body: {
          status: "success",
          data: { "2026-10-23": [{ start: "2026-10-23T13:00:00Z", end: "2026-10-23T13:30:00Z" }] },
        },
      },
    );
    expect(result.events).toHaveLength(1);
  });
  it("projects native Cal range availability without implying reservations or inventing participants", async () => {
    const result = await calObservation(
      "get_availability",
      { timeZone: "America/Los_Angeles", eventTypeId: 42, format: "range" },
      {
        status: "success",
        data: {
          "2026-10-23": [
            { start: "2026-10-23T06:00:00.000-07:00", end: "2026-10-23T06:30:00.000-07:00" },
            { start: "2026-10-23T06:00:00.000-07:00", end: "2026-10-23T06:30:00.000-07:00" },
          ],
        },
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      events: [
        {
          kind: "availability",
          start: "2026-10-23T06:00:00.000-07:00",
          end: "2026-10-23T06:30:00.000-07:00",
          timeZone: "America/Los_Angeles",
          status: null,
          attendees: [],
          location: null,
          url: null,
        },
      ],
    });
    expect(result.events).toHaveLength(1);
  });
  it("preserves native start-only Cal slots without inventing an end time", async () => {
    const result = await calObservation(
      "get_availability",
      {},
      {
        status: "success",
        data: { "2026-10-23": ["2026-10-23T13:00:00Z", { start: "2026-10-23T14:00:00Z" }] },
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      events: [
        { kind: "availability", start: "2026-10-23T13:00:00Z", end: null, timeZone: "UTC" },
        { kind: "availability", start: "2026-10-23T14:00:00Z", end: null, timeZone: "UTC" },
      ],
    });
  });
  it("retains valid slots and marks malformed Cal rows incomplete", async () => {
    const result = await calObservation(
      "get_availability",
      { timeZone: "UTC" },
      {
        status: "success",
        data: {
          "2026-10-23": [
            { start: "2026-10-23T13:00:00Z", end: "2026-10-23T13:30:00Z" },
            { start: "tomorrow", end: "later" },
            { start: "2026-10-23T14:00:00Z", end: "2026-10-23T13:00:00Z" },
          ],
          "2026-10-24": { unexpected: true },
        },
      },
    );
    expect(result.status).toBe("ready");
    expect(result.partial).toBe(true);
    expect(result.events).toHaveLength(1);
  });
  it("projects a native Cal booking without inventing its role association", async () => {
    const result = await calObservation(
      "get_booking",
      { bookingUid: "booking-one" },
      {
        status: "success",
        data: {
          uid: "booking-one",
          title: "Recruiting interview",
          status: "accepted",
          start: "2026-10-23T13:00:00Z",
          end: "2026-10-23T13:30:00Z",
          attendees: [{ email: "person@example.test" }],
          location: "https://meet.example.test/interview",
          privateNotes: "never displayed",
        },
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      events: [
        {
          kind: "event",
          title: "Recruiting interview",
          start: "2026-10-23T13:00:00Z",
          end: "2026-10-23T13:30:00Z",
          attendees: ["person@example.test"],
          status: "accepted",
          location: "https://meet.example.test/interview",
          url: "https://meet.example.test/interview",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("never displayed");
  });
  it("does not claim a complete Cal booking page when earlier pages were skipped", async () => {
    const result = await calObservation(
      "get_bookings",
      { skip: 10 },
      { status: "success", data: [], pagination: { hasNextPage: false } },
    );
    expect(result).toMatchObject({ status: "empty", partial: true, events: [] });
  });
  it.each(["https://mcp.instantly.ai/mcp", "https://custom.example.test/mcp"])(
    "does not reinterpret an earlier connection receipt after configuration changes: %s",
    async (endpoint) => {
      const { client, prisma } = fixture();
      client.mcpServer.findMany.mockResolvedValueOnce([
        {
          id: "mail",
          name: "Changed connection",
          endpoint,
          secretId: "encrypted-reference",
          revision: 2,
          enabled: true,
          assignments: [{ botId: "main", allowAllTools: false, allowedTools: ["list_emails"] }],
        },
      ]);
      expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
        status: "unsupported",
        connectionChanged: true,
        emails: [],
      });
      expect(client.externalEffect.findMany).toHaveBeenCalledTimes(1);
      expect(client.externalEffect.findMany.mock.calls[0]![0].where.OR).toContainEqual({
        AND: [
          { request: { path: ["2", "route", "resourceId"], equals: "mail" } },
          { request: { path: ["2", "route", "toolName"], equals: "list_emails" } },
        ],
      });
    },
  );
  function contactFixture(body: unknown) {
    const state = fixture();
    const request = [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: "mail",
          resourceRevision: 1,
          toolName: "get_enrichment_results",
        },
        args: { enrichment_id: "saved-job" },
      },
    ];
    const client = Object.assign(state.client, {
      recruitingCandidate: {
        findMany: vi.fn().mockResolvedValue([{ candidateKey: "linkedin:/in/saved-person" }]),
      },
    });
    client.mcpServer.findMany.mockResolvedValueOnce([
      {
        id: "mail",
        name: "FullEnrich",
        endpoint: "https://mcp.fullenrich.com/mcp",
        secretId: "encrypted-reference",
        revision: 1,
        enabled: true,
        assignments: [
          { botId: "main", allowAllTools: false, allowedTools: ["get_enrichment_results"] },
        ],
      },
    ]);
    const retained = { ...state.retained, request };
    const result = { content: [{ type: "text", text: JSON.stringify(body) }] };
    client.externalEffect.findMany
      .mockReset()
      .mockResolvedValueOnce([retained])
      .mockResolvedValueOnce([{ id: "effect", result }]);
    return { ...state, client, retained, result };
  }
  const contactRow = {
    input: { professional_network_url: "https://www.linkedin.com/in/saved-person/" },
    profile: {
      full_name: "Never join by this name",
      description: "private profile payload",
      social_profiles: { professional_network: { url: "https://linkedin.com/in/Saved-Person" } },
    },
    contact_info: {
      most_probable_work_email: { email: "person@example.test", status: "HIGH_PROBABILITY" },
      most_probable_phone: null,
      work_emails: [{ email: "person@example.test", status: "HIGH_PROBABILITY" }],
    },
  };
  it("recognizes exact platform FullEnrich readiness without exposing a credential or inventing a personal connection", async () => {
    vi.stubEnv("FULLENRICH_API_KEY", "platform-service-key");
    try {
      const { client, prisma } = contactFixture({ status: "FINISHED", results: [contactRow] });
      client.mcpServer.findMany.mockReset().mockResolvedValue([
        {
          id: "mail",
          name: "FullEnrich",
          endpoint: "https://mcp.fullenrich.com/mcp",
          transport: "streamable_http",
          secretId: null,
          revision: 1,
          enabled: true,
          assignments: [
            { botId: "main", allowAllTools: false, allowedTools: ["get_enrichment_results"] },
          ],
        },
      ]);
      const result = await api.getRecruitingCorrespondence(prisma, actor, target, "contacts");
      expect(result.connections).toEqual([
        { name: "FullEnrich", status: "configured", checkIssue: null },
      ]);
      expect(JSON.stringify(result)).not.toContain("platform-service-key");
      vi.stubEnv("FULLENRICH_API_KEY", " ");
      client.externalEffect.findMany.mockResolvedValue([]);
      expect(
        (await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).connections,
      ).toEqual([{ name: "FullEnrich", status: "needs_connection", checkIssue: null }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    { endpoint: "https://mcp.fullenrich.com/mcp?redirect=other", transport: "streamable_http" },
    { endpoint: "https://mcp.fullenrich.com/mcp", transport: "stdio" },
  ])(
    "does not advertise deployment credentials for another endpoint or transport: %s",
    async (connection) => {
      vi.stubEnv("FULLENRICH_API_KEY", "platform-service-key");
      try {
        const { client, prisma } = contactFixture({ status: "FINISHED", results: [contactRow] });
        client.mcpServer.findMany.mockReset().mockResolvedValue([
          {
            id: "mail",
            name: "FullEnrich",
            ...connection,
            secretId: null,
            revision: 1,
            enabled: true,
            assignments: [
              { botId: "main", allowAllTools: false, allowedTools: ["get_enrichment_results"] },
            ],
          },
        ]);
        expect(
          (await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).connections,
        ).toEqual([{ name: "FullEnrich", status: "needs_connection", checkIssue: null }]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it("projects the actual FullEnrich text result only for the canonical current-role identity, preserving provider uncertainty", async () => {
    const { client, prisma } = contactFixture({ status: "FINISHED", results: [contactRow] });
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "contacts");
    expect(result).toMatchObject({
      status: "ready",
      contacts: [
        {
          candidateKey: "linkedin:/in/saved-person",
          emails: [{ address: "person@example.test", status: "HIGH_PROBABILITY" }],
          phones: [],
          source: "FullEnrich",
          checkedAt: "2026-10-22T01:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/saved-job|private profile|Never join|VERIFIED/);
    expect(client.recruitingCandidate.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", role: { spaceId: "space", userId: "owner" } },
      select: { candidateKey: true },
    });
  });
  it("does not join a provider contact to another role or match by name", async () => {
    const { client, prisma } = contactFixture({ status: "FINISHED", results: [contactRow] });
    client.recruitingCandidate.findMany.mockResolvedValueOnce([
      { candidateKey: "linkedin:/in/another-person" },
    ]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).toMatchObject({
      status: "empty",
      contacts: [],
    });
  });
  it("rejects conflicting provider input and returned profile identities", async () => {
    const { prisma } = contactFixture({
      status: "FINISHED",
      results: [
        {
          ...contactRow,
          profile: {
            social_profiles: {
              professional_network: { url: "https://www.linkedin.com/in/another-person" },
            },
          },
        },
      ],
    });
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).toMatchObject({
      status: "unsupported",
      partial: true,
      contacts: [],
    });
  });
  it.each([
    [{ status: "in_progress", progress: { total: 1 } }, "not_checked"],
    [{ status: "FINISHED", results: "malformed" }, "unsupported"],
    [{ status: "FINISHED", results: [] }, "empty"],
  ])(
    "does not revive an older completed same-job contact after a newer observation: %j",
    async (body, status) => {
      const { client, prisma, retained, result } = contactFixture(body);
      client.externalEffect.findMany
        .mockReset()
        .mockResolvedValueOnce([retained, { ...retained, id: "older" }])
        .mockResolvedValueOnce([{ id: "effect", result }]);
      expect(
        await api.getRecruitingCorrespondence(prisma, actor, target, "contacts"),
      ).toMatchObject({
        status,
        contacts: [],
      });
      expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({ in: ["effect"] });
    },
  );
  it("rejects malformed returned email addresses without exposing the raw result", async () => {
    const { prisma } = contactFixture({
      status: "FINISHED",
      results: [
        {
          ...contactRow,
          contact_info: {
            most_probable_work_email: null,
            work_emails: [{ email: "not-an-address", status: "HIGH_PROBABILITY" }],
          },
        },
      ],
    });
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).toMatchObject({
      status: "unsupported",
      partial: true,
      contacts: [],
    });
  });
});

it("reads feedback through the owned role boundary and rejects unauthenticated requests", async () => {
  const client = createRouterClient(createRouter({ prisma } as RouterDeps), { context: { actor } });
  vi.mocked(db.listRecruitingFeedback).mockResolvedValueOnce({ feedback: [], nextCursor: null });
  expect(
    await client.recruiting.listFeedback({ roleId: "role", candidateKey: "candidate", limit: 5 }),
  ).toEqual({ feedback: [], nextCursor: null });
  expect(db.listRecruitingFeedback).toHaveBeenCalledWith(prisma, actor, {
    roleId: "role",
    candidateKey: "candidate",
    limit: 5,
  });
  const unauthenticated = createRouterClient(createRouter({ prisma } as RouterDeps), {
    context: { actor: null },
  });
  await expect(unauthenticated.recruiting.listFeedback({ roleId: "role" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

describe("readable recruiting sources", () => {
  const text = "Original 🧭 candidate evidence\nSecond line";
  const quote = "🧭 candidate evidence";
  const bytes = Buffer.from(
    JSON.stringify({ request: { internalId: "hidden-routing" }, text, nested: { evidence: text } }),
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const source = {
    id: "source",
    kind: "original_material" as const,
    anchor: {
      kind: "artifact" as const,
      artifact: { artifactId: "material", sha256: hash },
      locator: "text",
    },
    readState: "read" as const,
    readAt: "2026-09-01T00:00:00.000Z",
    quote,
  };
  const roleInput = {
    kind: "role" as const,
    threadId: "thread",
    roleRevisionId: "revision",
    sourceRefId: "source",
  };
  function fixture(content = bytes, mimeType = "application/json") {
    const contentHash = createHash("sha256").update(content).digest("hex");
    const savedSource = {
      ...source,
      anchor: { ...source.anchor, artifact: { artifactId: "material", sha256: contentHash } },
    };
    const get = vi.fn(async () => content);
    const findFirst = vi.fn(async () => ({
      id: "material",
      spaceId: actor.spaceId,
      userId: actor.userId,
      storageKey: "stored",
      botId: "bot",
      mimeType,
      size: content.length,
      hash: contentHash,
    }));
    const deps = {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    };
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
      revision: { id: "revision", sourceRefs: [savedSource], criteria: [] },
    } as never);
    return { deps, get, findFirst, source: savedSource };
  }
  it("reads only a persisted source string and exact highlight without returning its raw wrapper", async () => {
    const f = fixture();
    const value = await api.readRecruitingSource(f.deps, actor, roleInput);
    expect(value).toEqual({
      kind: "text",
      text,
      start: text.indexOf(quote),
      end: text.indexOf(quote) + quote.length,
    });
    expect(JSON.stringify(value)).not.toMatch(
      /hidden-routing|contentBase64|artifactId|sha256|storageKey/,
    );
    expect(db.getRecruitingWorkspace).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      threadId: "thread",
    });
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "material", spaceId: actor.spaceId, userId: actor.userId },
    });
  });
  it("loads the exact stored assessment selection, not a caller-controlled JSON path", async () => {
    const f = fixture();
    const start = text.indexOf(quote);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            ...source,
            kind: "original_material",
            selection: {
              kind: "artifact_json_string",
              path: ["nested", "evidence"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    } as never);
    const input = {
      kind: "assessment" as const,
      roleId: "role",
      candidateKey: "candidate",
      version: 2,
      sourceRefId: "source",
    };
    expect(await api.readRecruitingSource(f.deps, actor, input)).toEqual({
      kind: "text",
      text,
      start,
      end: start + quote.length,
    });
    expect(db.getRecruitingAssessment).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKey: "candidate",
      version: 2,
    });
  });
  it("rejects missing, conflicting, unread or revised stored references before reading bytes", async () => {
    const f = fixture();
    for (const revision of [
      { id: "another-revision", sourceRefs: [source], criteria: [] },
      { id: "revision", sourceRefs: [], criteria: [] },
      {
        id: "revision",
        sourceRefs: [{ ...source, readState: "unread", quote: undefined }],
        criteria: [],
      },
      {
        id: "revision",
        sourceRefs: [source],
        criteria: [{ sourceRefs: [{ ...source, quote: "Second line" }] }],
      },
    ]) {
      vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce({ revision } as never);
      await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(f.get).not.toHaveBeenCalled();
  });
  it("fails closed on changed original bytes or source hashes and sanitizes storage errors", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(Buffer.from("changed"));
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce({
      revision: {
        id: "revision",
        sourceRefs: [
          {
            ...source,
            anchor: {
              ...source.anchor,
              artifact: { ...source.anchor.artifact, sha256: "0".repeat(64) },
            },
          },
        ],
        criteria: [],
      },
    } as never);
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    f.get.mockRejectedValueOnce(new Error("private storage path"));
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
  });

  it("keeps native RPC authorization and refuses client-provided source extraction fields", async () => {
    const f = fixture();
    const client = createRouterClient(createRouter(f.deps as RouterDeps), { context: { actor } });
    for (const extra of [
      { path: ["request", "internalId"] },
      { quote: "hidden-routing" },
      { artifactId: "other" },
      { sha256: hash },
    ])
      await expect(
        client.recruiting.readSource({ ...roleInput, ...extra } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unauthenticated = createRouterClient(createRouter(f.deps as RouterDeps), { context: {} });
    await expect(unauthenticated.recruiting.readSource(roleInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    vi.mocked(db.getRecruitingWorkspace).mockRejectedValueOnce(new IsolationError("Private role"));
    await expect(client.recruiting.readSource(roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  describe("original PDF evidence (mocked storage and processor)", () => {
    const pdf = Buffer.from("%PDF-1.7\nsynthetic original bytes");
    beforeEach(() => vi.mocked(extractPdfText).mockReset().mockResolvedValue(text));

    it("reads a saved role quote and assessment UTF-16 selection from the same extracted text", async () => {
      const f = fixture(pdf, "application/pdf");
      const start = text.indexOf(quote);
      const expected = { kind: "text", text, start, end: start + quote.length };
      expect(await api.readRecruitingSource(f.deps, actor, roleInput)).toEqual(expected);
      vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
        assessment: {
          version: 2,
          sourceRefs: [
            {
              ...f.source,
              selection: { kind: "artifact_text", start, end: start + quote.length },
            },
          ],
        },
      } as never);
      expect(
        await api.readRecruitingSource(f.deps, actor, {
          kind: "assessment",
          roleId: "role",
          candidateKey: "candidate",
          version: 2,
          sourceRefId: "source",
        }),
      ).toEqual(expected);
      expect(extractPdfText).toHaveBeenCalledTimes(2);
      expect(extractPdfText).toHaveBeenLastCalledWith(pdf);
    });

    it.each(["foreign", "hash", "bytes", "json-selection", "message-selection"])(
      "rejects %s before invoking the PDF processor",
      async (boundary) => {
        const f = fixture(pdf, "application/pdf");
        if (boundary === "foreign") f.findFirst.mockResolvedValueOnce(null as never);
        if (boundary === "bytes") f.get.mockResolvedValueOnce(Buffer.from("changed"));
        const saved = {
          ...f.source,
          ...(boundary === "hash"
            ? { anchor: { ...f.source.anchor, artifact: { artifactId: "material", sha256: hash } } }
            : {}),
          ...(boundary === "json-selection"
            ? { selection: { kind: "artifact_json_string", path: ["text"], start: 0, end: 1 } }
            : {}),
          ...(boundary === "message-selection"
            ? { selection: { kind: "message_text", blockIndex: 0, start: 0, end: 1 } }
            : {}),
        };
        vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
          revision: { id: "revision", sourceRefs: [saved], criteria: [] },
        } as never);
        await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found",
        });
        expect(extractPdfText).not.toHaveBeenCalled();
        if (boundary === "foreign") expect(f.get).not.toHaveBeenCalled();
      },
    );

    it.each(["quote", "offset", "processor"])(
      "fails closed on a PDF %s error without returning raw bytes or processor details",
      async (boundary) => {
        const f = fixture(pdf, "application/pdf");
        const start = text.indexOf(quote);
        vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
          revision: {
            id: "revision",
            sourceRefs: [
              {
                ...f.source,
                quote: boundary === "quote" ? "Invented evidence" : quote,
                selection: {
                  kind: "artifact_text",
                  start: boundary === "offset" ? start + 1 : start,
                  end: start + quote.length,
                },
              },
            ],
            criteria: [],
          },
        } as never);
        if (boundary === "processor")
          vi.mocked(extractPdfText).mockRejectedValueOnce(new Error("private processor path"));
        await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found",
        });
        expect(extractPdfText).toHaveBeenCalledOnce();
      },
    );
  });
});

describe("authenticated recruiting API", () => {
  it("forwards native RPC inputs and trusted actors to the one shared domain implementation", async () => {
    for (const [domain, wrapper] of [
      [db.createRecruitingRole, api.createRecruitingRole],
      [db.bindRecruitingRole, api.bindRecruitingRole],
      [db.getRecruitingWorkspace, api.getRecruitingWorkspace],
      [db.reviseRecruitingRole, api.reviseRecruitingRole],
      [db.listRecruitingAssessments, api.listRecruitingAssessments],
      [db.getRecruitingAssessment, api.getRecruitingAssessment],
      [db.listRecruitingResearch, api.listRecruitingResearch],
      [db.listRecruitingCandidates, api.listRecruitingCandidates],
      [db.setRecruitingCandidateShortlist, api.setRecruitingCandidateShortlist],
    ] as const) {
      const output = {
        synthetic: true,
        ...(domain === db.listRecruitingCandidates ? { items: [] } : {}),
      };
      vi.mocked(domain).mockResolvedValueOnce(output as never);
      const input = { roleId: "role", threadId: "thread" } as never;
      const deps = domain === db.listRecruitingCandidates ? { prisma, artifacts: {} } : prisma;
      expect(await wrapper(deps as never, actor, input)).toEqual(output);
      expect(domain).toHaveBeenLastCalledWith(
        ...(domain === db.createRecruitingRole || domain === db.reviseRecruitingRole
          ? [prisma, actor, input, undefined]
          : [prisma, actor, input]),
      );
    }
  });
  it("maps missing scoped resources to a generic not-found response", async () => {
    vi.mocked(db.getRecruitingWorkspace).mockRejectedValueOnce(
      new IsolationError("Private title and text"),
    );
    await expect(
      api.getRecruitingWorkspace(prisma, actor, { threadId: "other-thread" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });
  it("maps authorized quote errors to actionable BAD_REQUEST without exposing material", async () => {
    const error = new RecruitingSourceValidationError("jd", "text");
    for (const [domain, wrapper] of [
      [db.createRecruitingRole, api.createRecruitingRole],
      [db.reviseRecruitingRole, api.reviseRecruitingRole],
    ] as const) {
      vi.mocked(domain).mockRejectedValueOnce(error);
      const response = await wrapper(prisma, actor, {} as never).catch((error: unknown) => error);
      expect(response).toMatchObject({ code: "BAD_REQUEST", message: error.message });
      expect(JSON.parse(JSON.stringify(response))).toMatchObject({
        code: "BAD_REQUEST",
        message:
          'Source "jd" at "text": quote must be exact contiguous text from the original read receipt; copy one unchanged excerpt without omissions or joined passages.',
      });
      vi.mocked(domain).mockRejectedValueOnce(new IsolationError("Private source details"));
      await expect(wrapper(prisma, actor, {} as never)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
    }
  });
  it("maps CAS conflicts to CONFLICT and validation failures without echoing input", async () => {
    vi.mocked(db.reviseRecruitingRole).mockRejectedValueOnce(new RecruitingConflictError());
    await expect(api.reviseRecruitingRole(prisma, actor, {} as never)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const error = new Error("Private submitted source");
    error.name = "ZodError";
    vi.mocked(db.createRecruitingRole).mockRejectedValueOnce(error);
    await expect(api.createRecruitingRole(prisma, actor, {} as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid recruiting input",
    });
  });
});

describe("native recruiting RPC", () => {
  it.each([false, true])(
    "signals a saved recruiting change only after its native mutation commits, failure=%s",
    async (failed) => {
      const event = { findFirst: vi.fn(async () => ({ seq: 17 })) };
      const notify = vi.fn(async () => {});
      const storage = { ...prisma, event } as unknown as PrismaClient;
      const client = createRouterClient(
        createRouter({ prisma: storage, events: { notify } } as unknown as RouterDeps),
        { context: { actor } },
      );
      const saved = { roleId: "role", candidateKey: "candidate", shortlisted: true, revision: 1 };
      let finish!: () => void;
      vi.mocked(db.setRecruitingCandidateShortlist).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () => (failed ? reject(new IsolationError()) : resolve(saved));
          }),
      );
      const saving = client.recruiting.setCandidateShortlist({
        threadId: "thread",
        roleId: "role",
        candidateKey: "candidate",
        expectedRevision: 0,
        shortlisted: true,
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(event.findFirst).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      finish();
      if (failed) {
        await expect(saving).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(event.findFirst).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      } else {
        expect(await saving).toEqual(saved);
        expect(event.findFirst).toHaveBeenCalledExactlyOnceWith({
          where: {
            spaceId: actor.spaceId,
            threadId: "thread",
            type: "recruiting.changed",
            thread: { userId: actor.userId, spaceId: actor.spaceId },
          },
          select: { seq: true },
          orderBy: { seq: "desc" },
        });
        expect(notify).toHaveBeenCalledExactlyOnceWith("thread", 17);
      }
    },
  );
  it("runs the existing router through shared storage with its authenticated actor", async () => {
    const client = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce(null);
    expect(await client.recruiting.getWorkspace({ threadId: "thread" })).toBeNull();
    expect(db.getRecruitingWorkspace).toHaveBeenLastCalledWith(prisma, actor, {
      threadId: "thread",
    });
    vi.mocked(db.bindRecruitingRole).mockResolvedValueOnce(null);
    expect(await client.recruiting.bindRole({ threadId: "thread", roleId: null })).toBeNull();
    expect(db.bindRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, {
      threadId: "thread",
      roleId: null,
    });
    vi.mocked(db.listRecruitingAssessments).mockResolvedValueOnce([]);
    expect(await client.recruiting.listAssessments({ roleId: "role" })).toEqual([]);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValueOnce(null);
    expect(
      await client.recruiting.getAssessment({ roleId: "role", candidateKey: "row" }),
    ).toBeNull();
    const candidatePage = {
      sortAvailability: { rank: false, tier: false, score: false },
      roleId: "role",
      roleRevisionId: "revision",
      crmTarget: null,
      items: [],
      nextCursor: null,
      total: 10,
      counts: {
        sourceRows: 15,
        candidates: 10,
        identifiedCandidates: 6,
        unassessed: 10,
        assessed: 0,
        shortlisted: 0,
      },
    };
    vi.mocked(db.listRecruitingCandidates).mockResolvedValueOnce(candidatePage);
    expect(
      await client.recruiting.listCandidates({
        roleId: "role",
        query: "Engineer",
        limit: 20,
        sourceEffectId: "native-read",
      }),
    ).toEqual(candidatePage);
    expect(db.listRecruitingCandidates).toHaveBeenLastCalledWith(prisma, actor, {
      roleId: "role",
      query: "Engineer",
      limit: 20,
      sourceEffectId: "native-read",
    });
    const sources = {
      roleId: "role",
      candidateKey: "candidate",
      items: [],
      nextCursor: null,
      total: 0,
    };
    vi.mocked(db.listRecruitingCandidateSources).mockResolvedValueOnce(sources);
    expect(
      await client.recruiting.listCandidateSources({ roleId: "role", candidateKey: "candidate" }),
    ).toEqual(sources);
    const shortlist = { roleId: "role", candidateKey: "candidate", shortlisted: true, revision: 1 };
    vi.mocked(db.setRecruitingCandidateShortlist).mockResolvedValueOnce(shortlist);
    expect(
      await client.recruiting.setCandidateShortlist({
        threadId: "thread",
        roleId: "role",
        candidateKey: "candidate",
        expectedRevision: 0,
        shortlisted: true,
      }),
    ).toEqual(shortlist);
    vi.mocked(db.listRecruitingResearch).mockResolvedValueOnce({
      tasks: [],
      actions: [],
      observations: [],
    });
    expect(await client.recruiting.listResearch({ roleId: "role" })).toEqual({
      tasks: [],
      actions: [],
      observations: [],
    });
  });
  it("supplies native artifact storage and authenticated context for both role writes", async () => {
    const artifacts = { get: vi.fn() };
    const client = createRouterClient(
      createRouter({ prisma, artifacts } as unknown as RouterDeps),
      { context: { actor } },
    );
    const definition = {
      title: "Example role",
      sourceRefs: [
        {
          id: "source",
          kind: "original_material" as const,
          anchor: { kind: "message" as const, messageId: "message", locator: "text:0" },
          readState: "unread" as const,
          readAt: null,
        },
      ],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    };
    const { title: _, ...revisionDefinition } = definition;
    const saved = {
      role: {
        id: "role",
        spaceId: actor.spaceId,
        userId: actor.userId,
        sourceThreadId: "thread",
        title: definition.title,
        revision: 1,
        currentRevisionId: "revision",
      },
      revision: {
        ...revisionDefinition,
        id: "revision",
        roleId: "role",
        revision: 1,
        createdAt: "2026-10-16T00:00:00.000Z",
      },
    };
    const input = { ...definition, sourceThreadId: "thread", expectedRevision: 0 as const };
    vi.mocked(db.createRecruitingRole).mockResolvedValueOnce(saved);
    await client.recruiting.createRole(input);
    expect(db.createRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, input, {
      artifacts,
      context: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: expect.any(AbortSignal),
      }),
    });
    const revision = { ...definition, roleId: "role", expectedRevision: 1 };
    vi.mocked(db.reviseRecruitingRole).mockResolvedValueOnce(saved);
    await client.recruiting.reviseRole(revision);
    expect(db.reviseRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, revision, {
      artifacts,
      context: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: expect.any(AbortSignal),
      }),
    });
  });
  it("returns the original assessment revision and authorized message targets through both RPC reads", async () => {
    const source = {
      id: "source",
      kind: "original_material" as const,
      anchor: { kind: "message" as const, messageId: "message", locator: "text:0" },
      readState: "unread" as const,
      readAt: null,
    };
    const snapshot: DbExports.RecruitingAssessmentSnapshot = {
      assessment: {
        roleId: "role",
        roleRevisionId: "original-revision",
        candidateKey: "row",
        version: 1,
        basedOnVersion: null,
        createdByRunId: "run",
        createdAt: "2026-10-16T00:00:00.000Z",
        facts: [],
        questions: [],
        sourceRefs: [source],
        judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
      },
      roleRevision: {
        id: "original-revision",
        roleId: "role",
        revision: 1,
        sourceRefs: [source],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        createdAt: "2026-10-16T00:00:00.000Z",
      },
      isCurrent: false,
      sourceMessageTargets: [
        { messageId: "message", threadId: "source-thread", target: { groupId: "source-group" } },
      ],
    };
    const client = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    vi.mocked(db.listRecruitingAssessments).mockResolvedValueOnce([snapshot]);
    expect(await client.recruiting.listAssessments({ roleId: "role" })).toEqual([snapshot]);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValueOnce(snapshot);
    expect(
      await client.recruiting.getAssessment({ roleId: "role", candidateKey: "row", version: 1 }),
    ).toEqual(snapshot);
    expect(
      RecruitingAssessmentSnapshotSchema.safeParse({
        ...snapshot,
        roleRevision: { ...snapshot.roleRevision, id: "current-revision" },
      }).success,
    ).toBe(false);
    expect(
      RecruitingAssessmentSnapshotSchema.safeParse({
        ...snapshot,
        sourceMessageTargets: [
          {
            messageId: "message",
            threadId: "source-thread",
            target: { botId: "bot", groupId: "group" },
          },
        ],
      }).success,
    ).toBe(false);
    vi.mocked(db.getRecruitingAssessment).mockRejectedValueOnce(
      new IsolationError("Private source-thread and message target"),
    );
    await expect(
      client.recruiting.getAssessment({ roleId: "role", candidateKey: "row" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });
  it("rejects unauthenticated reads and model-supplied identity before storage", async () => {
    const authenticated = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    const unauthenticated = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: {},
    });
    const readsBefore = vi.mocked(db.getRecruitingWorkspace).mock.calls.length;
    await expect(
      unauthenticated.recruiting.getWorkspace({ threadId: "thread" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.getRecruitingWorkspace).toHaveBeenCalledTimes(readsBefore);
    const writesBefore = vi.mocked(db.createRecruitingRole).mock.calls.length;
    await expect(
      authenticated.recruiting.createRole({
        sourceThreadId: "thread",
        expectedRevision: 0,
        title: "Synthetic",
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        sourceRefs: [
          {
            id: "source",
            kind: "original_material",
            anchor: { kind: "message", messageId: "message", locator: "text:0" },
            readState: "unread",
            readAt: null,
          },
        ],
        userId: "forged",
        runId: "forged",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.createRecruitingRole).toHaveBeenCalledTimes(writesBefore);
  });
});

it("uses the existing authenticated wrapper for human confirmation and sanitizes foreign access", async () => {
  vi.mocked(db.confirmRecruitingBrief).mockRejectedValueOnce(
    new IsolationError("private source details"),
  );
  await expect(
    api.confirmRecruitingBrief(prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  expect(db.confirmRecruitingBrief).toHaveBeenLastCalledWith(
    prisma,
    actor,
    { threadId: "thread", roleId: "role", expectedRevision: 1 },
    undefined,
  );
});

it("uses trusted RPC identity and artifact context for closed human criterion edits", async () => {
  const artifacts = { get: vi.fn() };
  const client = createRouterClient(createRouter({ prisma, artifacts } as unknown as RouterDeps), {
    context: { actor },
  });
  const input = {
    threadId: "thread",
    roleId: "role",
    expectedRevision: 1,
    criteria: [
      {
        criterionId: "criterion",
        priority: "hard" as const,
        atoms: [{ atomId: "atom", statement: "Edited statement" }],
      },
    ],
  };
  vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(
    new IsolationError("Private source details"),
  );
  await expect(client.recruiting.editCriteria(input)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Resource not found",
  });
  expect(db.editRecruitingCriteria).toHaveBeenLastCalledWith(prisma, actor, input, {
    artifacts,
    context: expect.objectContaining({
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: expect.any(AbortSignal),
    }),
  });
  const typedAtom = {
    atomId: "atom",
    employmentRule: {
      minimumMonths: 84,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time geometry implementation",
      cutoff: { kind: "assessment_date" as const },
    },
  };
  const typedInput = { ...input, criteria: [{ ...input.criteria[0]!, atoms: [typedAtom] }] };
  vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(new RecruitingConflictError());
  await expect(client.recruiting.editCriteria(typedInput)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(db.editRecruitingCriteria).toHaveBeenLastCalledWith(
    prisma,
    actor,
    typedInput,
    expect.objectContaining({ artifacts }),
  );
  const writesBefore = vi.mocked(db.editRecruitingCriteria).mock.calls.length;
  for (const extra of [
    { actor: { userId: "foreign" } },
    { sourceRefs: [] },
    { confirmation: {} },
    { expression: {} },
  ])
    await expect(
      client.recruiting.editCriteria({ ...input, ...extra } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  for (const atom of [
    { ...typedAtom, statement: "7+ years" },
    { atomId: "atom" },
    { ...typedAtom, employmentRule: { ...typedAtom.employmentRule, minimumMonths: 1.5 } },
    { ...typedAtom, employmentRule: { ...typedAtom.employmentRule, cutoff: { kind: "fixed" } } },
  ])
    await expect(
      client.recruiting.editCriteria({
        ...input,
        criteria: [{ ...input.criteria[0], atoms: [atom] }],
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(db.editRecruitingCriteria).toHaveBeenCalledTimes(writesBefore);
});

it("retains the existing safe mappings for criterion conflict, source and input failures", async () => {
  for (const [error, code] of [
    [new RecruitingConflictError(), "CONFLICT"],
    [new RecruitingSourceValidationError("source", "text"), "BAD_REQUEST"],
    [Object.assign(new Error("Private input"), { name: "ZodError" }), "BAD_REQUEST"],
  ] as const) {
    vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(error);
    await expect(api.editRecruitingCriteria(prisma, actor, {})).rejects.toMatchObject({ code });
  }
});

describe("retained candidate report API", () => {
  const input = { roleId: "role", candidateKey: "candidate" };
  const rows = [
    {
      name: { value: "Selected Person", source_id: "profile" },
      concerns: { value: null, evidence: "No code supplied", reasoning: "Needs verification" },
      tier: { value: "Provider shortlist" },
      _sources: { profile: "https://example.test/selected" },
      shard_id: "private-shard",
    },
    { name: { value: "Neighbor Person" }, private_note: { value: "Neighbor-only text" } },
  ];
  function fixture(legacy = false, transform: (snapshot: any) => void = () => {}) {
    const body = { rows, next_cursor: "private-next" };
    const providerResult = {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    };
    const observation = {
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: "private-next",
    };
    const snapshot = legacy
      ? {
          version: 1,
          taskId: "task",
          actionId: "action",
          operation: "rows",
          effectId: "effect",
          request: { task_id: "provider-task", cursor: "private-cursor" },
          providerResult,
          observation,
        }
      : {
          request: [
            "__rakazoCatalogTool",
            "direct",
            {
              route: {
                connectorId: "mcp",
                resourceId: "private-route",
                resourceRevision: 1,
                toolName: "get_rows",
              },
              args: { task_id: "provider-task", cursor: "private-cursor" },
            },
          ],
          providerResult,
        };
    transform(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactRef = { artifactId: "report-artifact", sha256 };
    const occurrence = {
      crmImports: [],
      providerTaskId: "provider-task",
      taskId: legacy ? "task" : null,
      actionId: legacy ? "action" : null,
      roleRevisionId: "old-revision",
      effectId: "effect",
      rowIndex: 0,
      artifactRef,
      requestCursor: "private-cursor",
      outputId: null,
      observedAt: "2026-10-17T00:00:00.000Z",
    };
    const page = { ...input, items: [occurrence], nextCursor: null, total: 1 };
    vi.mocked(db.listRecruitingCandidateSources).mockResolvedValue(page);
    vi.mocked(db.listRecruitingResearch).mockResolvedValue({
      tasks: [{ id: "task", roleId: "role", providerTaskId: "provider-task" }],
      actions: [
        {
          id: "action",
          taskId: "task",
          roleRevisionId: "old-revision",
          outputArtifacts: [artifactRef],
        },
      ],
      observations: [],
    } as never);
    const get = vi.fn(async () => bytes);
    const findFirst = vi.fn(async () => ({
      id: artifactRef.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      storageKey: "stored",
      botId: "bot",
      mimeType: "application/json",
      hash: sha256,
      size: bytes.length,
    }));
    const deps = {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    };
    return { deps, get, findFirst, page, occurrence, bytes, snapshot };
  }
  beforeEach(() => {
    vi.mocked(db.listRecruitingCandidateSources).mockReset();
    vi.mocked(db.listRecruitingResearch).mockReset();
  });
  it.each([false, true])(
    "projects only the exact person from a %s historical-task snapshot",
    async (legacy) => {
      const f = fixture(legacy);
      const client = createRouterClient(createRouter(f.deps as RouterDeps), { context: { actor } });
      const result = await client.recruiting.listCandidateSources(input);
      expect(result.items[0]?.report).toEqual({
        fields: [
          {
            label: "Name",
            value: "Selected Person",
            sourceUrls: ["https://example.test/selected"],
          },
          {
            label: "Concerns",
            value: null,
            evidence: "No code supplied",
            reasoning: "Needs verification",
            sourceUrls: [],
          },
          { label: "Tier", value: "Provider shortlist", sourceUrls: [] },
        ],
        sourceUrls: ["https://example.test/selected"],
      });
      expect(JSON.stringify(result.items[0]?.report)).not.toMatch(
        /Neighbor|private-|source_id|structuredContent|request/,
      );
      expect(f.get).toHaveBeenCalledOnce();
      expect(db.listRecruitingResearch).toHaveBeenCalledTimes(legacy ? 1 : 0);
      expect(db.listRecruitingCandidateSources).toHaveBeenCalledWith(f.deps.prisma, actor, input);
      expect(result.items[0]?.roleRevisionId).toBe("old-revision");
    },
  );
  it.each(["native", "legacy", "artifact-access", "hash", "bytes", "row"])(
    "serves saved reports and withholds unverified fit after metadata authorization (%s)",
    async (boundary) => {
      const f = fixture(boundary === "legacy", (snapshot) => {
        const supplied = structuredClone(rows);
        Object.assign(supplied[0]!, {
          match_score: { value: 0 },
          match_tier: { value: "Provider possible" },
        });
        Object.assign(supplied[1]!, { match_score: { value: null } });
        snapshot.providerResult.structuredContent.rows = supplied;
        snapshot.providerResult.content[0].text = JSON.stringify({
          rows: supplied,
          next_cursor: "private-next",
        });
        if (snapshot.observation) snapshot.observation.rows = supplied;
      });
      const { crmImports: _imports, ...source } = f.occurrence;
      const candidates = [source, { ...source, rowIndex: 1 }, undefined].map(
        (latestSource, index) => ({
          roleId: "role",
          candidateKey: `candidate-${index}`,
          name: `Person ${index}`,
          title: null,
          company: null,
          location: null,
          linkedinUrl: null,
          resumeUrl: null,
          evidenceUrls: null,
          issues: [],
          shortlisted: false,
          shortlistedAt: null,
          decision: null,
          decisionReason: null,
          decisionAt: null,
          revision: 0,
          discoveryCount: latestSource ? 1 : 0,
          firstDiscoveredAt: null,
          lastDiscoveredAt: null,
          crm: null,
          latestAssessment: null,
          ...(latestSource ? { latestSource } : {}),
        }),
      );
      vi.mocked(db.listRecruitingCandidates).mockResolvedValue({
        sortAvailability: { rank: false, tier: false, score: false },
        roleId: "role",
        roleRevisionId: "revision",
        crmTarget: null,
        items: candidates,
        nextCursor: "unchanged",
        total: 3,
        counts: {
          sourceRows: 2,
          candidates: 3,
          identifiedCandidates: 0,
          unassessed: 3,
          assessed: 0,
          shortlisted: 0,
        },
      });
      if (boundary === "artifact-access") f.findFirst.mockResolvedValue(null as never);
      if (boundary === "hash") source.artifactRef.sha256 = "0".repeat(64);
      if (boundary === "bytes") f.get.mockResolvedValue(Buffer.from("changed"));
      if (boundary === "row") {
        source.rowIndex = 99;
        candidates[1]!.latestSource!.rowIndex = 99;
      }
      const client = createRouterClient(createRouter(f.deps as RouterDeps), { context: { actor } });
      const result = await client.recruiting.listCandidates({ roleId: "role", limit: 3 });
      expect(result.nextCursor).toBe("unchanged");
      expect(result.items.map((item) => item.candidateKey)).toEqual(
        candidates.map((item) => item.candidateKey),
      );
      expect(result.items[2]?.latestSource).toBeUndefined();
      if (["native", "legacy"].includes(boundary)) {
        expect(result.items[0]?.latestSource?.report?.fields).toEqual(
          expect.arrayContaining([
            { label: "Match score", value: "0", sourceUrls: [] },
            { label: "Match tier", value: "Provider possible", sourceUrls: [] },
          ]),
        );
        expect(result.items[1]?.latestSource?.report?.fields).toContainEqual({
          label: "Match score",
          value: null,
          sourceUrls: [],
        });
        expect(f.get).toHaveBeenCalledOnce();
      } else {
        expect(result.items[0]?.latestSource).toEqual(source);
        expect(result.items[1]?.latestSource?.report).toBeUndefined();
        if (boundary === "artifact-access") expect(f.get).not.toHaveBeenCalled();
      }
      expect(db.listRecruitingCandidates).toHaveBeenCalledWith(f.deps.prisma, actor, {
        roleId: "role",
        limit: 3,
      });
    },
  );
  it("decodes the existing catalog request tuple without creating a local task", async () => {
    const f = fixture(false, (snapshot) => {
      const { route, args } = snapshot.request[2];
      snapshot.request = [
        "__rakazoCatalogTool",
        "mcp_execute_tool",
        { id: "private-route:get_rows", arguments: args },
        route,
      ];
    });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items[0]?.report?.fields[0]?.value).toBe("Selected Person");
    expect(db.listRecruitingResearch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "parses a shared saved page once across its candidate rows (%s)",
    async (legacy) => {
      const f = fixture(legacy);
      f.page.items.push({ ...f.occurrence, rowIndex: 1 });
      const parse = vi.spyOn(JSON, "parse");
      try {
        const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
        expect(result.items.map((item) => item.report?.fields[0]?.value)).toEqual([
          "Selected Person",
          "Neighbor Person",
        ]);
        expect(parse.mock.calls.filter(([text]) => text === f.bytes.toString("utf8"))).toHaveLength(
          1,
        );
      } finally {
        parse.mockRestore();
      }
    },
  );
  it("hydrates distinct artifacts concurrently without duplicating shared pages or changing order", async () => {
    const f = fixture();
    const second = {
      ...f.occurrence,
      rowIndex: 1,
      artifactRef: { ...f.occurrence.artifactRef, artifactId: "second" },
    };
    const unreadable = {
      ...f.occurrence,
      artifactRef: { ...f.occurrence.artifactRef, artifactId: "unreadable" },
    };
    f.page.items[0] = {
      ...f.occurrence,
      artifactRef: { ...f.occurrence.artifactRef, sha256: "0".repeat(64) },
    };
    f.page.items.push(
      second,
      { ...f.occurrence, rowIndex: 1 },
      unreadable,
      { ...unreadable, rowIndex: 1 },
      { ...f.occurrence, artifactRef: { ...f.occurrence.artifactRef, artifactId: "fourth" } },
      { ...f.occurrence, artifactRef: { ...f.occurrence.artifactRef, artifactId: "last" } },
    );
    f.findFirst.mockImplementation(async (...args: unknown[]) => {
      const { where } = args[0] as { where: { id: string; spaceId: string; userId: string } };
      expect(where).toEqual({ id: where.id, spaceId: actor.spaceId, userId: actor.userId });
      return {
        id: where.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        storageKey: where.id,
        botId: "bot",
        mimeType: "application/json",
        hash: f.occurrence.artifactRef.sha256,
        size: f.bytes.length,
      };
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.get.mockImplementation(async (...args: unknown[]) => {
      const key = args[0];
      if (key === f.occurrence.artifactRef.artifactId) await blocked;
      return key === "unreadable" ? Buffer.from("changed") : f.bytes;
    });
    const pending = api.listRecruitingCandidateSources(f.deps, actor, input);
    let result!: Awaited<typeof pending>;
    try {
      await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(4));
    } finally {
      release();
      result = await pending;
    }
    expect(f.get).toHaveBeenCalledTimes(5);
    expect(result.items.map((item) => item.report?.fields[0]?.value)).toEqual([
      undefined,
      "Neighbor Person",
      "Neighbor Person",
      undefined,
      undefined,
      "Selected Person",
      "Selected Person",
    ]);
    expect(result.items[3]).toEqual(unreadable);
    expect(result.items[4]?.report).toBeUndefined();
    expect(result.items.map((item) => item.artifactRef.artifactId)).toEqual([
      "report-artifact",
      "second",
      "report-artifact",
      "unreadable",
      "unreadable",
      "fourth",
      "last",
    ]);
  });

  it("reads a shared artifact once for multiple selected occurrences", async () => {
    const f = fixture();
    f.page.items.push({ ...f.occurrence });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items.map((item) => item.report?.fields[0]?.value)).toEqual([
      "Selected Person",
      "Selected Person",
    ]);
    expect(f.get).toHaveBeenCalledOnce();
  });
  it("keeps readable reports when another authorized occurrence cannot be projected", async () => {
    const f = fixture();
    f.page.items.push({ ...f.occurrence, rowIndex: 99 });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items[0]?.report?.fields[0]?.value).toBe("Selected Person");
    expect(result.items[1]).toEqual(f.page.items[1]);
    expect(f.get).toHaveBeenCalledOnce();
  });
  it("does no artifact or research read for an empty saved page", async () => {
    const f = fixture();
    f.page.items = [];
    expect(await api.listRecruitingCandidateSources(f.deps, actor, input)).toEqual(f.page);
    expect(f.get).not.toHaveBeenCalled();
    expect(db.listRecruitingResearch).not.toHaveBeenCalled();
  });
  it.each([
    "foreign-actor",
    "missing-occurrence",
    "hash",
    "bytes",
    "row",
    "request",
    "envelope",
    "legacy-binding",
    "legacy-effect",
    "legacy-result",
  ])("keeps authorized source metadata unavailable at the %s boundary", async (boundary) => {
    const legacy = boundary.startsWith("legacy-");
    const f = fixture(legacy, (snapshot) => {
      if (boundary === "request") snapshot.request = { task_id: "invented" };
      if (boundary === "envelope")
        snapshot.providerResult.structuredContent = { rows: ["conflicting"] };
      if (boundary === "legacy-effect") snapshot.effectId = "other-effect";
      if (boundary === "legacy-result") snapshot.observation.rows = [{ name: "Changed" }];
    });
    if (boundary === "foreign-actor") f.findFirst.mockResolvedValueOnce(null as never);
    if (boundary === "missing-occurrence")
      vi.mocked(db.listRecruitingCandidateSources).mockRejectedValueOnce(new IsolationError());
    if (boundary === "hash") f.occurrence.artifactRef.sha256 = "0".repeat(64);
    if (boundary === "bytes") f.get.mockResolvedValueOnce(Buffer.from("changed"));
    if (boundary === "row") f.occurrence.rowIndex = 99;
    if (boundary === "legacy-binding")
      vi.mocked(db.listRecruitingResearch).mockResolvedValueOnce({
        tasks: [],
        actions: [],
        observations: [],
      });
    const result = api.listRecruitingCandidateSources(f.deps, actor, input);
    if (boundary === "missing-occurrence")
      await expect(result).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
    else expect((await result).items).toEqual([f.occurrence]);
    if (["foreign-actor", "missing-occurrence"].includes(boundary))
      expect(f.get).not.toHaveBeenCalled();
  });
  it("accepts an exact 550-character incomplete array prefix confined to its saved person", async () => {
    const f = fixture(false, (snapshot) => {
      const canonical = structuredClone(rows);
      Object.assign(canonical[0]!, {
        infra_evidence: { value: "Supplied project implementation evidence. ".repeat(30) },
      });
      snapshot.providerResult.structuredContent.rows = canonical;
      snapshot.providerResult.content[0].text = JSON.stringify(
        canonical.map((row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !key.startsWith("_"))
              .map(([key, cell]) => [
                key,
                typeof cell === "object" && cell !== null && "value" in cell ? cell.value : cell,
              ]),
          ),
        ),
      );
    });
    const quote = f.snapshot.providerResult.content[0]!.text.slice(0, 550);
    expect(() => JSON.parse(quote)).toThrow();
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["providerResult", "content", 0, "text"],
              start: 0,
              end: 550,
            },
          },
        ],
      },
    } as never);
    const result = await api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    expect(result).toMatchObject({
      kind: "report",
      report: {
        fields: expect.arrayContaining([
          expect.objectContaining({ label: "Name", value: "Selected Person" }),
          expect.objectContaining({
            label: "Infra evidence",
            value: "Supplied project implementation evidence. ".repeat(30),
          }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Neighbor|private-|shard_id|providerResult/);
  });
  it.each([
    "prefix",
    "pretty-prefix",
    "neighbor",
    "cross-row",
    "values",
    "sparse-same-title",
    "missing-gap",
    "order",
    "duplicate",
    "request",
    "typed-cell",
  ])("binds the exact assessment selection to its own row at the %s boundary", async (boundary) => {
    const flatRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !key.startsWith("_") && key !== "shard_id")
          .map(([key, cell]) => [
            key,
            typeof cell === "object" && cell !== null && "value" in cell ? cell.value : cell,
          ]),
      ),
    );
    if (boundary === "values") flatRows[0]!.name = "Changed person";
    if (boundary === "sparse-same-title") flatRows[0] = { current_title: "Engineer" };
    if (boundary === "missing-gap") delete flatRows[0]!.concerns;
    if (boundary === "order") flatRows.reverse();
    const f = fixture(false, (snapshot) => {
      if (boundary === "sparse-same-title") {
        snapshot.providerResult.structuredContent.rows = structuredClone(rows);
        snapshot.providerResult.structuredContent.rows[0].current_title = { value: "Engineer" };
      }
      snapshot.providerResult.content[0].text = JSON.stringify(
        flatRows,
        null,
        boundary === "pretty-prefix" ? 2 : undefined,
      );
    });
    const text = f.snapshot.providerResult.content[0]!.text;
    let path: (string | number)[] = ["providerResult", "content", 0, "text"];
    let start = 0;
    let end = text.indexOf('"tier"') + 6;
    if (boundary === "neighbor") {
      start = text.indexOf("Neighbor Person");
      end = start + "Neighbor Person".length;
    }
    if (boundary === "cross-row") end = text.indexOf("Neighbor Person") + "Neighbor Person".length;
    if (boundary === "request") {
      path = ["request", 2, "args", "task_id"];
      start = 0;
      end = "provider-task".length;
    }
    if (boundary === "typed-cell") {
      path = ["providerResult", "structuredContent", "rows", 0, "name", "value"];
      start = 0;
      end = "Selected Person".length;
    }
    const quote =
      boundary === "request"
        ? "provider-task"
        : boundary === "typed-cell"
          ? "Selected Person"
          : text.slice(start, end);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: { kind: "artifact_json_string", path, start, end },
          },
        ],
      },
    } as never);
    if (boundary === "duplicate") f.page.items.push({ ...f.occurrence });
    const result = api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    if (["prefix", "pretty-prefix", "typed-cell"].includes(boundary)) {
      expect(await result).toMatchObject({
        kind: "report",
        report: { sourceUrls: ["https://example.test/selected"] },
      });
      expect(f.get).toHaveBeenCalledOnce();
    } else
      await expect(result).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
  });
  it("returns the exact person's report after validating an assessment's original quote and scoped saved occurrence", async () => {
    const f = fixture();
    const text = f.snapshot.providerResult.content[0]!.text;
    const quote = "Selected Person";
    const start = text.indexOf(quote);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["providerResult", "content", 0, "text"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    } as never);
    const result = await api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    expect(result).toMatchObject({
      kind: "report",
      report: { sourceUrls: ["https://example.test/selected"] },
    });
    expect(JSON.stringify(result)).not.toMatch(/Neighbor|private-|task_id|rows|providerResult/);
    expect(f.get).toHaveBeenCalledOnce();
    f.page.items = [];
    await expect(
      api.readRecruitingSource(f.deps, actor, {
        kind: "assessment",
        ...input,
        version: 2,
        sourceRefId: "source",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("live CRM browser reads", () => {
  const org = "10000000-0000-4000-8000-000000000001";
  const roleId = "20000000-0000-4000-8000-000000000002";
  const clientId = "30000000-0000-4000-8000-000000000003";
  const candidateId = "40000000-0000-4000-8000-000000000004";
  const target = {
    kind: "group" as const,
    groupId: "group",
    threadId: "thread",
    groupName: "Work",
    members: [],
    memberBotIds: ["coordinator"],
  };
  function browserFixture(secretId: string | null = null) {
    const server = {
      id: "crm",
      revision: 3,
      name: "CRM",
      endpoint: "https://crm.example.test/mcp",
      transport: "streamable_http",
      enabled: true,
      secretId,
      userId: actor.userId,
      spaceId: actor.spaceId,
    };
    const assignment = {
      allowAllTools: false,
      allowedTools: [
        "list_crm_memberships",
        "list_crm_roles",
        "get_crm_role",
        "get_crm_candidate_review",
        "list_crm_candidates",
        "list_crm_candidate_correspondence",
        "list_crm_candidate_messages",
      ],
    };
    const results: Record<string, unknown> = {
      list_crm_candidate_messages: [],
      list_crm_memberships: [
        { organization_id: org, role: "recruiter", organizations: { name: "Example" } },
      ],
      list_crm_roles: [
        {
          client_id: clientId,
          client_label: "Actual client",
          roles: [{ role_spec_id: roleId, role_label: "Actual role", summary: "Saved summary" }],
        },
      ],
      get_crm_role: {
        role_spec_id: roleId,
        client_id: clientId,
        client_label: "Actual client",
        role_label: "Actual role",
        summary: "Saved summary",
        description: null,
        jd_text: "Saved full JD",
        jd_url: null,
      },
      list_crm_candidates: {
        total: 2,
        rows: [
          {
            candidate_id: candidateId,
            full_name: "Stored person",
            email: null,
            phone: null,
            linkedin_url: null,
            location: null,
            headline: null,
            stage: null,
            contact_status: "no contact found",
            outreach_status: "not contacted",
            role_spec_id: null,
            client_label: "Actual client",
            role_label: "Actual role",
          },
        ],
      },
      list_crm_candidate_correspondence: {
        organization_id: org,
        candidate_id: candidateId,
        pagination: "offset",
        next_cursor: null,
        messages: [
          {
            id: "original-mail",
            organization_id: org,
            candidate_id: candidateId,
            lead_email: null,
            thread_id: "opaque-original-thread",
            direction: "received",
            timestamp_email: "2026-10-22T00:00:00Z",
            campaign_id: null,
            from_address: null,
            to_address: null,
            subject: null,
            body_text: "Stored actual body",
          },
        ],
      },
    };
    const execute = vi.fn(async function* (call: ConnectorCall, _context: AdapterContext) {
      yield {
        type: "result" as const,
        data: { structuredContent: { data: results[call.route!.toolName] } },
      };
    });
    const mockPrisma = {
      $queryRaw: vi.fn(async () => [actor]),
      mcpServer: {
        findMany: vi.fn(async () => [{ ...server, assignments: [assignment] }]),
        findFirst: vi.fn(async () => server),
      },
      botMcpServer: { findFirst: vi.fn(async () => assignment) },
    };
    const reauthorize = vi.fn(async () => target);
    const deps = {
      prisma: mockPrisma as unknown as PrismaClient,
      connectors: { execute },
      firstPartyMcpUrl: server.endpoint,
      reauthorize,
      signal: new AbortController().signal,
    };
    return { server, assignment, results, execute, deps, reauthorize, mockPrisma };
  }
  it("reads owner-scoped projected role contacts without requesting live candidate pages", async () => {
    const f = browserFixture();
    const stored = {
      candidateId,
      name: "Projected person",
      title: "Engineer",
      location: null,
      email: null,
      phone: null,
      linkedinUrl: null,
      stage: null,
      contactStatus: "no contact found",
      outreachStatus: "not contacted",
      roleSpecId: roleId,
      legacyClientLabel: "Actual client",
      legacyRoleLabel: "Actual role",
    };
    vi.mocked(db.listSyncedRecruitingCrmRoleContacts).mockResolvedValue([stored]);
    const result = await api.getRecruitingCrmData(
      f.deps,
      actor,
      target,
      {
        operation: "candidates",
        serverId: "crm",
        serverRevision: 3,
        organizationId: org,
        crmRoleId: roleId,
        limit: 25,
      },
      { source: "projection" },
    );
    expect(result).toMatchObject({
      scope: "stored_role",
      items: [stored],
      total: 1,
      nextOffset: null,
    });
    expect(db.listSyncedRecruitingCrmRoleContacts).toHaveBeenLastCalledWith(
      f.deps.prisma,
      actor,
      { mcpServerId: "crm", organizationId: org },
      roleId,
    );
    expect(f.execute.mock.calls.map(([call]) => call.route?.toolName)).not.toContain(
      "list_crm_candidates",
    );
  });

  it("does not substitute live candidates when the projection has not been synced", async () => {
    const f = browserFixture();
    vi.mocked(db.listSyncedRecruitingCrmRoleContacts).mockResolvedValue([]);
    const result = await api.getRecruitingCrmData(
      f.deps,
      actor,
      target,
      {
        operation: "candidates",
        serverId: "crm",
        serverRevision: 3,
        organizationId: org,
        crmRoleId: roleId,
      },
      { source: "projection" },
    );
    expect(result).toMatchObject({ scope: "stored_role", items: [], total: 0 });
    expect(f.execute.mock.calls.map(([call]) => call.route?.toolName)).not.toContain(
      "list_crm_candidates",
    );
  });

  it("requires the candidate tool assignment before reading projected contacts", async () => {
    const f = browserFixture();
    vi.mocked(db.listSyncedRecruitingCrmRoleContacts).mockClear();
    f.assignment.allowedTools = f.assignment.allowedTools.filter(
      (tool) => tool !== "list_crm_candidates",
    );
    await expect(
      api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        {
          operation: "candidates",
          serverId: "crm",
          serverRevision: 3,
          organizationId: org,
          crmRoleId: roleId,
        },
        { source: "projection" },
      ),
    ).rejects.toBeDefined();
    expect(db.listSyncedRecruitingCrmRoleContacts).not.toHaveBeenCalled();
  });

  it("rechecks the connection revision after loading projected contacts", async () => {
    const f = browserFixture();
    vi.mocked(db.listSyncedRecruitingCrmRoleContacts).mockImplementationOnce(async () => {
      f.server.revision++;
      return [];
    });
    await expect(
      api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        {
          operation: "candidates",
          serverId: "crm",
          serverRevision: 3,
          organizationId: org,
          crmRoleId: roleId,
        },
        { source: "projection" },
      ),
    ).rejects.toBeDefined();
  });

  it.each([
    ["candidates", ["list_crm_roles", "get_crm_role"]],
    ["candidateDetails", ["list_crm_candidate_messages", "get_crm_candidate_review"]],
    ["mail", ["list_crm_candidate_messages", "list_crm_candidate_correspondence"]],
  ] as const)(
    "overlaps the independent CRM reads of one %s request after the membership gate",
    async (operation, pair) => {
      const f = browserFixture();
      f.results.get_crm_candidate_review = details();
      const original = f.execute.getMockImplementation()!;
      let inFlight = 0;
      let overlapped = false;
      f.execute.mockImplementation(async function* (call, context) {
        const tracked = (pair as readonly string[]).includes(call.route!.toolName);
        if (tracked && ++inFlight === pair.length) overlapped = true;
        // Each provider read takes real wall time; sequential reads never overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (tracked) inFlight--;
        yield* original(call, context);
      });
      await api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        operation === "candidates"
          ? { operation, ...pinned, crmRoleId: roleId }
          : { operation, ...pinned, candidateId },
      );
      expect(f.execute.mock.calls[0]![0].route!.toolName).toBe("list_crm_memberships");
      expect(overlapped).toBe(true);
    },
  );
  it("reuses CRM authorization checks only between provider reads and reads memberships once per request", async () => {
    const f = browserFixture();
    f.results.get_crm_candidate_review = details();
    const input = { operation: "candidateDetails" as const, ...pinned, candidateId };
    const counts = () => ({
      membership: f.mockPrisma.$queryRaw.mock.calls.length,
      reauthorize: f.reauthorize.mock.calls.length,
      server: f.mockPrisma.mcpServer.findFirst.mock.calls.length,
      assignment: f.mockPrisma.botMcpServer.findFirst.mock.calls.length,
      memberships: f.execute.mock.calls.filter(
        ([call]) => call.route?.toolName === "list_crm_memberships",
      ).length,
    });
    await api.getRecruitingCrmData(f.deps, actor, target, input);
    // Three provider reads (memberships, outbox, review): one entry check plus one fresh check
    // after each read; the back-to-back fences before reads and before return reuse them.
    // Unmemoized this request ran 8 actor and 7 grant checks.
    const once = { membership: 4, reauthorize: 4, server: 4, assignment: 3, memberships: 1 };
    expect(counts()).toEqual(once);
    await api.getRecruitingCrmData(f.deps, actor, target, input);
    expect(counts()).toEqual(
      Object.fromEntries(Object.entries(once).map(([key, value]) => [key, value * 2])),
    );
    f.assignment.allowedTools = [];
    await expect(api.getRecruitingCrmData(f.deps, actor, target, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("freshly reads one exact canonical role for native conversation creation without scanning candidates or the role catalog", async () => {
    const f = browserFixture("existing-personal-oauth");
    const reference = {
      sourceId: "crm",
      serverRevision: 3,
      organizationId: org,
      crmRoleId: roleId,
    };
    expect(
      await api.getRecruitingCrmData(f.deps, actor, target, { operation: "role", reference }),
    ).toEqual(f.results.get_crm_role);
    expect(f.execute.mock.calls.map(([call]) => call.route!.toolName)).toEqual([
      "list_crm_memberships",
      "get_crm_role",
    ]);
    expect(f.execute.mock.calls[1]![0].args).toEqual({ p_org: org, p_role: roleId });
    expect(f.execute.mock.calls.every(([, context]) => context.runId === undefined)).toBe(true);
    f.results.get_crm_role = { ...(f.results.get_crm_role as object), role_spec_id: candidateId };
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, { operation: "role", reference }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    f.assignment.allowedTools = [];
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, { operation: "role", reference }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.each([undefined, 1, 2])(
    "requires corrected presence response version (%s)",
    async (version) => {
      const f = browserFixture();
      f.results.list_crm_candidates = {
        ...(version === undefined ? {} : { version }),
        candidate_ids: [],
        role_candidate_ids: [],
      };
      const result = api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "presence",
        ...pinned,
        candidateIds: [candidateId],
        crmRoleId: roleId,
      });
      if (version !== 2)
        await expect(result).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      else
        await expect(result).resolves.toMatchObject({
          operation: "presence",
          candidateIds: [],
          roleCandidateIds: [],
        });
    },
  );

  it.each(["mail", "candidateDetails"] as const)(
    "reads original CRM outbox records separately for %s without redispatch",
    async (operation) => {
      const f = browserFixture();
      f.results.get_crm_candidate_review = details();
      f.results.list_crm_candidate_messages = ["pending", "processing", "failed", "sent"].map(
        (status, index) => ({
          id: `50000000-0000-4000-8000-00000000000${index}`,
          organization_id: org,
          candidate_id: candidateId,
          author_user_id: "60000000-0000-4000-8000-000000000006",
          body: `Original ${status}`,
          status,
          polished_body: status === "sent" ? "Actual polished body" : null,
          instantly_email_id: status === "sent" ? "actual-provider-mail" : null,
          error: status === "failed" ? "No inbound anchor" : null,
          created_at: timestamp,
          sent_at: status === "sent" ? timestamp : null,
        }),
      );
      const result = await api.getRecruitingCrmData(f.deps, actor, target, {
        operation,
        ...pinned,
        candidateId,
      });
      expect(result).toMatchObject({
        outbox: [
          { status: "pending", body: "Original pending", sentAt: null },
          { status: "processing", sentAt: null },
          { status: "failed", error: "No inbound anchor", sentAt: null },
          {
            status: "sent",
            body: "Original sent",
            polishedBody: "Actual polished body",
            providerMessageId: "actual-provider-mail",
            sentAt: timestamp,
          },
        ],
      });
      expect(
        f.execute.mock.calls.filter(
          ([call]) => call.route?.toolName === "list_crm_candidate_messages",
        ),
      ).toHaveLength(1);
      expect(
        f.execute.mock.calls.every(
          ([call]) => call.route?.toolName !== "crm_post_candidate_message",
        ),
      ).toBe(true);
      expect(
        f.execute.mock.calls.find(
          ([call]) => call.route?.toolName === "list_crm_candidate_messages",
        )?.[0].args,
      ).toEqual({ p_org: org, p_candidate: candidateId });
      if (operation === "mail")
        expect(result).toMatchObject({ items: [{ body: "Stored actual body" }] });
      (f.results.list_crm_candidate_messages as Array<Record<string, unknown>>)[0]!.candidate_id =
        roleId;
      await expect(
        api.getRecruitingCrmData(f.deps, actor, target, { operation, ...pinned, candidateId }),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    },
  );
  it("adds exact-role native correspondence to original CRM mail without another provider read", async () => {
    const f = browserFixture();
    const mailServer = {
      ...actor,
      id: "mail",
      name: "Instantly",
      revision: 1,
      enabled: true,
      endpoint: "https://mcp.instantly.ai/mcp",
      transport: "streamable_http",
      secretId: null,
    };
    const grant = {
      ...actor,
      serverId: "mail",
      botId: "main",
      allowAllTools: false,
      allowedTools: ["get_email", "reply_to_email"],
    };
    f.mockPrisma.mcpServer.findMany.mockResolvedValue([mailServer] as never);
    Object.assign(f.mockPrisma.botMcpServer, { findMany: vi.fn(async () => [grant]) });
    Object.assign(f.mockPrisma, {
      $transaction: async (callback: (tx: typeof f.mockPrisma) => Promise<unknown>) =>
        callback(f.mockPrisma),
    });
    const currentThread = { findFirst: vi.fn(async () => ({ id: target.threadId })) };
    Object.assign(f.mockPrisma, { thread: currentThread });
    const anchor = {
      id: "70000000-0000-4000-8000-000000000007",
      timestamp_created: timestamp,
      timestamp_email: timestamp,
      message_id: "<native@example.test>",
      subject: "Actual native subject",
      from_address_email: "person@example.test",
      to_address_email_list: "team@example.test",
      body: { text: "Full native body" },
      organization_id: "80000000-0000-4000-8000-000000000008",
      eaccount: "team@example.test",
      thread_id: "actual-native-thread",
      ue_type: 2,
    };
    const request = catalogApprovalRequest(
      "connectors_execute_tool",
      { id: "mail:get_email", arguments: { id: anchor.id } },
      "__rakazoCatalogTool",
      { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: "get_email" },
    );
    const read = {
      id: "native-read",
      request,
      status: "completed",
      result: { structuredContent: anchor },
      run: { id: "native-run", sourceMessageId: "human" },
      createdAt: new Date(timestamp),
      updatedAt: new Date(timestamp),
    };
    const record = {
      scope: { candidateId },
      source: {
        id: "mail",
        name: "Instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
        transport: "streamable_http",
      },
      emailRead: read,
      reads: [read],
      args: { reply_to_uuid: anchor.id },
      effect: { ...read, id: "uncertain-native-reply", status: "uncertain" },
    };
    const evidence = {
      roleId: "local-role",
      bindingEffectId: "binding",
      target: { crmRoleId: roleId },
      crmSource: { endpoint: f.server.endpoint, transport: "streamable_http" },
      partial: false,
      authorizations: [{ server: mailServer, botId: "main", tool: "get_email" }],
      records: [record, { ...record, scope: { candidateId: roleId } }],
    };
    vi.mocked(db.readRecruitingNativeCorrespondence).mockResolvedValue(evidence as never);
    try {
      const result = await api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "mail",
        ...pinned,
        candidateId,
        crmRoleId: roleId,
      });
      expect(result).toMatchObject({
        items: [{ body: "Stored actual body" }],
        nativeCorrespondence: [
          {
            status: "read",
            candidateId,
            email: { sourceId: "mail", providerMessageId: anchor.id, body: "Full native body" },
          },
          { status: "unknown", candidateId, email: null },
        ],
      });
      expect(db.readRecruitingNativeCorrespondence).toHaveBeenCalledWith(f.deps.prisma, actor, {
        threadId: target.threadId,
        roleId: undefined,
        target: {
          mcpServerId: f.server.id,
          serverRevision: f.server.revision,
          organizationId: org,
          crmRoleId: roleId,
        },
      });
      expect(f.execute.mock.calls.map(([call]) => call.route?.toolName)).toEqual([
        "list_crm_memberships",
        "list_crm_candidate_messages",
        "list_crm_candidate_correspondence",
      ]);
      let afterCapture = false;
      vi.mocked(db.readRecruitingNativeCorrespondence).mockImplementation(async () => {
        afterCapture = true;
        return evidence as never;
      });
      f.reauthorize.mockImplementation(async () => {
        if (afterCapture) grant.allowedTools = [];
        return target;
      });
      await expect(
        api.getRecruitingCrmData(f.deps, actor, target, {
          operation: "mail",
          ...pinned,
          candidateId,
          crmRoleId: roleId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      grant.allowedTools = ["get_email", "reply_to_email"];
      f.reauthorize.mockImplementation(async () => target);
      currentThread.findFirst.mockResolvedValue(null as never);
      await expect(
        api.getRecruitingCrmData(f.deps, actor, target, {
          operation: "mail",
          ...pinned,
          candidateId,
          crmRoleId: roleId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      vi.mocked(db.readRecruitingNativeCorrespondence).mockReset().mockResolvedValue(null);
    }
  });
  it.each(["mail", "candidateDetails"] as const)(
    "rechecks the CRM outbox grant after the other %s read completes",
    async (operation) => {
      const f = browserFixture();
      f.results.get_crm_candidate_review = details();
      const lastTool =
        operation === "mail" ? "list_crm_candidate_correspondence" : "get_crm_candidate_review";
      f.execute.mockImplementation(async function* (call) {
        if (call.route?.toolName === lastTool)
          f.assignment.allowedTools = f.assignment.allowedTools.filter(
            (tool) => tool !== "list_crm_candidate_messages",
          );
        yield {
          type: "result" as const,
          data: { structuredContent: { data: f.results[call.route!.toolName] } },
        };
      });
      await expect(
        api.getRecruitingCrmData(f.deps, actor, target, { operation, ...pinned, candidateId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );
  it("reads canonical role metadata and the unchanged legacy candidate filter without a run or copied records", async () => {
    const f = browserFixture();
    const response = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "candidates",
      serverId: "crm",
      serverRevision: 3,
      organizationId: org,
      crmRoleId: roleId,
      limit: 1,
      offset: 0,
    });
    expect(response).toMatchObject({
      operation: "candidates",
      scope: "legacy_role_labels",
      total: 2,
      nextOffset: 1,
      selectedRole: { crmRoleId: roleId, jdText: "Saved full JD" },
      items: [{ candidateId, roleSpecId: null, legacyRoleLabel: "Actual role" }],
    });
    const [call, context] = f.execute.mock.calls.find(
      ([call]) => call.route?.toolName === "list_crm_candidates",
    )!;
    expect(call.args).toEqual({
      p_org: org,
      p_not_reviewed: false,
      p_limit: 1,
      p_offset: 0,
      p_client: "Actual client",
      p_role: "Actual role",
    });
    expect(context).toMatchObject({
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: "coordinator",
    });
    expect(context).not.toHaveProperty("runId");
    expect(
      f.execute.mock.calls.every(
        ([call]) => !/import|bind|send|reply|update/.test(call.route!.toolName),
      ),
    ).toBe(true);
  });
  it("pages CRM candidates through an opaque offset cursor passed to the CRM tool", async () => {
    const f = browserFixture();
    const row = f.results.list_crm_candidates.rows[0]!;
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    f.execute.mockImplementation(async function* (call) {
      const data =
        call.route?.toolName === "list_crm_candidates"
          ? {
              total: ids.length,
              rows: ids
                .slice(
                  call.args.p_offset as number,
                  (call.args.p_offset as number) + (call.args.p_limit as number),
                )
                .map((candidate_id) => ({ ...row, candidate_id })),
            }
          : f.results[call.route!.toolName];
      yield { type: "result" as const, data: { structuredContent: { data } } };
    });
    const page = (extra: { limit?: number; cursor?: string; offset?: number }) =>
      api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "candidates",
        serverId: "crm",
        serverRevision: 3,
        organizationId: org,
        ...extra,
      });
    const first = await page({ limit: 2 });
    expect(first).toMatchObject({ total: 3, offset: 0, nextOffset: 2, nextCursor: "2" });
    const second = await page({ limit: 2, cursor: "2" });
    expect(second).toMatchObject({ total: 3, offset: 2, nextOffset: null, nextCursor: null });
    const seen = [first, second].flatMap((value) =>
      "items" in value
        ? value.items.map((item) => (item as { candidateId: string }).candidateId)
        : [],
    );
    expect(seen).toEqual(ids);
    expect(
      f.execute.mock.calls
        .filter(([call]) => call.route?.toolName === "list_crm_candidates")
        .map(([call]) => [call.args.p_limit, call.args.p_offset]),
    ).toEqual([
      [2, 0],
      [2, 2],
    ]);
    await expect(page({ limit: 2, cursor: "2", offset: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(page({ limit: 51 })).rejects.toThrow();
    await expect(page({ cursor: "01" })).rejects.toThrow();
  });
  it("discovers only assigned first-party sources and returns actual stored correspondence identities", async () => {
    const f = browserFixture();
    expect(
      await api.getRecruitingCrmData(f.deps, actor, target, { operation: "memberships" }),
    ).toMatchObject({
      sources: [
        {
          serverId: "crm",
          status: "ready",
          memberships: [{ organizationId: org, name: "Example" }],
        },
      ],
    });
    expect(
      await api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "mail",
        serverId: "crm",
        serverRevision: 3,
        organizationId: org,
        candidateId,
      }),
    ).toMatchObject({
      scope: "stored_candidate_correspondence",
      nextCursor: null,
      items: [
        {
          providerMessageId: "original-mail",
          threadId: "opaque-original-thread",
          body: "Stored actual body",
          sender: null,
          recipients: [],
          partial: false,
        },
      ],
    });
  });
  const timestamp = "2026-10-22T00:00:00Z";
  const tracking = (roleKey: string) => ({
    role_key: roleKey,
    client_label: "Actual client",
    role_label: roleKey,
    high_signal: true,
    workflow_status: null,
    high_signal_at: timestamp,
    status_changed_at: null,
    updated_at: timestamp,
  });
  const campaign = {
    id: "original-campaign",
    name: "Saved campaign",
    status: 2,
    role_spec_id: roleId,
    client_id: clientId,
    synced_at: timestamp,
  };
  const pinned = { serverId: "crm", serverRevision: 3, organizationId: org };
  const details = () => ({
    organization_id: org,
    candidate_id: candidateId,
    review: null,
    role_tracking: [{ candidate_id: candidateId, ...tracking("role-a") }],
    role_interests: ["manual", "ai", "instantly"].map((source) => ({
      role_key: source,
      client_label: "Actual client",
      role_label: source,
      interest: "interested",
      source,
    })),
    campaign_associations: {
      lead_campaigns: [
        { lead_id: "original-lead", campaign_id: campaign.id, campaign },
        { lead_id: "no-campaign-lead", campaign_id: null, campaign: null },
      ],
      pipeline_campaign: null,
      pagination: "offset",
      offset: 0,
      next_offset: 2,
    },
  });
  const roleMailInput = {
    operation: "roleMail" as const,
    serverId: "crm",
    serverRevision: 3,
    organizationId: org,
    crmRoleId: roleId,
    limit: 2,
  };
  function roleMail(f: ReturnType<typeof browserFixture>) {
    f.assignment.allowedTools.push("list_crm_role_correspondence");
    f.results.list_crm_role_correspondence = {
      version: 2,
      organization_id: org,
      role_id: roleId,
      pagination: "offset",
      next_offset: 2,
      messages: [
        {
          id: "role-mail",
          organization_id: org,
          candidate_id: candidateId,
          lead_email: null,
          thread_id: "thread-1",
          direction: "received",
          timestamp_email: "2026-10-22T00:00:00Z",
          campaign_id: null,
          from_address: "person@example.com",
          to_address: "recruiter@example.com",
          subject: "Re: role",
          body_text: "Stored full reply",
        },
      ],
    };
  }
  function inboxBridgeFixture() {
    const f = browserFixture();
    roleMail(f);
    (f.results.list_crm_role_correspondence as { next_offset: number | null }).next_offset = null;
    const workspace = { role: { id: "local-role" } };
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValue(workspace as never);
    vi.mocked(db.readRecruitingNativeCorrespondence).mockResolvedValue(null);
    const attached = {
      mcpServerId: "crm",
      serverRevision: 3,
      organizationId: org,
      crmRoleId: roleId,
      clientId,
      clientLabel: "Actual client",
      roleLabel: "Actual role",
    };
    vi.mocked(db.getRecruitingWorkspaceCrmTarget).mockReset().mockResolvedValue(attached);
    const prisma = {
      ...f.mockPrisma,
      externalEffect: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    return {
      ...f,
      attached,
      read: (page = {}) =>
        api.getRecruitingCorrespondence(
          prisma,
          actor,
          target,
          "inbox",
          { endpoint: f.server.endpoint, connected: true },
          undefined,
          page,
          { ...f.deps },
        ),
    };
  }
  it("bridges exact attached CRM history into the canonical Inbox without fabricating receipts", async () => {
    const f = inboxBridgeFixture();
    const result = await f.read();
    expect(result).toMatchObject({
      status: "ready",
      connections: [{ name: "CRM", status: "configured" }],
      emails: [
        {
          sourceId: "crm",
          providerMessageId: "role-mail",
          savedRead: null,
          body: "Stored full reply",
          crm: { organizationId: org, crmRoleId: roleId, candidateId, threadId: "thread-1" },
        },
      ],
    });
    expect(f.execute.mock.calls.at(-1)?.[0].args).toMatchObject({ p_org: org, p_role: roleId });
  });
  it("does not guess a CRM role for an unbound legacy workspace", async () => {
    const f = inboxBridgeFixture();
    vi.mocked(db.getRecruitingWorkspaceCrmTarget).mockResolvedValue(null);
    expect((await f.read()).emails).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("propagates CRM mail read failure rather than returning a successful empty Inbox", async () => {
    const f = inboxBridgeFixture();
    f.execute.mockImplementation(async function* (call) {
      if (call.route!.toolName === "list_crm_role_correspondence")
        yield {
          type: "error" as const,
          message: "Role has too many candidates for one correspondence read.",
        };
      else
        yield {
          type: "result" as const,
          data: { structuredContent: { data: f.results[call.route!.toolName] } },
        };
    });
    await expect(f.read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("rejects lost organization access and wrong-role CRM results", async () => {
    const f = inboxBridgeFixture();
    f.results.list_crm_memberships = [];
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const other = inboxBridgeFixture();
    (other.results.list_crm_role_correspondence as { role_id: string }).role_id = clientId;
    await expect(other.read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("does not mix history after attachment changes during the read", async () => {
    const f = inboxBridgeFixture();
    vi.mocked(db.getRecruitingWorkspaceCrmTarget)
      .mockResolvedValueOnce(f.attached)
      .mockResolvedValue({ ...f.attached, crmRoleId: clientId });
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("shows unsupported CRM role mail explicitly and preserves missing capability", async () => {
    const f = inboxBridgeFixture();
    f.assignment.allowedTools = f.assignment.allowedTools.filter(
      (tool) => tool !== "list_crm_role_correspondence",
    );
    expect(await f.read()).toMatchObject({ status: "unsupported", partial: true, emails: [] });
  });
  it("retains stored mailbox identity without inferring it from recipients", async () => {
    const f = inboxBridgeFixture();
    const message = (
      f.results.list_crm_role_correspondence as { messages: Record<string, unknown>[] }
    ).messages[0]!;
    message.eaccount = "stored-mailbox@example.test";
    expect((await f.read()).emails[0]?.crm?.eaccount).toBe("stored-mailbox@example.test");
    delete message.eaccount;
    expect((await f.read()).emails[0]?.crm).not.toHaveProperty("eaccount");
  });
  it("pages a role with more than 200 stored messages without skipping or truncating", async () => {
    const f = inboxBridgeFixture();
    const template = (
      f.results.list_crm_role_correspondence as { messages: Record<string, unknown>[] }
    ).messages[0]!;
    const messages = Array.from({ length: 205 }, (_, index) => ({
      ...template,
      id: `mail-${String(300 - index).padStart(3, "0")}`,
      candidate_id: index % 2 ? roleId : candidateId,
    }));
    f.execute.mockImplementation(async function* (call) {
      const name = call.route!.toolName;
      const args = call.args as { p_offset: number; p_limit: number };
      const end = args.p_offset + args.p_limit;
      yield {
        type: "result" as const,
        data: {
          structuredContent: {
            data:
              name === "list_crm_role_correspondence"
                ? {
                    version: 2,
                    organization_id: org,
                    role_id: roleId,
                    pagination: "offset",
                    messages: messages.slice(args.p_offset, end),
                    next_offset: end < messages.length ? end : null,
                  }
                : f.results[name],
          },
        },
      };
    });
    const first = await f.read({ cursor: "200", limit: 3 });
    expect(first.emails.map((email) => email.providerMessageId)).toEqual([
      "mail-100",
      "mail-099",
      "mail-098",
    ]);
    expect(first.nextCursor).toBe("203");
    const last = await f.read({ cursor: first.nextCursor!, limit: 3 });
    expect(last.emails.map((email) => email.providerMessageId)).toEqual(["mail-097", "mail-096"]);
    expect(last.nextCursor).toBeNull();
  });
  it("fails closed when multiple attachments cannot resolve to one exact CRM target", async () => {
    const f = inboxBridgeFixture();
    vi.mocked(db.getRecruitingWorkspaceCrmTarget).mockRejectedValue(new IsolationError());
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects invalid page continuation rather than silently skipping history", async () => {
    const f = inboxBridgeFixture();
    (f.results.list_crm_role_correspondence as { next_offset: number | null }).next_offset = 20;
    await expect(f.read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("rechecks the actor before reading attached history", async () => {
    const f = inboxBridgeFixture();
    f.deps.reauthorize.mockResolvedValue({ ...target, threadId: "other-thread" });
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects repeated mail across source pages instead of skipping it silently", async () => {
    const f = inboxBridgeFixture();
    f.execute.mockImplementation(async function* (call) {
      const name = call.route!.toolName;
      const data =
        name === "list_crm_role_correspondence"
          ? {
              ...(f.results[name] as object),
              next_offset: (call.args as { p_offset: number }).p_offset + 1,
            }
          : f.results[name];
      yield { type: "result" as const, data: { structuredContent: { data } } };
    });
    await expect(f.read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("rejects legacy role mail semantics until the source protocol migration is deployed", async () => {
    const f = inboxBridgeFixture();
    delete (f.results.list_crm_role_correspondence as { version?: number }).version;
    await expect(f.read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("reads every stored email for the exact CRM role in one scoped read", async () => {
    const f = browserFixture();
    roleMail(f);
    const result = await api.getRecruitingCrmData(f.deps, actor, target, roleMailInput);
    expect(result).toMatchObject({
      operation: "roleMail",
      supported: true,
      crmRoleId: roleId,
      nextOffset: 2,
      items: [
        {
          candidateId,
          providerMessageId: "role-mail",
          direction: "received",
          sender: "person@example.com",
          recipients: ["recruiter@example.com"],
          body: "Stored full reply",
          partial: false,
        },
      ],
    });
    expect(f.execute.mock.calls.at(-1)?.[0].args).toEqual({
      p_org: org,
      p_role: roleId,
      p_limit: 2,
      p_offset: 0,
    });
  });
  it("reports role-wide mail as unsupported when the tool is not assigned or not on the CRM", async () => {
    const unassigned = browserFixture();
    expect(
      await api.getRecruitingCrmData(unassigned.deps, actor, target, roleMailInput),
    ).toMatchObject({ operation: "roleMail", supported: false, items: [] });
    expect(
      unassigned.execute.mock.calls.some(
        ([call]) => call.route?.toolName === "list_crm_role_correspondence",
      ),
    ).toBe(false);

    const missing = browserFixture();
    missing.assignment.allowAllTools = true;
    missing.execute.mockImplementation(async function* (call: ConnectorCall) {
      if (call.route!.toolName === "list_crm_role_correspondence")
        yield {
          type: "error" as const,
          message: "MCP error -32602: Tool list_crm_role_correspondence not found",
        };
      else
        yield {
          type: "result" as const,
          data: { structuredContent: { data: missing.results[call.route!.toolName] } },
        };
    });
    expect(
      await api.getRecruitingCrmData(missing.deps, actor, target, roleMailInput),
    ).toMatchObject({ supported: false });
  });
  it("fails a role-wide mail read the CRM rejects for another reason or another scope", async () => {
    const f = browserFixture();
    roleMail(f);
    f.execute.mockImplementation(async function* (call: ConnectorCall) {
      if (call.route!.toolName === "list_crm_role_correspondence")
        yield {
          type: "error" as const,
          message: "Role has too many candidates for one correspondence read.",
        };
      else
        yield {
          type: "result" as const,
          data: { structuredContent: { data: f.results[call.route!.toolName] } },
        };
    });
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, roleMailInput),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const other = browserFixture();
    roleMail(other);
    (other.results.list_crm_role_correspondence as { role_id: string }).role_id = clientId;
    await expect(
      api.getRecruitingCrmData(other.deps, actor, target, roleMailInput),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("filters role candidates by the exact stored pipeline stage", async () => {
    const f = browserFixture();
    const page = f.results.list_crm_candidates as { rows: { stage: string | null }[] };
    page.rows[0]!.stage = "Interview";
    const input = {
      operation: "candidates" as const,
      serverId: "crm",
      serverRevision: 3,
      organizationId: org,
      crmRoleId: roleId,
      stage: "Interview",
      limit: 1,
    };
    expect(await api.getRecruitingCrmData(f.deps, actor, target, input)).toMatchObject({
      items: [{ candidateId, stage: "Interview" }],
    });
    expect(
      f.execute.mock.calls.find(([call]) => call.route?.toolName === "list_crm_candidates")?.[0]
        .args,
    ).toMatchObject({ p_stage: "Interview", p_role: "Actual role", p_client: "Actual client" });
    page.rows[0]!.stage = "Screening";
    await expect(api.getRecruitingCrmData(f.deps, actor, target, input)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("reads actual Important rows with labels only at the candidate-role row and preserves the true total", async () => {
    const f = browserFixture();
    const row = RecruitingCrmCandidatesReadSchema.parse(f.results.list_crm_candidates).rows[0]!;
    f.results.list_crm_candidates = {
      total: 5,
      rows: ["role-a", "role-b"].map((roleKey) => {
        const { client_label: _client, role_label: _role, ...nativeTracking } = tracking(roleKey);
        return { ...row, role_label: roleKey, role_tracking: [nativeTracking] };
      }),
    };
    const result = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "important",
      ...pinned,
      limit: 2,
      status: "high_signal",
    });
    expect(result).toMatchObject({
      operation: "important",
      scope: "organization_candidate_roles",
      total: 5,
      nextOffset: 2,
      items: [
        { candidateId, roleKey: "role-a", clientLabel: "Actual client", roleLabel: "role-a" },
        { candidateId, roleKey: "role-b", clientLabel: "Actual client", roleLabel: "role-b" },
      ],
    });
    expect(f.execute.mock.calls.at(-1)?.[0].args).toEqual({
      p_view: "important",
      p_org: org,
      p_status: "high_signal",
      p_limit: 2,
      p_offset: 0,
    });
  });
  it("rejects duplicate Important candidate-role keys while permitting one candidate in different roles", async () => {
    const f = browserFixture();
    const row = RecruitingCrmCandidatesReadSchema.parse(f.results.list_crm_candidates).rows[0]!;
    const { client_label: _client, role_label: _role, ...nativeTracking } = tracking("role-a");
    const duplicate = { ...row, role_label: "role-a", role_tracking: [nativeTracking] };
    f.results.list_crm_candidates = { total: 2, rows: [duplicate, duplicate] };
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, { operation: "important", ...pinned }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it.each(["client_label", "role_label"])(
    "requires the actual Important row's top-level %s",
    async (field) => {
      const f = browserFixture();
      const row = RecruitingCrmCandidatesReadSchema.parse(f.results.list_crm_candidates).rows[0]!;
      const { client_label: _client, role_label: _role, ...nativeTracking } = tracking("role-a");
      f.results.list_crm_candidates = {
        total: 1,
        rows: [{ ...row, [field]: undefined, role_tracking: [nativeTracking] }],
      };
      await expect(
        api.getRecruitingCrmData(f.deps, actor, target, { operation: "important", ...pinned }),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    },
  );
  it("reads source-labeled candidate details without fabricating a missing pipeline or campaign", async () => {
    const f = browserFixture("personal-oauth-reference");
    f.results.get_crm_candidate_review = details();
    const result = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "candidateDetails",
      ...pinned,
      candidateId,
      limit: 2,
    });
    expect(result).toMatchObject({
      operation: "candidateDetails",
      candidateId,
      review: null,
      roleInterests: [{ source: "manual" }, { source: "ai" }, { source: "instantly" }],
      campaignAssociations: {
        leadCampaigns: [
          { campaignId: campaign.id, campaign: { status: 2 } },
          { campaignId: null, campaign: null },
        ],
        pipelineCampaign: null,
        nextOffset: 2,
      },
    });
    expect(f.execute.mock.calls.at(-1)?.[0].args).toEqual({
      p_view: "details",
      p_org: org,
      p_candidate: candidateId,
      p_campaign_limit: 2,
      p_campaign_offset: 0,
    });
  });
  it("preserves actual internal review notes and pipeline campaign metadata", async () => {
    const f = browserFixture();
    f.results.get_crm_candidate_review = {
      ...details(),
      review: {
        id: clientId,
        organization_id: org,
        candidate_id: candidateId,
        role_spec_id: roleId,
        stage: "Interview",
        reviewed: true,
        review_result: "approved",
        notes: "Stored internal note\nOriginal second line",
        updated_at: timestamp,
        candidate_full_name: "Stored person",
        canonical_role_title: "Actual role",
      },
      campaign_associations: { ...details().campaign_associations, pipeline_campaign: campaign },
    };
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "candidateDetails",
        ...pinned,
        candidateId,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      review: {
        result: "approved",
        notes: "Stored internal note\nOriginal second line",
        candidateName: "Stored person",
        roleTitle: "Actual role",
        crmRoleId: roleId,
      },
      campaignAssociations: {
        pipelineCampaign: { id: campaign.id, status: 2, crmRoleId: roleId, clientId },
      },
    });
  });
  it("reads the exact role's stored campaign associations and raw status without sequence steps", async () => {
    const f = browserFixture();
    f.results.get_crm_role = {
      organization_id: org,
      role_spec_id: roleId,
      campaigns: [{ id: campaign.id, name: campaign.name, status: null, synced_at: timestamp }],
      pagination: "offset",
      offset: 30,
      next_offset: null,
    };
    const result = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "roleCampaigns",
      ...pinned,
      crmRoleId: roleId,
      offset: 30,
    });
    expect(result).toMatchObject({
      operation: "roleCampaigns",
      scope: "stored_role_campaigns",
      crmRoleId: roleId,
      offset: 30,
      nextOffset: null,
      items: [{ id: campaign.id, status: null }],
    });
    expect(result).not.toHaveProperty("steps");
    expect(f.execute.mock.calls.at(-1)?.[0].args).toEqual({
      p_view: "campaigns",
      p_org: org,
      p_role: roleId,
      p_limit: 25,
      p_offset: 30,
    });
  });
  it.each([
    "review-candidate",
    "tracking-candidate",
    "campaign-identity",
    "campaign-cursor",
    "role-identity",
  ])("rejects incorrect details or campaign %s", async (boundary) => {
    const f = browserFixture();
    const data = details();
    if (boundary === "review-candidate")
      Object.assign(data, {
        review: {
          id: clientId,
          organization_id: org,
          candidate_id: roleId,
          role_spec_id: roleId,
          stage: "Interview",
          reviewed: true,
          review_result: "approved",
          notes: "Stored note",
          updated_at: timestamp,
          candidate_full_name: "Stored person",
          canonical_role_title: "Actual role",
        },
      });
    if (boundary === "tracking-candidate") data.role_tracking[0]!.candidate_id = roleId;
    if (boundary === "campaign-identity")
      data.campaign_associations.lead_campaigns[0]!.campaign_id = "other-campaign";
    if (boundary === "campaign-cursor") data.campaign_associations.next_offset = 0;
    f.results.get_crm_candidate_review = data;
    f.results.get_crm_role = {
      organization_id: org,
      role_spec_id: candidateId,
      campaigns: [],
      pagination: "offset",
      offset: 0,
      next_offset: null,
    };
    await expect(
      api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        boundary === "role-identity"
          ? { operation: "roleCampaigns", ...pinned, crmRoleId: roleId }
          : { operation: "candidateDetails", ...pinned, candidateId, limit: 2 },
      ),
    ).rejects.toThrow();
  });
  it("uses the existing current-user personal OAuth source for every CRM browse operation", async () => {
    const f = browserFixture("existing-personal-oauth-reference");
    const membership = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "memberships",
    });
    expect(membership).toMatchObject({
      sources: [{ serverId: "crm", serverRevision: 3, status: "ready" }],
    });
    const pinned = { serverId: "crm", serverRevision: 3, organizationId: org };
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, { operation: "roles", ...pinned }),
    ).resolves.toMatchObject({ operation: "roles", items: [{ crmRoleId: roleId }] });
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "candidates",
        ...pinned,
        crmRoleId: roleId,
      }),
    ).resolves.toMatchObject({ operation: "candidates", items: [{ candidateId }] });
    await expect(
      api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "mail",
        ...pinned,
        candidateId,
      }),
    ).resolves.toMatchObject({
      operation: "mail",
      items: [{ providerMessageId: "original-mail" }],
    });
    expect(f.mockPrisma.mcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          endpoint: f.server.endpoint,
          transport: "streamable_http",
          enabled: true,
        },
      }),
    );
    expect(JSON.stringify(membership)).not.toContain("existing-personal-oauth-reference");
  });
  it.each(["candidates", "mail"] as const)(
    "continues a current personal OAuth %s read after quiet token rotation",
    async (operation) => {
      const f = browserFixture("existing-personal-oauth-reference");
      const original = f.execute.getMockImplementation()!;
      f.execute.mockImplementation(async function* (call, context) {
        yield* original(call, context);
        if (call.route?.toolName === "list_crm_memberships")
          f.server.secretId = "rotated-personal-oauth-reference";
      });
      const result = await api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        operation === "mail"
          ? { operation, ...pinned, candidateId }
          : { operation, ...pinned, crmRoleId: roleId },
      );
      expect(result).toMatchObject({
        operation,
        items: [operation === "mail" ? { providerMessageId: "original-mail" } : { candidateId }],
      });
      expect(f.server.revision).toBe(3);
      expect(JSON.stringify(result)).not.toContain("rotated-personal-oauth-reference");
    },
  );
  it.each([undefined, roleId])(
    "explicitly includes reviewed candidates on later pages with role %s",
    async (crmRoleId) => {
      const f = browserFixture();
      await api.getRecruitingCrmData(f.deps, actor, target, {
        operation: "candidates",
        serverId: "crm",
        serverRevision: 3,
        organizationId: org,
        crmRoleId,
        offset: 50,
        limit: 50,
      });
      const [call] = f.execute.mock.calls.find(
        ([call]) => call.route?.toolName === "list_crm_candidates",
      )!;
      expect(call.args).toMatchObject({ p_not_reviewed: false, p_offset: 50, p_limit: 50 });
    },
  );
  it("reports a failed source honestly and does not expose provider error details", async () => {
    const f = browserFixture();
    f.execute.mockImplementation(async function* () {
      yield {
        type: "result",
        data: { isError: true, structuredContent: { data: "private-provider-error" } },
      };
    });
    const result = await api.getRecruitingCrmData(f.deps, actor, target, {
      operation: "memberships",
    });
    expect(result).toMatchObject({ sources: [{ status: "unavailable", memberships: [] }] });
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
  });
  it.each([
    "revision",
    "credential",
    "credential-mode",
    "credential-removed",
    "grant",
    "actor",
    "target",
    "provider",
    "cursor",
    "ambiguous",
    "blank-label",
    "foreign-label",
  ])("fails closed on a changed or invalid %s boundary", async (boundary) => {
    const f = browserFixture(
      boundary === "credential" || boundary === "credential-removed"
        ? "existing-personal-oauth-reference"
        : null,
    );
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async function* (call, context) {
      yield* original(call, context);
      if (call.route?.toolName !== "list_crm_candidates") return;
      if (boundary === "revision") f.server.revision++;
      if (boundary === "credential") {
        f.server.secretId = "replaced-personal-oauth-reference";
        f.server.revision++;
      }
      if (boundary === "credential-mode") f.server.secretId = "new-personal-oauth-reference";
      if (boundary === "credential-removed") f.server.secretId = null;
      if (boundary === "grant") f.assignment.allowedTools = [];
      if (boundary === "actor") f.mockPrisma.$queryRaw.mockResolvedValue([]);
      if (boundary === "target")
        f.reauthorize.mockResolvedValue({ ...target, memberBotIds: ["other"] });
    });
    if (boundary === "blank-label") {
      f.results.list_crm_roles = [
        {
          client_id: clientId,
          client_label: "Actual client",
          roles: [{ role_spec_id: roleId, role_label: "   ", summary: null }],
        },
      ];
      f.results.get_crm_role = {
        role_spec_id: roleId,
        client_id: clientId,
        client_label: "Actual client",
        role_label: "   ",
        summary: null,
        description: null,
        jd_text: null,
        jd_url: null,
      };
    }
    if (boundary === "foreign-label")
      f.results.list_crm_candidates = {
        total: 1,
        rows: [
          {
            candidate_id: candidateId,
            full_name: "Foreign role",
            email: null,
            phone: null,
            linkedin_url: null,
            stage: null,
            contact_status: "unknown",
            outreach_status: "unknown",
            role_spec_id: null,
            client_label: "Other client",
            role_label: "Other role",
          },
        ],
      };
    if (boundary === "provider") f.results.list_crm_candidates = null;
    if (boundary === "ambiguous")
      f.results.list_crm_roles = [
        {
          client_id: clientId,
          client_label: "Actual client",
          roles: [
            { role_spec_id: roleId, role_label: "Actual role", summary: null },
            { role_spec_id: candidateId, role_label: "Actual role", summary: null },
          ],
        },
      ];
    await expect(
      api.getRecruitingCrmData(
        f.deps,
        actor,
        target,
        boundary === "cursor"
          ? {
              operation: "mail",
              serverId: "crm",
              serverRevision: 3,
              organizationId: org,
              candidateId,
              cursor: {
                p_org: candidateId,
                p_candidate: candidateId,
                linked_offset: 0,
                unlinked_offset: 0,
              },
            }
          : {
              operation: "candidates",
              serverId: "crm",
              serverRevision: 3,
              organizationId: org,
              crmRoleId: roleId,
            },
      ),
    ).rejects.toThrow();
  });
});

describe("role campaign read", () => {
  const target = {
    kind: "group" as const,
    groupId: "role-group",
    threadId: "role-thread",
    groupName: "Role",
    memberBotIds: ["main", "outreach"],
    members: [],
  };
  const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
  function fixture(effect: unknown) {
    const calls: ConnectorCall[] = [];
    const findUnique = vi.fn(async () => effect);
    const deps = {
      prisma: {
        botMcpServer: {
          findFirst: vi.fn(async () => ({
            botId: "outreach",
            allowAllTools: false,
            allowedTools: ["list_emails", "get_email"],
            server: { id: "instantly", revision: 4 },
          })),
        },
        externalEffect: { findUnique },
        run: { findFirst: vi.fn(async () => null) },
        message: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
      connectors: {
        async *execute(call: ConnectorCall) {
          calls.push(call);
          yield {
            type: "result" as const,
            data: {
              structuredContent: {
                source: "local_native_instantly_rest",
                result:
                  call.route?.toolName === "native_instantly_get_campaign"
                    ? { id: CAMPAIGN, name: "Staff [role]", status: 1, stop_on_reply: false }
                    : {
                        items: [
                          {
                            id: "l1",
                            email: "Ada@Example.test",
                            status: -1,
                            lt_interest_status: 1,
                          },
                          { id: "l2", email: "other@example.test", status: 1 },
                        ],
                      },
              },
            },
          };
        },
      },
    };
    return { deps, calls, findUnique };
  }
  beforeEach(() =>
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({ role: { id: "role" } } as never),
  );

  it("reads the bound campaign and its leads only through read-only native tools", async () => {
    const f = fixture({
      spaceId: actor.spaceId,
      status: "completed",
      result: {
        campaignId: CAMPAIGN,
        campaignName: "Staff [role]",
        eaccount: "team@example.test",
        leads: { "ada-key": { leadId: "l1", email: "ada@example.test" } },
      },
    });
    const output = await api.getRecruitingRoleCampaign(f.deps, actor, target);
    expect(f.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: "instantly-role-campaign:instantly:role" },
      }),
    );
    expect(f.calls.map((call) => [call.route?.toolName, call.args])).toEqual([
      ["native_instantly_get_campaign", { campaign_id: CAMPAIGN }],
      ["native_instantly_list_leads", { campaign_id: CAMPAIGN, limit: 100 }],
    ]);
    expect(output).toEqual({
      status: "ready",
      serverId: "instantly",
      campaign: {
        id: CAMPAIGN,
        name: "Staff [role]",
        eaccount: "team@example.test",
        status: 1,
        stopOnReply: false,
      },
      leads: [
        { candidateKey: "ada-key", email: "Ada@Example.test", status: -1, interestStatus: 1 },
        { candidateKey: null, email: "other@example.test", status: 1, interestStatus: null },
      ],
    });
  });

  it("reports no campaign without a binding in the actor's space", async () => {
    for (const effect of [null, { spaceId: "other", status: "completed", result: {} }]) {
      const f = fixture(effect);
      expect(await api.getRecruitingRoleCampaign(f.deps, actor, target)).toEqual({
        status: "none",
        serverId: "instantly",
        campaign: null,
        leads: [],
      });
      expect(f.calls).toEqual([]);
    }
  });

  it("role setup reports a bound campaign, its sender and leads as ready", async () => {
    const f = fixture({
      spaceId: actor.spaceId,
      status: "completed",
      result: {
        campaignId: CAMPAIGN,
        campaignName: "Staff [role]",
        eaccount: "team@example.test",
        leads: {},
      },
    });
    const setup = await api.getRecruitingRoleSetup(f.deps, actor, target);
    expect(setup).toEqual({
      ready: true,
      playbookStage: { stage: "intake", label: "岗位录入", nextStep: null },
      attention: null,
      items: [
        {
          key: "campaign",
          state: "ready",
          label: "Staff [role]",
          detail: { id: CAMPAIGN, name: "Staff [role]", status: 1, leadCount: 2 },
        },
        {
          key: "sender",
          state: "ready",
          label: "team@example.test",
          detail: { email: "team@example.test" },
        },
        {
          key: "crm",
          state: "missing",
          label: "Role record not linked yet",
          action: { kind: "ask_agent", prompt: expect.any(String) },
        },
        { key: "leads", state: "ready", label: "2 recipients", detail: { count: 2 } },
      ],
    });
    for (const item of setup.items)
      expect(
        `${item.label} ${item.action?.kind === "ask_agent" ? item.action.prompt : ""}`,
      ).not.toMatch(/crm|campaign|lead/i);
  });

  it("role setup without a campaign is not ready and points each gap at the agent", async () => {
    const f = fixture(null);
    (
      f.deps.prisma as unknown as { externalEffect: Record<string, unknown> }
    ).externalEffect.findFirst = vi.fn(async () => ({ result: { eaccount: "last@example.test" } }));
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce({
      role: { id: "role" },
      crmTarget: {
        bindingEffectId: "b1",
        target: { organizationId: "org-1", clientLabel: "Acme", roleLabel: "Staff Engineer" },
      },
    } as never);
    const setup = await api.getRecruitingRoleSetup(f.deps, actor, target);
    expect(setup.ready).toBe(false);
    expect(setup.items.map((item) => [item.key, item.state, item.action?.kind])).toEqual([
      ["campaign", "missing", "ask_agent"],
      ["sender", "ready", undefined],
      ["crm", "ready", undefined],
      ["leads", "missing", "ask_agent"],
    ]);
    for (const item of setup.items)
      expect(
        `${item.label} ${item.action?.kind === "ask_agent" ? item.action.prompt : ""}`,
      ).not.toMatch(/crm|campaign|lead/i);
    expect(setup.items[1]).toMatchObject({ detail: { email: "last@example.test" } });
    expect(setup.items[2]).toMatchObject({
      detail: { orgId: "org-1", roleLabel: "Staff Engineer" },
    });
    expect(f.calls).toEqual([]);
  });

  it.each(["approval", "question"] as const)(
    "role setup surfaces the waiting %s card of the role's conversation",
    async (kind) => {
      const f = fixture(null);
      const prisma = f.deps.prisma as unknown as Record<string, Record<string, unknown>>;
      const at = new Date("2026-10-23T10:00:00.000Z");
      prisma.run.findFirst = vi.fn(async () => ({
        id: "run-9",
        threadId: "role-thread",
        createdAt: at,
      }));
      prisma.message.findFirst = vi.fn(async () => ({
        id: "msg-ask",
        createdAt: at,
        blocks: [
          {
            kind: "ask",
            text: "Confirm the role requirements",
            status: "pending",
            ...(kind === "approval" ? { approvalEffectId: "approval-effect" } : {}),
          },
        ],
      }));
      prisma.externalEffect.findFirst = vi.fn(async () => null);
      const setup = await api.getRecruitingRoleSetup(f.deps, actor, target);
      expect(setup.attention).toEqual({
        kind,
        threadId: "role-thread",
        cardId: "msg-ask",
        createdAt: at.toISOString(),
      });
      expect(prisma.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "waiting_input",
            thread: expect.objectContaining({ activeRecruitingRoleId: "role" }),
          }),
        }),
      );
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ runId: "run-9", role: "bot" }),
        }),
      );
    },
  );

  it("role setup marks campaign and sender unavailable when Instantly is not assigned", async () => {
    const f = fixture(null);
    const prisma = f.deps.prisma as unknown as Record<string, Record<string, unknown>>;
    prisma.botMcpServer.findFirst = vi.fn(async () => null);
    prisma.mcpServer = { findFirst: vi.fn(async () => ({ id: "instantly" })) };
    const setup = await api.getRecruitingRoleSetup(f.deps, actor, target);
    expect(setup.ready).toBe(false);
    expect(setup.items.slice(0, 2)).toEqual([
      expect.objectContaining({
        key: "campaign",
        state: "unavailable",
        action: { kind: "connect", serverId: "instantly" },
      }),
      expect.objectContaining({ key: "sender", state: "unavailable" }),
    ]);
  });
});

describe("role candidates (Autumn + CRM merged list)", () => {
  const org = "10000000-0000-4000-8000-000000000001";
  const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const person = (key: string, linkedinUrl: string | null, extra: Record<string, unknown> = {}) =>
    ({
      roleId: "role",
      candidateKey: key,
      name: key,
      title: "Engineer",
      company: null,
      location: null,
      linkedinUrl,
      resumeUrl: null,
      evidenceUrls: null,
      issues: [],
      shortlisted: false,
      shortlistedAt: null,
      crm: null,
      decision: null,
      decisionReason: null,
      decisionAt: null,
      revision: 0,
      discoveryCount: 1,
      firstDiscoveredAt: null,
      lastDiscoveredAt: null,
      latestAssessment: null,
      ...extra,
    }) as unknown as db.RecruitingCandidate;
  const contact = (n: number, fields: Record<string, unknown>) => ({
    candidateId: uuid(n),
    name: `Contact ${n}`,
    email: null,
    phone: null,
    linkedinUrl: null,
    location: null,
    title: null,
    stage: "Sourced",
    contactStatus: "contacted",
    outreachStatus: "sent",
    roleSpecId: null,
    legacyClientLabel: "Client",
    legacyRoleLabel: "Role",
    serverId: "crm-server",
    organizationId: org,
    ...fields,
  });
  const crmTarget = {
    bindingEffectId: "binding",
    target: {
      mcpServerId: "crm-server",
      serverRevision: 1,
      organizationId: org,
      crmRoleId: uuid(900),
      crmClientId: uuid(901),
      clientLabel: "Client",
      roleLabel: "Role",
    },
  };
  // Autumn fake paging its list by an index cursor, like listCandidates' opaque cursor.
  const sources = (
    autumn: db.RecruitingCandidate[],
    crm: ReturnType<typeof contact>[] | "unavailable" | "unbound",
  ): api.RoleCandidatesSources => ({
    async autumn(cursor, limit) {
      const start = cursor ? Number(cursor) : 0;
      const items = autumn.slice(start, start + limit);
      return {
        items,
        nextCursor: start + limit < autumn.length ? String(start + limit) : null,
        total: autumn.length,
        counts: {
          sourceRows: autumn.length,
          candidates: autumn.length,
          identifiedCandidates: autumn.length,
          unassessed: autumn.length,
          assessed: 0,
          shortlisted: autumn.filter((row) => row.shortlisted).length,
        },
        crmTarget: crm === "unbound" ? null : crmTarget,
      };
    },
    autumnLinkedinUrls: async () => autumn.flatMap((row) => row.linkedinUrl ?? []),
    crm: async () =>
      crm === "unavailable" || crm === "unbound"
        ? { status: "unavailable" }
        : { status: "ok", rows: crm },
  });
  const all = async (
    input: Omit<Parameters<typeof api.mergeRoleCandidates>[0], "threadId">,
    from: api.RoleCandidatesSources,
  ) => {
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await api.mergeRoleCandidates(
        { threadId: "thread", ...input, ...(cursor ? { cursor } : {}) },
        from,
      );
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 50);
    return pages;
  };

  it("dedupes by normalized LinkedIn URL into one row with both sides", async () => {
    const page = await api.mergeRoleCandidates(
      { threadId: "thread" },
      sources(
        [
          person("ada", "https://www.linkedin.com/in/Ada-L/", {
            match: { rank: 1, tier: "Strong", score: 9 },
          }),
        ],
        [contact(1, { linkedinUrl: "linkedin.com/in/ada-l?trk=x", email: "ada@x.test" })],
      ),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: "autumn:ada",
      email: "ada@x.test",
      autumn: { candidateKey: "ada", score: 9, rank: 1, tier: "Strong" },
      crm: { candidateId: uuid(1), serverId: "crm-server", organizationId: org },
    });
    expect(page.total).toBe(1);
  });

  it("dedupes by lowercased email when LinkedIn is absent (one CRM person, two records)", async () => {
    const page = await api.mergeRoleCandidates(
      { threadId: "thread" },
      sources(
        [],
        [
          contact(1, { email: "Grace@X.test", linkedinUrl: "https://linkedin.com/in/grace" }),
          contact(2, { email: "grace@x.test " }),
          contact(3, { email: "other@x.test" }),
        ],
      ),
    );
    expect(page.items.map((row) => row.key)).toEqual([`crm:${uuid(1)}`, `crm:${uuid(3)}`]);
  });

  it("puts CRM-only rows after every Autumn row, sorted by score from the Autumn read", async () => {
    const pages = await all(
      { limit: 2 },
      sources(
        [person("a", null), person("b", null), person("c", null)],
        [contact(1, { email: "z@x.test" }), contact(2, { email: "y@x.test" })],
      ),
    );
    const keys = pages.flatMap((page) => page.items.map((row) => row.key));
    expect(keys).toEqual(["autumn:a", "autumn:b", "autumn:c", `crm:${uuid(1)}`, `crm:${uuid(2)}`]);
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.every((page) => page.total === 5)).toBe(true);
  });

  it("pages without overlap or gaps, and a merged CRM contact never reappears as CRM-only", async () => {
    const autumn = Array.from({ length: 7 }, (_, n) =>
      person(`p${n}`, `https://linkedin.com/in/p${n}`),
    );
    const crm = [
      contact(1, { linkedinUrl: "https://linkedin.com/in/p6" }),
      ...Array.from({ length: 5 }, (_, n) => contact(10 + n, { email: `c${n}@x.test` })),
    ];
    for (const limit of [1, 3, 4, 100]) {
      const keys = (await all({ limit }, sources(autumn, crm))).flatMap((page) =>
        page.items.map((row) => row.key),
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(12);
      expect(keys).not.toContain(`crm:${uuid(1)}`);
    }
    await expect(
      api.mergeRoleCandidates(
        {
          threadId: "thread",
          query: "other",
          cursor: (
            await api.mergeRoleCandidates({ threadId: "thread", limit: 1 }, sources(autumn, crm))
          ).nextCursor!,
        },
        sources(autumn, crm),
      ),
    ).rejects.toBeInstanceOf(RecruitingConflictError);
  });

  it("shortlistedOnly keeps shortlisted Autumn rows and drops CRM-only rows", async () => {
    const from = sources(
      [person("a", null), person("b", null, { shortlisted: true })],
      [contact(1, { email: "z@x.test" })],
    );
    const original = from.autumn;
    from.autumn = async (cursor, limit) => {
      const page = await original(cursor, limit);
      return { ...page, items: page.items.filter((row) => row.shortlisted), total: 1 };
    };
    const page = await api.mergeRoleCandidates({ threadId: "thread", shortlistedOnly: true }, from);
    expect(page.items.map((row) => row.key)).toEqual(["autumn:b"]);
    expect(page.total).toBe(1);
  });

  it("counts shortlisted, replied and each outreach status once per deduped person", async () => {
    const page = await api.mergeRoleCandidates(
      { threadId: "thread" },
      sources(
        [person("a", null, { shortlisted: true }), person("b", "https://linkedin.com/in/b")],
        [
          contact(1, { linkedinUrl: "https://linkedin.com/in/b", outreachStatus: "replied" }),
          contact(2, { email: "r@x.test", outreachStatus: "replied" }),
          contact(3, { email: "r@x.test", outreachStatus: "replied" }),
          contact(4, { email: "s@x.test", outreachStatus: "bounced" }),
        ],
      ),
    );
    expect(page.counts).toEqual({ shortlisted: 1, replied: 2, bounced: 1 });
    expect(page.crmStatus).toBe("ok");
  });

  it("query filters CRM-only rows on name, email and title case-insensitively", async () => {
    const page = await api.mergeRoleCandidates(
      { threadId: "thread", query: "ROBOT" },
      sources(
        [],
        [
          contact(1, { title: "Robotics lead" }),
          contact(2, { email: "robot@x.test" }),
          contact(3, { name: "Ana" }),
        ],
      ),
    );
    expect(page.items.map((row) => row.key)).toEqual([`crm:${uuid(1)}`, `crm:${uuid(2)}`]);
  });

  it("returns Autumn-only rows with crm null when the CRM is unbound or unavailable", async () => {
    for (const [crm, status] of [
      ["unbound", "not_bound"],
      ["unavailable", "unavailable"],
    ] as const) {
      const page = await api.mergeRoleCandidates(
        { threadId: "thread" },
        sources([person("a", "https://linkedin.com/in/a")], crm),
      );
      expect(page).toMatchObject({ crmStatus: status, total: 1, nextCursor: null });
      expect(page.items.map((row) => [row.key, row.crm])).toEqual([["autumn:a", null]]);
    }
  });

  it("wires the existing listCandidates read and reports an unbound CRM without CRM calls", async () => {
    vi.mocked(db.getRecruitingWorkspaceRoleId).mockResolvedValue("role");
    vi.mocked(db.listRecruitingCandidates).mockResolvedValue({
      ...(await sources([person("a", null)], "unbound").autumn(undefined, 25)),
      sortAvailability: { rank: true, tier: false, score: true },
      roleId: "role",
      roleRevisionId: "revision",
    });
    const execute = vi.fn();
    const target = {
      kind: "bot" as const,
      botId: "bot",
      threadId: "thread",
    } as unknown as Parameters<typeof api.getRecruitingRoleCandidates>[2];
    const page = await api.getRecruitingRoleCandidates(
      {
        prisma,
        artifacts: {} as ArtifactStore,
        connectors: { execute },
        reauthorize: async () => target,
      },
      actor,
      target,
      { threadId: "thread", query: "a", shortlistedOnly: true },
    );
    expect(db.listRecruitingCandidates).toHaveBeenCalledWith(prisma, actor, {
      roleId: "role",
      limit: 25,
      sort: "score",
      query: "a",
      shortlisted: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(page).toMatchObject({ crmStatus: "not_bound", total: 1 });
    await expect(
      api.getRecruitingRoleCandidates(
        {
          prisma,
          artifacts: {} as ArtifactStore,
          connectors: { execute },
          reauthorize: async () => target,
        },
        actor,
        target,
        { threadId: "other-thread" },
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
