import { createHash } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { readInstantlyEmail } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { RecruitingAssessmentSnapshotSchema } from "@rakazo/contracts";
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
const prisma = {} as PrismaClient;
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("saved recruiting correspondence", () => {
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
  it("projects the real native read envelope and allowlisted mail fields under current actor/thread/role permissions", async () => {
    const { client, prisma } = fixture();
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      emails: [
        {
          sender: email.from_address_email,
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
  it("displays native opaque Instantly thread IDs without weakening outbound anchor validation", async () => {
    const row = { ...email, thread_id: "provider-opaque-thread" };
    const { prisma } = fixture({
      result: { structuredContent: { items: [row], next_starting_after: null } },
    });
    expect(readInstantlyEmail(row)).toBeNull();
    const result = await api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
    expect(result).toMatchObject({
      status: "ready",
      partial: false,
      emails: [{ sender: row.from_address_email, subject: row.subject, body: row.body.text }],
    });
    expect(JSON.stringify(result)).not.toContain(row.thread_id);
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
    expect(client.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({
      in: [retained.id],
    });
  });
  it("does not present a global mailbox read as checked role correspondence", async () => {
    const { client, prisma, retained } = fixture();
    retained.request[2] = {
      ...(retained.request[2] as object),
      args: { email_type: "all", limit: 100 },
    } as never;
    client.externalEffect.findMany.mockReset().mockResolvedValueOnce([retained]);
    expect(await api.getRecruitingCorrespondence(prisma, actor, target, "inbox")).toMatchObject({
      status: "not_checked",
      checkedAt: null,
      emails: [],
    });
    expect(client.externalEffect.findMany).toHaveBeenCalledTimes(1);
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
    expect(result.connections).toEqual([{ name: "Instantly", status: "needs_access" }]);
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
    return api.getRecruitingCorrespondence(prisma, actor, target, "inbox");
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
      expect(result.connections).toEqual([{ name: "FullEnrich", status: "configured" }]);
      expect(JSON.stringify(result)).not.toContain("platform-service-key");
      vi.stubEnv("FULLENRICH_API_KEY", " ");
      client.externalEffect.findMany.mockResolvedValue([]);
      expect(
        (await api.getRecruitingCorrespondence(prisma, actor, target, "contacts")).connections,
      ).toEqual([{ name: "FullEnrich", status: "needs_connection" }]);
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
        ).toEqual([{ name: "FullEnrich", status: "needs_connection" }]);
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
