import type { ProductEvent } from "@rakazo/contracts";
import { boundDirectApprovalRequest } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  includeWaitingAskMessages,
  isBackgroundRun,
  isPeerRun,
  loadAllMessages,
  loadMessagePage,
  projectRecruitingApprovalEvent,
  projectRecruitingApprovalFiles,
  shouldForwardBackgroundThreadEvent,
  shouldForwardPeerThreadEvent,
} from "./thread-message-pages.js";

describe("native CRM connection approval presentation", () => {
  function fixture() {
    const actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const request = {
      operation: "bind",
      roleId: "role",
      expectedRoleRevision: 2,
      expectedBindingEffectId: null,
      crmRoleReadEffectId: "read",
    };
    const ask = {
      kind: "ask" as const,
      text: "Review internal operation",
      detail: JSON.stringify(request),
      status: "pending" as const,
      approvalEffectId: "approval",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
    const message = {
      id: "card",
      threadId: "thread",
      runId: "run",
      botId: "bot",
      role: "bot" as const,
      blocks: [ask],
    };
    const target = {
      mcpServerId: "server",
      serverRevision: 1,
      organizationId: "10000000-0000-4000-8000-000000000001",
      crmRoleId: "20000000-0000-4000-8000-000000000002",
      crmClientId: "30000000-0000-4000-8000-000000000003",
      clientLabel: "Example Client",
      roleLabel: "Platform Engineer",
    };
    const approval = {
      id: "approval",
      kind: "recruiting_crm_target",
      runId: "run",
      status: "intended",
      request,
      result: null,
      run: { botId: "bot" },
    };
    const source = {
      id: "read",
      kind: "mcp__crm__get_crm_role",
      runId: "read-run",
      status: "completed",
      request: boundDirectApprovalRequest(
        {
          connectorId: "mcp",
          resourceId: target.mcpServerId,
          resourceRevision: 1,
          toolName: "get_crm_role",
        },
        { p_org: target.organizationId, p_role: target.crmRoleId },
        "__rakazoCatalogTool",
      ),
      result: {
        structuredContent: {
          data: {
            role_spec_id: target.crmRoleId,
            client_id: target.crmClientId,
            client_label: target.clientLabel,
            role_label: target.roleLabel,
          },
        },
      },
      run: { botId: "bot" },
    };
    const role = {
      id: "role",
      title: "Software Engineer",
      crmBindingEffectId: null as string | null,
      revision: 2,
      currentRevisionId: "revision",
      currentRevision: { id: "revision", roleId: "role", revision: 2 },
    };
    const externalEffect = {
      findMany: vi.fn(
        async (query: {
          where: { run: { userId: string }; spaceId: string; id: { in: string[] } };
        }) =>
          query.where.run.userId !== "owner" || query.where.spaceId !== "space"
            ? []
            : query.where.id.in.includes("approval")
              ? [approval]
              : [source],
      ),
    };
    const persistedMessage = structuredClone(message);
    const prisma = {
      externalEffect,
      message: { findMany: vi.fn(async () => [persistedMessage]) },
      thread: { findFirst: vi.fn(async () => ({ activeRecruitingRole: role })) },
    } as unknown as PrismaClient;
    return { actor, request, ask, message, approval, source, role, persistedMessage, prisma };
  }

  it("presents the SAME fileless history card using native evidence without changing originals", async () => {
    const f = fixture();
    const before = structuredClone({
      message: f.message,
      approval: f.approval,
      persistedMessage: f.persistedMessage,
    });
    const [shown] = await projectRecruitingApprovalFiles(f.prisma, f.actor, "thread", [f.message]);
    expect(shown!.blocks[0]).toEqual({
      ...f.ask,
      text: "Review CRM role connection",
      detail:
        "Role: Software Engineer\nCRM client: Example Client\nCRM role: Platform Engineer\n\nConnect this recruiting role to the CRM role pool",
    });
    expect(f.message).toEqual(before.message);
    expect(f.approval).toEqual(before.approval);
    expect(f.persistedMessage).toEqual(before.persistedMessage);
  });

  it.each([
    "actor",
    "space",
    "thread",
    "effect-run",
    "effect-bot",
    "source-bot",
    "source-status",
    "source-route",
    "role",
    "revision",
    "binding",
    "persisted-card",
  ])("does not derive business labels from mismatched %s", async (change) => {
    const f = fixture();
    if (change === "actor") f.actor.userId = "foreign";
    if (change === "space") f.actor.spaceId = "foreign";
    if (change === "thread") f.message.threadId = "foreign";
    if (change === "effect-run") f.approval.runId = "foreign";
    if (change === "effect-bot") f.approval.run.botId = "foreign";
    if (change === "source-bot") f.source.run.botId = "foreign";
    if (change === "source-status") f.source.status = "intended";
    if (change === "source-route") f.source.request = {} as typeof f.source.request;
    if (change === "role") f.role.id = "foreign";
    if (change === "revision") f.role.currentRevision.revision = 3;
    if (change === "binding") f.role.crmBindingEffectId = "foreign";
    if (change === "persisted-card") f.persistedMessage.blocks[0]!.approvalEffectId = "foreign";
    expect(
      (await projectRecruitingApprovalFiles(f.prisma, f.actor, "thread", [f.message]))[0],
    ).toEqual(f.message);
  });

  it("uses identical trusted presentation for SSE and ignores injected display labels", async () => {
    const f = fixture();
    const event: ProductEvent = {
      id: "event",
      spaceId: "space",
      threadId: "thread",
      runId: "run",
      botId: "bot",
      seq: 3,
      type: "thread.message.updated",
      createdAt: "2026-10-20T00:00:00.000Z",
      payload: {
        messageId: "card",
        role: "bot",
        blocks: [{ ...f.ask, text: "Forged role", detail: "Forged client" }],
      },
    };
    const before = structuredClone(event);
    const shown = await projectRecruitingApprovalEvent(f.prisma, f.actor, "thread", event);
    expect(shown.payload.blocks).toEqual(
      (await projectRecruitingApprovalFiles(f.prisma, f.actor, "thread", [f.message]))[0]!.blocks,
    );
    expect(event).toEqual(before);
  });
});

describe("native approval file previews", () => {
  function fixture() {
    const actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const ref = { artifactId: "jd-artifact", sha256: "a".repeat(64) };
    const request = {
      stage: "documents",
      roleId: "role",
      expectedRoleRevision: 5,
      documents: {
        jdText: ref,
        namedPdf: { artifactId: "pdf-artifact", sha256: "b".repeat(64) },
        anonymousPdf: null,
        deck: null,
      },
    };
    const source = {
      id: "actual-source",
      kind: "original_material",
      anchor: { kind: "artifact", artifact: ref, locator: "text" },
      readState: "read",
      readAt: "2026-10-20T00:00:00.000Z",
      quote: "Exact requirements",
    };
    const role = {
      id: "role",
      revision: 5,
      currentRevisionId: "revision-5",
      currentRevision: {
        id: "revision-5",
        roleId: "role",
        revision: 5,
        sourceRefs: [source],
        criteria: [],
      },
    };
    const file = {
      kind: "file" as const,
      artifactId: ref.artifactId,
      name: "original.json",
      mimeType: "application/json",
      size: 42,
    };
    const pdf = {
      kind: "file" as const,
      artifactId: "pdf-artifact",
      name: "Original.pdf",
      mimeType: "application/pdf",
      size: 100,
    };
    const message = {
      id: "card",
      threadId: "thread",
      runId: "run",
      botId: "bot",
      role: "bot" as const,
      blocks: [
        file,
        pdf,
        {
          kind: "ask" as const,
          text: "Review documents",
          status: "pending" as const,
          approvalEffectId: "approval",
        },
      ],
    };
    const effects = [
      { id: "approval", runId: "run", status: "intended", request, run: { botId: "bot" } },
    ];
    const externalEffect = {
      findMany: vi.fn(
        async (_query: { where: { run: { userId: string }; spaceId: string } }) => effects,
      ),
    };
    const thread = { findFirst: vi.fn(async () => ({ activeRecruitingRole: role })) };
    const artifactRow = {
      id: ref.artifactId,
      hash: ref.sha256,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    };
    const artifact = { findMany: vi.fn(async () => [artifactRow]) };
    const prisma = { externalEffect, thread, artifact } as unknown as PrismaClient;
    const read = (messages = [message], requestActor = actor) =>
      projectRecruitingApprovalFiles(prisma, requestActor, "thread", messages);
    return {
      actor,
      ref,
      request,
      source,
      role,
      file,
      pdf,
      message,
      effects,
      externalEffect,
      thread,
      artifact,
      prisma,
      read,
    };
  }

  it("adds an exact existing source target without changing the persisted card or original file fields", async () => {
    const f = fixture();
    const before = structuredClone(f.message);
    const [message] = await f.read();
    expect(message!.blocks[0]).toEqual({
      ...f.file,
      preview: {
        label: "Job description",
        source: {
          kind: "role",
          threadId: "thread",
          roleRevisionId: "revision-5",
          sourceRefId: "actual-source",
        },
      },
    });
    expect(message!.blocks.slice(1)).toEqual(f.message.blocks.slice(1));
    expect(f.message).toEqual(before);
    expect(f.externalEffect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space",
          kind: { in: ["recruiting_request_approval", "recruiting_crm_target"] },
          run: expect.objectContaining({ userId: "owner", spaceId: "space", threadId: "thread" }),
        }),
      }),
    );
    expect(f.artifact.findMany).toHaveBeenCalledOnce();
    expect(f.thread.findFirst).toHaveBeenCalledOnce();
  });

  it.each([
    "revision",
    "role",
    "unread",
    "quote",
    "locator",
    "source-hash",
    "source-id-conflict",
    "source-kind",
  ])("keeps the plain file card without a readable source for %s", async (change) => {
    const f = fixture();
    if (change === "revision") f.role.revision = 6;
    if (change === "role") f.role.id = "other-role";
    if (change === "unread") {
      f.source.readState = "unread";
      f.source.readAt = null as unknown as string;
    }
    if (change === "quote") f.source.quote = "";
    if (change === "locator") f.source.anchor.locator = "different-field";
    if (change === "source-hash") f.source.anchor.artifact = { ...f.ref, sha256: "c".repeat(64) };
    if (change === "source-id-conflict")
      f.role.currentRevision.sourceRefs.push({
        ...f.source,
        quote: "Different source with the same id",
      });
    if (change === "source-kind")
      Object.assign(f.source.anchor, { kind: "message", messageId: "message", locator: "text" });
    const [message] = await f.read();
    expect(message!.blocks[0]).toEqual(f.file);
  });

  it("inherits only the exact completed documents request for a calibration card", async () => {
    const f = fixture();
    const documents = {
      ...f.effects[0]!,
      id: "documents",
      runId: "documents-run",
      status: "completed",
      run: { botId: "documents-bot" },
    };
    Object.assign(f.effects[0]!, {
      request: {
        stage: "calibration",
        roleId: "role",
        expectedRoleRevision: 5,
        documentsApprovalEffectId: "documents",
        ruleChanges: [],
        profiles: Array.from({ length: 10 }, (_, i) => ({
          candidateKey: `candidate-${i}`,
          linkedinUrl: `https://www.linkedin.com/in/person-${i}`,
          evidenceUrl: `https://example.test/person-${i}`,
          source: {
            providerTaskId: "provider-task",
            roleRevisionId: "revision-5",
            effectId: "saved-page",
            rowIndex: i,
            artifactRef: f.ref,
          },
        })),
      },
    });
    f.externalEffect.findMany.mockResolvedValueOnce(f.effects).mockResolvedValueOnce([documents]);
    expect((await f.read())[0]!.blocks[0]).toMatchObject({
      preview: { source: { sourceRefId: "actual-source" } },
    });
    expect(f.externalEffect.findMany).toHaveBeenCalledTimes(2);
    documents.request = { ...f.request, roleId: "other-role" };
    f.externalEffect.findMany.mockResolvedValueOnce(f.effects).mockResolvedValueOnce([documents]);
    expect((await f.read())[0]!.blocks[0]).toEqual(f.file);
  });

  it.each([
    "missing-effect",
    "run",
    "bot",
    "file-hash",
    "file-fields",
    "foreign-actor",
    "foreign-space",
    "foreign-thread",
  ])("does not trust a forged or out-of-scope %s", async (change) => {
    const f = fixture();
    const actor = { ...f.actor };
    if (change === "missing-effect") f.effects.splice(0);
    if (change === "run") f.effects[0]!.runId = "other-run";
    if (change === "bot") f.effects[0]!.run.botId = "other-bot";
    if (change === "file-hash")
      f.artifact.findMany.mockResolvedValue([
        {
          id: f.ref.artifactId,
          hash: "c".repeat(64),
          name: f.file.name,
          mimeType: f.file.mimeType,
          size: f.file.size,
        },
      ]);
    if (change === "file-fields") f.file.size++;
    if (change === "foreign-actor") actor.userId = "foreign";
    if (change === "foreign-space") actor.spaceId = "foreign";
    if (change === "foreign-thread") f.message.threadId = "foreign";
    if (change === "foreign-actor" || change === "foreign-space")
      f.externalEffect.findMany.mockImplementation(
        async ({ where }: { where: { run: { userId: string }; spaceId: string } }) =>
          where.run.userId === "owner" && where.spaceId === "space" ? f.effects : [],
      );
    const [message] = await f.read([f.message], actor);
    expect(message!.blocks[0]).not.toHaveProperty("preview");
  });

  it("strips untrusted preview metadata and makes no reads for ordinary files or messages", async () => {
    const f = fixture();
    const forged = { ...f.file, preview: { label: "Forged", source: null } };
    const [message] = await f.read([{ ...f.message, blocks: [forged] }]);
    expect(message!.blocks).toEqual([f.file]);
    expect(f.externalEffect.findMany).not.toHaveBeenCalled();
    expect(f.thread.findFirst).not.toHaveBeenCalled();
    expect(f.artifact.findMany).not.toHaveBeenCalled();
  });

  it("batches multiple attachments and cards in the same page", async () => {
    const f = fixture();
    await f.read([f.message, { ...f.message, id: "second-card" }]);
    expect(f.externalEffect.findMany).toHaveBeenCalledOnce();
    expect(f.artifact.findMany).toHaveBeenCalledOnce();
    expect(f.thread.findFirst).toHaveBeenCalledOnce();
  });

  it.each(["thread.message.created", "thread.message.updated"] as const)(
    "projects %s with original event, card and approval identity",
    async (type) => {
      const f = fixture();
      const event: ProductEvent = {
        id: "event",
        spaceId: "space",
        threadId: "thread",
        botId: "bot",
        runId: "run",
        seq: 4,
        type,
        createdAt: "2026-10-20T00:00:00.000Z",
        payload: {
          messageId: "card",
          role: "bot",
          blocks: [
            { ...f.file, preview: { label: "Forged", source: null } },
            ...f.message.blocks.slice(1),
          ],
        },
      };
      const before = structuredClone(event);
      const projected = await projectRecruitingApprovalEvent(f.prisma, f.actor, "thread", event);
      expect(projected).toEqual({
        ...event,
        payload: { ...event.payload, blocks: (await f.read())[0]!.blocks },
      });
      expect((projected.payload.blocks as typeof f.message.blocks)[2]).toEqual(f.message.blocks[2]);
      expect(event).toEqual(before);
    },
  );

  it("strips forged live preview without querying non-native or foreign events", async () => {
    const f = fixture();
    const blocks = [{ ...f.file, preview: { label: "Forged", source: null } }];
    for (const spaceId of ["space", "foreign"]) {
      const event: ProductEvent = {
        id: "event",
        spaceId,
        threadId: "thread",
        botId: "bot",
        runId: "run",
        seq: 4,
        type: "thread.message.created",
        createdAt: "2026-10-20T00:00:00.000Z",
        payload: { messageId: "card", role: "bot", blocks },
      };
      expect(
        (await projectRecruitingApprovalEvent(f.prisma, f.actor, "thread", event)).payload.blocks,
      ).toEqual([f.file]);
    }
    expect(f.externalEffect.findMany).not.toHaveBeenCalled();
  });
});

describe("thread message pages", () => {
  it("keeps the base page and cursor unchanged when its waiting card is already loaded", async () => {
    const page = {
      threadId: "thread-1",
      olderCursor: 101,
      messages: [
        {
          id: "original-card",
          threadId: "thread-1",
          seq: 150,
          role: "bot" as const,
          runId: "run-1",
          botId: "bot-1",
          blocks: [{ kind: "ask" as const, text: "Original question", status: "pending" as const }],
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
    const findMany = vi.fn();
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    const result = await includeWaitingAskMessages(prisma, page, [
      {
        id: "run-1",
        botId: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        status: "waiting_input",
      },
    ]);
    expect(result).toBe(page);
    expect(result.messages).toHaveLength(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("caches peer-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "bot_message" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("forwards peer waiting, ask, and text events on an open thread", () => {
    expect(shouldForwardPeerThreadEvent({ type: "run.waiting_input", payload: {} })).toBe(true);
    expect(shouldForwardPeerThreadEvent({ type: "computer.takeover.requested", payload: {} })).toBe(
      true,
    );
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "ask", text: "Pick one" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "peer body" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.progress",
        payload: {},
      }),
    ).toBe(false);
  });

  it("caches background-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "tickets" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isBackgroundRun(prisma, "run-ticket", cache)).resolves.toBe(true);
    await expect(isBackgroundRun(prisma, "run-ticket", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("forwards only explicit user contact from a background run", () => {
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "Working" }] },
      }),
    ).toBe(false);
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "ask", text: "Pick one" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "computer", text: "Needs you" }] },
      }),
    ).toBe(true);
    for (const type of ["thread.message.created", "thread.message.updated"]) {
      expect(
        shouldForwardBackgroundThreadEvent({
          type,
          payload: { blocks: [{ kind: "mcp_approval" }] },
        }),
      ).toBe(true);
    }
    expect(shouldForwardBackgroundThreadEvent({ type: "run.started", payload: {} })).toBe(false);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.waiting_input", payload: {} })).toBe(
      true,
    );
    expect(
      shouldForwardBackgroundThreadEvent({ type: "computer.takeover.requested", payload: {} }),
    ).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.completed", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.failed", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.cancelled", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "thread.progress", payload: {} })).toBe(
      false,
    );
  });

  it("hides ticket-run output from the transcript but keeps user-input cards", async () => {
    const rows = [
      {
        id: "message-computer",
        blocks: [{ kind: "computer", state: "Needs you", text: "Sign in" }],
      },
      { id: "message-approval", blocks: [{ kind: "mcp_approval" }] },
      { id: "message-final", blocks: [{ kind: "text", text: "Closed the ticket." }] },
      {
        id: "message-steps",
        blocks: [{ kind: "steps", steps: [{ label: "Ticket comment", count: 1 }] }],
      },
      { id: "message-user", blocks: [{ kind: "text", text: "Visible answer" }] },
    ].map((row, index) => ({
      ...row,
      threadId: "thread-1",
      seq: 4 - index,
      role: "bot",
      botId: "bot-1",
      replyToMessageId: null,
      runId: row.id === "message-user" ? "run-user" : "run-ticket",
      clientNonce: null,
      createdAt: new Date("2026-08-16T00:00:01.000Z"),
    }));
    const findMany = vi.fn(async () => rows);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-ticket", trigger: "tickets" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 6);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-approval",
      "message-computer",
    ]);
  });

  it("keeps peer receipt rows when filtering peer-run output from pages", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-reply",
        threadId: "thread-1",
        seq: 3,
        role: "bot",
        blocks: [{ kind: "text", text: "Echoed peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-received",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-received",
      "message-reply",
    ]);
  });

  it("filters peer-run activity when its receipt is outside the loaded page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
  });

  it("keeps peer text around-page targets and omits peer activity", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-activity",
        threadId: "thread-1",
        seq: 5,
        role: "bot",
        blocks: [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-target",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 1);
    const runFindMany = vi.fn(async () => [{ id: "run-peer" }]);
    const prisma = {
      message: { findMany, count },
      run: { findMany: runFindMany },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-target",
      seq: 6,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-target",
    ]);
    expect(runFindMany).toHaveBeenCalled();
  });

  it("keeps peer receipt and text around-page targets in the normal transcript page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-receipt",
        threadId: "thread-1",
        seq: 5,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-text",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 0);
    const prisma = {
      message: { findMany, count },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-receipt",
      seq: 5,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-receipt",
      "message-peer-text",
    ]);
  });

  it("returns peer-run output for the dedicated bot messages view", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany, count: vi.fn(async () => 0) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(
      prisma,
      "thread-1",
      undefined,
      2,
      { messageId: "message-peer", seq: 1 },
      true,
    );

    expect(page.messages.map((message) => message.id)).toEqual(["message-peer"]);
  });

  it("scans past a page containing only hidden peer-run activity", async () => {
    const row = (seq: number, runId: string, kind: "text" | "steps" = "text") => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks:
        kind === "steps"
          ? [{ kind: "steps", steps: [{ label: String(seq), count: 1 }] }]
          : [{ kind: "text", text: String(seq) }],
      botId: "bot-1",
      replyToMessageId: null,
      runId,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        row(4, "run-peer", "steps"),
        row(3, "run-peer", "steps"),
        row(2, "run-peer", "steps"),
      ])
      .mockResolvedValueOnce([row(1, "run-user")]);
    const prisma = {
      message: { findMany },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-peer" }])
          .mockResolvedValueOnce([]),
      },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-1"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("scans past a receipt-only page so web can reach older user-visible rows", async () => {
    const receiptRows = [
      {
        id: "message-receipt-b",
        threadId: "thread-1",
        seq: 3,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-receipt-a",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-2",
            toBotName: "Coder",
            text: "Check this.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-lookahead",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const olderRows = [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const findMany = vi.fn().mockResolvedValueOnce(receiptRows).mockResolvedValueOnce(olderRows);
    const prisma = {
      message: { findMany },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-peer" }])
          .mockResolvedValueOnce([]),
      },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns a receipt-only page when the client displays peer receipts", async () => {
    const receipt = (seq: number) => ({
      id: `message-receipt-${seq}`,
      threadId: "thread-1",
      seq,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Coder",
          text: "Done.",
        },
      ],
      botId: null,
      replyToMessageId: null,
      runId: "run-peer",
      createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
    });
    const findMany = vi.fn(async () => [receipt(3), receipt(2), receipt(1)]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2, undefined, false, true);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-receipt-2",
      "message-receipt-3",
    ]);
    expect(page.olderCursor).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("queries before the cursor and returns an ascending bounded page", async () => {
    const findMany = vi.fn(async () =>
      [5, 4, 3].map((seq) => ({
        id: `message-${seq}`,
        threadId: "thread-1",
        seq,
        role: "bot",
        blocks: [{ kind: "text", text: String(seq) }],
        runId: null,
        createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
      })),
    );
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 6, 2);

    expect(findMany).toHaveBeenCalledWith({
      include: {
        replyTo: { select: { threadId: true, role: true, botId: true, blocks: true } },
      },
      where: { threadId: "thread-1", seq: { lt: 6 } },
      orderBy: { seq: "desc" },
      take: 3,
    });
    expect(page.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(page.olderCursor).toBe(4);
  });

  it("ends pagination when the database returns no lookahead row", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-0",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        blocks: [],
        runId: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 1, 2);

    expect(page.messages.map((message) => message.seq)).toEqual([0]);
    expect(page.olderCursor).toBeNull();
  });

  it("loads a page around a target sequence", async () => {
    const findFirst = vi.fn(async () => ({ seq: 5 }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "message-3",
          threadId: "thread-1",
          seq: 3,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-4",
          threadId: "thread-1",
          seq: 4,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-5",
          threadId: "thread-1",
          seq: 5,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
      ])
      .mockResolvedValueOnce(1);
    const count = vi.fn(async () => 1);
    const prisma = {
      message: { findFirst, findMany, count },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, { seq: 5 });

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(page.olderCursor).toBe(3);
    expect(page.coveredThroughSeq).toBe(7);
    expect(findMany).toHaveBeenCalledWith({
      include: {
        replyTo: { select: { threadId: true, role: true, botId: true, blocks: true } },
      },
      where: { threadId: "thread-1", seq: { gte: 3, lte: 7 } },
      orderBy: { seq: "asc" },
      take: 4,
    });
  });

  it("collects bounded pages into chronological export order", async () => {
    const row = (seq: number) => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks: [],
      runId: null,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row(4), row(3), row(2)])
      .mockResolvedValueOnce([row(2), row(1), row(0)])
      .mockResolvedValueOnce([row(0)]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const messages = await loadAllMessages(prisma, "thread-1", 2);

    expect(messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(findMany.mock.calls.map(([query]) => query.where.seq?.lt)).toEqual([undefined, 3, 1]);
  });

  it("derives callId from a call client nonce and leaves plain messages without one", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-call",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [{ kind: "text", text: "Hey" }],
        botId: null,
        replyToMessageId: null,
        replyQuote: null,
        runId: null,
        clientNonce: "call:call-1:abc",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-plain",
        threadId: "thread-1",
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Typed" }],
        botId: null,
        replyToMessageId: null,
        replyQuote: null,
        runId: null,
        clientNonce: "plain-nonce",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.callId)).toEqual([undefined, "call-1"]);
  });
});

describe("authoritative reply previews", () => {
  it("serializes a parent outside the loaded page and marks deleted parents unavailable", async () => {
    const base = {
      threadId: "thread-1",
      role: "user",
      botId: null,
      runId: null,
      createdAt: new Date(),
      blocks: [{ kind: "text", text: "My reply" }],
    };
    const parent = {
      threadId: "thread-1",
      role: "bot",
      botId: "bot-1",
      blocks: [{ kind: "text", text: "**First** line\n\nSecond line" }],
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        ...base,
        id: "reply-2",
        seq: 2,
        replyToMessageId: null,
        replyQuote: "First line",
        replyTo: null,
      },
      {
        ...base,
        id: "reply-1",
        seq: 1,
        replyToMessageId: "older-parent",
        replyQuote: null,
        replyTo: parent,
      },
    ]);
    const page = await loadMessagePage(
      { message: { findMany } } as unknown as PrismaClient,
      "thread-1",
      undefined,
      100,
    );
    expect(page.messages[0]?.replyPreview).toEqual({
      role: "bot",
      botId: "bot-1",
      text: "First line",
    });
    expect(page.messages[1]?.replyPreview).toBeNull();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1" },
        include: {
          replyTo: { select: { threadId: true, role: true, botId: true, blocks: true } },
        },
      }),
    );
  });
  it("does not expose a parent from another thread", async () => {
    const row = {
      id: "reply",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      blocks: [],
      botId: null,
      runId: null,
      createdAt: new Date(),
      replyToMessageId: "foreign",
      replyQuote: null,
      replyTo: {
        threadId: "other",
        role: "bot",
        botId: "other-bot",
        blocks: [{ kind: "text", text: "Private text" }],
      },
    };
    const page = await loadMessagePage(
      { message: { findMany: vi.fn().mockResolvedValue([row]) } } as unknown as PrismaClient,
      "thread-1",
      undefined,
      100,
    );
    expect(page.messages[0]?.replyPreview).toBeNull();
    expect(JSON.stringify(page)).not.toContain("Private text");
  });
});

describe("reply target validation", () => {
  it.each([
    ["malformed text", [{ kind: "text", text: 12 }], null],
    ["null block", [null], null],
    ["non-array", {}, null],
    ["ask", [{ kind: "ask", text: "Which release?" }], "Which release?"],
    [
      "channel message",
      [
        {
          kind: "channel_message",
          provider: "test",
          channelId: "channel",
          fromAddress: "sender",
          fromLabel: "Sender",
          text: "Release notes",
        },
      ],
      "Release notes",
    ],
    [
      "chart",
      [{ kind: "chart", name: "Release adoption", spec: {}, data: [] }],
      "Release adoption",
    ],
  ])("serializes an outside-page %s target safely", async (_kind, blocks, text) => {
    const row = {
      id: "reply",
      threadId: "thread-1",
      seq: 100,
      role: "user",
      blocks: [{ kind: "text", text: "Follow up" }],
      botId: null,
      runId: null,
      createdAt: new Date("2026-10-08T12:00:00Z"),
      replyToMessageId: "older-parent",
      replyQuote: null,
      replyTo: { id: "older-parent", threadId: "thread-1", role: "bot", botId: "bot-1", blocks },
    };
    const prisma = {
      message: { findMany: vi.fn().mockResolvedValue([row]), count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;
    for (const around of [undefined, { seq: 100 }]) {
      const page = await loadMessagePage(prisma, "thread-1", undefined, 1, around);
      expect(page.messages.map((message) => message.id)).toEqual(["reply"]);
      expect(page.messages[0]?.replyPreview).toEqual(
        text === null ? null : { role: "bot", botId: "bot-1", text },
      );
    }
  });
});

it("derives attachment metadata from a validated parent outside the loaded page", async () => {
  const image = { kind: "image", artifactId: "parent-photo", name: "", mimeType: "image/png" };
  const row = {
    id: "reply",
    threadId: "thread",
    seq: 100,
    role: "user",
    blocks: [],
    botId: null,
    runId: null,
    createdAt: new Date(),
    replyToMessageId: "parent",
    replyQuote: null,
    replyTo: { threadId: "thread", role: "user", botId: null, blocks: [image] },
  };
  const prisma = {
    message: { findMany: vi.fn().mockResolvedValue([row]), count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaClient;
  const page = await loadMessagePage(prisma, "thread", undefined, 1);
  expect(page.messages[0]?.replyPreview).toEqual({ role: "user", text: "", attachment: image });
});

describe("provider names in saved messages", () => {
  const actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const saved = {
    id: "message",
    threadId: "thread",
    runId: "run",
    botId: "bot",
    role: "bot" as const,
    blocks: [{ kind: "text" as const, text: "已回复到同一个 Autumn 任务。" }],
  };
  const prismaFor = (thread: unknown) =>
    ({ thread: { findUnique: vi.fn(async () => thread) } }) as unknown as PrismaClient;

  it("hides them in a recruiting conversation saved before the write-side filter", async () => {
    const [shown] = await projectRecruitingApprovalFiles(
      prismaFor({ activeRecruitingRoleId: null, bot: { spawnKey: "recruiting:owner:main" } }),
      actor,
      "thread",
      [saved],
    );
    expect(shown!.blocks).toEqual([{ kind: "text", text: "已回复到同一个人才搜索任务。" }]);
  });

  it("keeps them in other conversations and skips the lookup when nothing would change", async () => {
    const prisma = prismaFor({
      activeRecruitingRoleId: null,
      bot: { spawnKey: null },
      group: null,
    });
    expect(
      (await projectRecruitingApprovalFiles(prisma, actor, "thread", [saved]))[0]!.blocks,
    ).toEqual(saved.blocks);
    const plain = { ...saved, blocks: [{ kind: "text" as const, text: "已回复。" }] };
    const quiet = prismaFor(null);
    await projectRecruitingApprovalFiles(quiet, actor, "thread", [plain]);
    expect(quiet.thread.findUnique).not.toHaveBeenCalled();
  });
});
