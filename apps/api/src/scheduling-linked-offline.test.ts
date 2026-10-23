// @vitest-environment jsdom
import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ConnectorCall,
  ConnectorProvider,
  MemorySnapshot,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import { createRunExecutor } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { answerRunInput, getRecruitingWorkspace } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { runInstantlyWrite } from "../../../packages/adapters/src/instantly-native-writes.js";
import { getRecruitingWorkspace as getPlanWorkspace } from "../../../packages/db/src/recruiting.js";
import {
  createRecruitingSchedulingPlan,
  loadVerifiedRecruitingSchedulingPlan,
} from "../../../packages/db/src/recruiting-scheduling.js";
import { getRecruitingCorrespondence } from "./recruiting.js";

vi.mock("../../../packages/db/src/recruiting.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getRecruitingWorkspace: vi.fn(),
}));

vi.mock("../../../packages/adapters/src/recruiting-context.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadRecruitingRunContext: vi.fn(),
}));
vi.mock("../../../packages/adapters/src/computer-lifecycle.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  acquireComputerExecutionLease: vi.fn(async () => null),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));
vi.mock("../../../packages/adapters/src/computer-workspace.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  checkpointRunComputerWorkspace: vi.fn(async () => "home-revision"),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getRecruitingWorkspace: vi.fn(),
}));

import { renderSchedulingProjection } from "../../web/src/pages/recruiting/scheduling-offline-render.test-support";

// Isolated executor fixture adapted from executor-effect-idempotency.test.ts.
// Provider/model responses and persistence are synthetic. Approval decisions, execution,
// idempotency, receipt parsing and correspondence projection use production functions.
type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(
  runId = "run-1",
  secrets: string[] = [],
  options: {
    contextStrategy?: AgentRunRequest["contextStrategy"];
    attachmentStore?: boolean;
    shutdownSignal?: AbortSignal;
  } = {},
) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const sourceMessages: Array<{ id: string; seq: number }> = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    leaseOwner: null as string | null,
    leaseExpiresAt: null as Date | null,
    checkpoint: null as string | null,
    sourceMessageId: null as string | null,
    initialRecruitingRoleRevision: { roleId: "role-1" },
  };
  const thread = {
    id: run.threadId,
    spaceId: run.spaceId,
    userId: run.userId,
    groupId: null,
    activeRecruitingRoleId: null as string | null,
  };
  const memoryCommit = vi.fn(async () => ({ path: "MEMORY.md", revision: 1 }));
  const memoryRead = vi.fn(
    async (_request: { scope: "bot" | "user" }): Promise<MemorySnapshot> => ({ documents: [] }),
  );
  const semanticSave = vi.fn<SemanticMemoryProvider["save"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const semanticMemory: SemanticMemoryProvider = {
    describe: () => ({
      id: "test-memory",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
    }),
    recall: async () => ({ ok: true, value: [] }),
    save: semanticSave,
    purgeHistory: async () => ({ ok: true, value: undefined }),
  };
  const memoryProviderResolve = vi.fn<MemoryProviderResolver["resolve"]>(async () => null);
  const disabledBuiltinTools: string[] = [];
  const artifacts = {
    describe: () => ({ capabilities: { stream: false } }),
    put: vi.fn(async () => ({ id: "stored-context", hash: "a".repeat(64) })),
    get: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
        orderBy,
      }: {
        orderBy?: unknown;
        where?: {
          id?: string;
          spaceId?: string;
          runId?: string;
          status?: string | { in: string[] };
          kind?: string;
          createdAt?: { gte: Date };
        };
      } = {}) =>
        (orderBy ? [...effects].reverse() : effects)
          .filter((effect) => {
            if (typeof where?.status === "string" && effect.status !== where.status) return false;
            if (
              where?.status &&
              typeof where.status === "object" &&
              !where.status.in.includes(effect.status)
            )
              return false;
            if (where?.kind && effect.kind !== where.kind) return false;
            if (where?.spaceId && effect.spaceId !== where.spaceId) return false;
            if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
            if (where?.id && effect.id !== where.id) return false;
            if (where?.createdAt && (!effect.createdAt || effect.createdAt < where.createdAt.gte))
              return false;
            return true;
          })
          .map((effect) => ({ ...effect, run: { ...run } })),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = {
        ...data,
        id: `effect-${effects.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      return Object.assign(effects.find((effect) => effect.id === where.id)!, data, {
        updatedAt: new Date(),
      });
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    ),
  };
  const published: Array<{ role: string; blocks: unknown }> = [];
  const prisma = {
    $queryRaw: vi.fn(async () => [] as Array<Record<string, unknown>>),
    // Durable mid-turn and early-final messages go through one transaction on these rows.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    event: {
      findMany: vi.fn(async () => [] as Array<{ seq: number; type: string; payload: unknown }>),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, seq: 1 })),
    },
    run: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(
        async ({
          data,
        }: {
          where: {
            status?: string | { in?: string[] };
            leaseOwner?: string | null;
            leaseFence?: number;
            checkpoint?: string | null | { in?: (string | null)[] };
          };
          data: Record<string, unknown>;
        }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        spaceId: run.spaceId,
        userId: run.userId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        disabledBuiltinTools,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => thread),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
    },
    message: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) =>
        select?.id && select.seq && Object.keys(select).length === 2 ? sourceMessages : [],
      ),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { role: string; blocks: unknown } }) => {
        published.push({ role: data.role, blocks: data.blocks });
        return { id: `message-${published.length}`, ...data };
      }),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async (): Promise<ActionApprovalRule[]> => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    artifact: {
      findFirst: vi.fn(),
      findMany: vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []),
    },
  };
  const pauseRunForInput = vi.fn<ThreadEvents["pauseRunForInput"]>(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn<ThreadEvents["finalizeRun"]>(async () => ({ continuationRunId: null }));
  const claimSteering = vi.fn<ThreadEvents["claimSteering"]>(async () => []);
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
    _context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent> {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const connector = {
    discoverTools: vi.fn<ConnectorProvider["discoverTools"]>(async () => []),
    resolveCall: vi.fn<NonNullable<ConnectorProvider["resolveCall"]>>(async () => undefined),
    execute: vi.fn<ConnectorProvider["execute"]>(async function* () {}),
  };
  const web = {
    search: vi.fn(async () => []),
    fetch: vi.fn(async () => ({
      url: "https://example.org/profile",
      title: "Public profile",
      text: "Public evidence",
      truncated: false,
    })),
  };
  const sandbox = {
    describe: () => ({ capabilities: { graphical: false } }),
    writeFile: vi.fn(async () => undefined),
  };
  const executorDeps = {
    contextStrategy: options.contextStrategy,
    web,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector,
    sandbox,
    memory: {
      describe: () => ({ capabilities: {} }),
      read: memoryRead,
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: memoryProviderResolve },
    artifacts: options.attachmentStore === false ? undefined : artifacts,
    events: {
      append: vi.fn(async () => undefined),
      publishTransient: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput,
      finalizeRun,
      claimSteering,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    shutdownSignal: options.shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0];
  const executor = createRunExecutor(executorDeps);

  return {
    effects,
    published,
    executor,
    executorDeps,
    results,
    web,
    sandbox,
    sourceMessages,
    scratchpadRows,
    memoryCommit,
    memoryRead,
    memoryProviderResolve,
    semanticMemory,
    semanticSave,
    artifacts,
    prisma,
    runData: run,
    thread,
    runtimeRun,
    claimSteering,
    pauseRunForInput,
    finalizeRun,
    disabledBuiltinTools,
    connector,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run(expectedError?: string) {
      run.status = "queued";
      finalizeRun.mockClear();
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      if (expectedError) {
        expect(finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed", error: expectedError }),
        );
      } else {
        expect(finalizeRun, JSON.stringify(results)).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed" }),
        );
      }
    },
  };
}

describe("linked offline scheduling receipts", () => {
  it.each([
    "success",
    "booking_conflict",
    "confirmation_uncertain",
    "confirmation_rejected",
    "dst_first_0130",
    "dst_second_0130",
    "reschedule_success",
    "cancel_success",
    "reschedule_changed_original",
    "reschedule_slot_conflict",
    "reschedule_timeout",
    "cancel_timeout",
    "reschedule_confirmation_rejected",
  ] as const)("links native approvals, receipts and Interview for %s", async (scenario) => {
    const f = fixture("linked-scheduling");
    const usesPlan = [
      "success",
      "dst_first_0130",
      "dst_second_0130",
      "confirmation_uncertain",
    ].includes(scenario);
    let planId: string | undefined;
    const db = f.prisma as unknown as PrismaClient;
    const messages: Array<{
      id: string;
      threadId: string;
      runId: string;
      role: string;
      blocks: MessageBlock[];
    }> = [];
    const events: Array<Record<string, unknown>> = [];
    let sequence = 10;
    // Persist the exact native cards emitted by the executor. Approval answers below
    // use answerRunInput; no test assignment changes an effect to approved.
    f.pauseRunForInput.mockImplementation(async (input) => {
      f.runData.status = "waiting_input";
      messages.push({
        id: `card-${messages.length}`,
        threadId: f.runData.threadId,
        runId: f.runData.id,
        role: "bot",
        blocks: input.blocks,
      });
      return true;
    });
    Object.assign(f.prisma.run, {
      findFirst: vi.fn(async () => (f.runData.status === "waiting_input" ? f.runData : null)),
    });
    Object.assign(f.prisma.message, {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          messages.find((message) =>
            Object.entries(where).every(
              ([key, value]) => message[key as keyof typeof message] === value,
            ),
          ) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) =>
          Object.assign(messages.find((message) => message.id === where.id)!, data),
      ),
    });
    const effectReads = Object.assign(f.prisma.externalEffect, {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          f.effects.find((effect) =>
            Object.entries(where).every(([key, value]) => effect[key as keyof Effect] === value),
          ) ?? null,
      ),
    });
    f.prisma.thread.update.mockImplementation(async () => ({
      nextMessageSeq: ++sequence,
      nextEventSeq: ++sequence,
    }));
    f.prisma.event.findMany.mockImplementation(async ({ where }) =>
      where?.type === "effect.approval.answered"
        ? (events.filter((event) => event.type === where.type) as never)
        : [],
    );
    f.prisma.event.create.mockImplementation(async ({ data }) => {
      const row = { ...data, seq: sequence };
      events.push(row);
      return row;
    });
    const server = {
      id: "cal-1",
      revision: 3,
      name: "Cal.com",
      enabled: true,
      endpoint: "https://mcp.cal.com/mcp?toolsets=bookings,availability",
      secretId: "synthetic-reference",
      assignments: [
        {
          botId: f.runData.botId,
          allowAllTools: false,
          allowedTools: [
            "create_booking",
            "get_booking",
            "get_bookings",
            "get_availability",
            "reschedule_booking",
            "cancel_booking",
          ],
        },
      ],
    };
    const sourceStore = {
      botMcpServer: {
        findFirst: vi.fn(async (_input: { where: { serverId?: string } }) => ({
          ...server.assignments[0]!,
          server,
        })),
      },
      mcpServer: { findMany: vi.fn(async () => [server]) },
    };
    Object.assign(f.prisma, sourceStore);
    Object.assign(f.prisma.thread, { findFirst: vi.fn(async () => f.thread) });
    const mail = {
      name: "native_instantly_reply_to_email",
      description: "Reply to the original email",
      readOnly: false,
      inputSchema: { type: "object" },
      route: { connectorId: "mcp", toolName: "native_instantly_reply_to_email" },
    };
    const cal = (toolName: string) => ({
      name: `mcp__cal__${toolName}`,
      description: toolName,
      readOnly: true,
      inputSchema: { type: "object" },
      route: {
        connectorId: "mcp",
        resourceId: server.id,
        resourceRevision: server.revision,
        toolName,
      },
    });
    const createBooking = cal("create_booking");
    const listBookings = cal("get_bookings");
    const getBooking = {
      ...cal("get_booking"),
      inputSchema: { type: "object", properties: { bookingUid: { type: "string" } } },
    };
    const rescheduleBooking = cal("reschedule_booking");
    const cancelBooking = cal("cancel_booking");
    const availability = {
      ...cal("get_availability"),
      inputSchema: {
        type: "object",
        properties: {
          eventTypeId: { type: "number" },
          start: { type: "string" },
          end: { type: "string" },
          timeZone: { type: "string" },
          duration: { type: "number" },
          format: { type: "string" },
          bookingUidToReschedule: { type: "string" },
        },
      },
    };
    f.connector.discoverTools.mockResolvedValue([
      mail,
      createBooking,
      getBooking,
      listBookings,
      availability,
      rescheduleBooking,
      cancelBooking,
    ]);
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: mail.name },
    ]);
    const recipient = "candidate@example.test";
    const originalEmail = {
      id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
      thread_id: "synthetic-original-thread",
      eaccount: "recruiter@example.test",
      subject: "Interview",
      from_address_email: recipient,
    };
    // Exercise the real reply adapter against a synthetic provider, not a fictional
    // Gmail schema or a claim about live delivery.
    const planActor = {
      userId: f.runData.userId,
      spaceId: f.runData.spaceId,
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const originalRead = {
      name: "original_email_read",
      description: "Read exact original",
      readOnly: true,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      route: {
        connectorId: "mcp",
        resourceId: "mail-source",
        resourceRevision: 2,
        toolName: "get_email",
      },
    };
    if (usesPlan) {
      Object.assign(f.runData, {
        initialRecruitingRoleRevisionId: "role-revision",
        sourceMessageId: "source-message",
      });
      const mailSource = {
        ...server,
        id: "mail-source",
        revision: 2,
        endpoint: "https://mcp.instantly.ai/mcp",
        transport: "streamable_http",
        assignments: [{ botId: f.runData.botId, allowAllTools: true, allowedTools: [] }],
      };
      Object.assign(sourceStore.mcpServer, {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === server.id ? server : where.id === mailSource.id ? mailSource : null,
        ),
      });
      sourceStore.botMcpServer.findFirst.mockImplementation(async ({ where }) => {
        const chosen = where.serverId === mailSource.id ? mailSource : server;
        return { ...chosen.assignments[0]!, server: chosen };
      });
      f.prisma.$queryRaw.mockResolvedValue([planActor]);
      Object.assign(f.prisma, {
        recruitingRole: { findFirst: vi.fn(async () => ({ id: "role-1", revision: 1 })) },
        recruitingCandidate: { findUnique: vi.fn(async () => ({ candidateKey: recipient })) },
      });
      vi.mocked(getPlanWorkspace).mockResolvedValue({
        role: {
          id: "role-1",
          revision: 1,
          currentRevisionId: "role-revision",
          title: "Synthetic role",
        },
        crmTarget: null,
      } as never);
      effectReads.findFirst.mockImplementation(async ({ where }) => {
        const match = f.effects.find((effect) =>
          Object.entries(where).every(
            ([key, value]) => key === "run" || effect[key as keyof Effect] === value,
          ),
        );
        return match ? { ...match, run: { ...f.runData } } : null;
      });
      f.connector.discoverTools.mockResolvedValue([
        mail,
        createBooking,
        getBooking,
        listBookings,
        availability,
        rescheduleBooking,
        cancelBooking,
        originalRead,
      ]);
      Object.assign(f.connector, {
        resolveCall: vi.fn(async (call: ConnectorCall) => {
          if (!call.args.arguments) return undefined;
          const id = String(call.args.id);
          const tool = id.endsWith(":create_booking")
            ? createBooking
            : {
                ...mail,
                route: {
                  connectorId: "mcp",
                  resourceId: mailSource.id,
                  resourceRevision: mailSource.revision,
                  toolName: "native_instantly_reply_to_email",
                },
              };
          return {
            tool,
            call: { ...call, tool: tool.name, route: tool.route, args: call.args.arguments },
          };
        }),
      });
    }
    const confirmationId = "8a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
    let sentBody: Record<string, unknown> | undefined;
    const replyRest = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === `/emails/${originalEmail.id}`) return originalEmail;
      if (method === "GET" && path === `/emails/${confirmationId}`)
        return {
          id: confirmationId,
          thread_id: originalEmail.thread_id,
          eaccount: originalEmail.eaccount,
          reply_to_uuid: originalEmail.id,
          from_address_email: originalEmail.eaccount,
          to_address_email_list: recipient,
          ue_type: 3,
          timestamp_email: new Date().toISOString(),
          subject: sentBody?.subject,
          body: sentBody?.body,
        };
      if (method === "GET" && path === "/accounts/recruiter%40example.test")
        return { email: originalEmail.eaccount };
      if (method === "POST" && path === "/emails/reply") {
        expect(body).toMatchObject({
          reply_to_uuid: originalEmail.id,
          eaccount: originalEmail.eaccount,
        });
        sentBody = body as Record<string, unknown>;
        return { id: confirmationId, thread_id: originalEmail.thread_id };
      }
      throw new Error(`Unexpected synthetic provider request: ${method} ${path}`);
    });
    const timeZone = "America/New_York";
    const interviewerTimeZone = "Asia/Tokyo";
    const participantTime = (instant: string, zone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(new Date(instant));
    const slots = ["2026-10-26T14:00:00Z", "2026-10-26T15:00:00Z", "2026-10-27T14:00:00Z"];
    // Scripted candidate reply selects the second offered slot. No mail ingestion or
    // model comprehension is claimed by this deterministic implementation check.
    const selected =
      scenario === "dst_first_0130"
        ? "2026-11-01T05:30:00Z"
        : scenario === "dst_second_0130"
          ? "2026-11-01T06:30:00Z"
          : slots[1]!;
    slots[1] = selected;
    const end = new Date(Date.parse(selected) + 30 * 60 * 1000).toISOString();
    if (scenario.startsWith("dst_")) {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
      }).format(new Date(selected));
      expect(local).toContain("01:30");
      expect(local).toContain(scenario === "dst_first_0130" ? "GMT-4" : "GMT-5");
      const hostLocal = participantTime(selected, interviewerTimeZone);
      expect(hostLocal).toContain(scenario === "dst_first_0130" ? "2:30:00 PM" : "3:30:00 PM");
      expect(hostLocal).toContain("GMT+9");
    }
    let providerBooking: Record<string, unknown> | undefined;
    f.connector.execute.mockImplementation(async function* (call) {
      let data: unknown;
      if (["get_email", "native_instantly_get_email"].includes(call.route?.toolName ?? "")) {
        data = await runInstantlyWrite(
          {} as never,
          replyRest as never,
          {} as never,
          "synthetic-mail-server",
          "native_instantly_get_email",
          call.args,
        );
      } else if (call.route?.toolName === "get_availability") {
        const changing = call.args.bookingUidToReschedule !== undefined;
        const slot = changing ? "2026-10-28T15:00:00Z" : selected;
        const slotEnd = new Date(Date.parse(slot) + 30 * 60_000).toISOString();
        expect(call.args).toEqual({
          eventTypeId: 42,
          start: slot,
          end: slotEnd,
          timeZone: "UTC",
          duration: 30,
          format: "range",
          ...(changing ? { bookingUidToReschedule: "synthetic-booking-42" } : {}),
        });
        data = {
          status: "success",
          data: {
            [slot.slice(0, 10)]:
              scenario === "booking_conflict" ||
              (changing && scenario === "reschedule_slot_conflict")
                ? []
                : [{ start: slot, end: slotEnd }],
          },
        };
      } else if (call.route?.toolName === "create_booking") {
        providerBooking = {
          uid: "synthetic-booking-42",
          eventTypeId: 42,
          hosts: [{ email: "interviewer@example.test", timeZone: interviewerTimeZone }],
          title: "Candidate interview",
          status: "accepted",
          start: call.args.start,
          end,
          attendees: [call.args.attendee],
          location: "https://meeting.example.test/synthetic-42",
        };
        data = { status: "success", data: providerBooking };
      } else if (["reschedule_booking", "cancel_booking"].includes(call.route?.toolName ?? "")) {
        expect(call.args.bookingUid).toBe("synthetic-booking-42");
        if (scenario.endsWith("timeout")) {
          // The provider applied the change before its acknowledgement was lost.
          // A reschedule retires the original UID; its replacement is not proven by
          // this uncertain mutation, even if a later original-booking read names it.
          providerBooking = {
            ...providerBooking,
            status: "cancelled",
            ...(scenario === "reschedule_timeout"
              ? { rescheduledToUid: "unproven-replacement-43" }
              : {}),
          };
          yield {
            type: "error",
            message: "Synthetic calendar acknowledgement lost",
            outcome: "uncertain",
          };
          return;
        }
        if (call.route?.toolName === "reschedule_booking") {
          providerBooking = {
            ...providerBooking,
            uid: "synthetic-replacement-43",
            rescheduledFromUid: call.args.bookingUid,
            start: call.args.start,
            end: new Date(Date.parse(String(call.args.start)) + 30 * 60_000).toISOString(),
          };
        } else providerBooking = { ...providerBooking, status: "cancelled" };
        data = { status: "success", data: providerBooking };
      } else if (call.route?.toolName === "get_bookings") {
        data = {
          status: "success",
          data: providerBooking ? [providerBooking] : [],
          pagination: { hasNextPage: false, hasPreviousPage: false },
        };
      } else if (call.route?.toolName === "get_booking") {
        expect(call.args).toEqual({ bookingUid: providerBooking!.uid });
        data = { status: "success", data: providerBooking };
      } else if (
        ((scenario === "confirmation_uncertain" || scenario === "confirmation_rejected") &&
          call.args.subject === "Interview confirmed") ||
        (scenario === "reschedule_confirmation_rejected" &&
          call.args.subject === "Interview changed")
      ) {
        yield {
          type: "error",
          message:
            scenario === "confirmation_uncertain"
              ? "Synthetic confirmation acknowledgement lost"
              : "Synthetic provider rejected confirmation",
          ...(scenario === "confirmation_uncertain" ? { outcome: "uncertain" as const } : {}),
        };
        return;
      } else
        data = await runInstantlyWrite(
          {} as never,
          replyRest as never,
          {} as never,
          "synthetic-mail-server",
          "native_instantly_reply_to_email",
          call.args,
        );
      yield { type: "result", data: { content: [{ type: "text", text: JSON.stringify(data) }] } };
    });
    async function approveAndExecute(
      name: string,
      args: Record<string, unknown>,
      index: number,
      outcome: "completed" | "uncertain" = "completed",
    ) {
      const wrapper =
        planId && (name === createBooking.name || (name === mail.name && index === 3))
          ? {
              name: "recruiting_scheduling",
              args:
                name === createBooking.name
                  ? { operation: "book", planId, arguments: args }
                  : { operation: "confirm", planId, subject: args.subject, body: args.body },
            }
          : { name, args };
      f.setCalls([{ ...wrapper, executionId: `request-${index}` }]);
      let count = f.connector.execute.mock.calls.length;
      await f.run();
      if (planId && name === mail.name && index === 3) {
        expect(
          f.connector.execute.mock.calls
            .slice(count)
            .every(([call]) =>
              ["get_email", "native_instantly_get_email"].includes(call.route?.toolName ?? ""),
            ),
        ).toBe(true);
        count = f.connector.execute.mock.calls.length;
      } else expect(f.connector.execute).toHaveBeenCalledTimes(count);
      const card = messages.at(-1)!;
      expect(
        card.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
        JSON.stringify(f.results.at(-1)),
      ).toBe(true);
      const effect = f.effects.at(-1)!;
      if (wrapper.name === "recruiting_scheduling") {
        const ask = card.blocks.find((block) => block.kind === "ask");
        expect(ask).toMatchObject({
          approvalEffectId: effect.id,
          approvalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(ask?.kind === "ask" && ask.detail).toEqual(expect.stringContaining(timeZone));
        expect(ask?.kind === "ask" && ask.detail).toEqual(
          expect.stringContaining(interviewerTimeZone),
        );
        expect(ask?.kind === "ask" && ask.detail).toEqual(
          expect.stringContaining(originalEmail.eaccount),
        );
      }
      const request = structuredClone(effect.request);
      const input = {
        spaceId: f.runData.spaceId,
        threadId: f.runData.threadId,
        runId: f.runData.id,
        messageId: card.id,
        answeredByUserId: f.runData.userId,
        answer: "allow",
      };
      expect(await answerRunInput(db, input)).toBe(true);
      expect(await answerRunInput(db, input)).toBe(false);
      expect(effect.status).toBe("approved");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "effect.approval.answered",
          payload: expect.objectContaining({
            effectId: effect.id,
            answeredByUserId: f.runData.userId,
            requestHash: createHash("sha256").update(stableJsonValue(request)).digest("hex"),
          }),
        }),
      );
      // A runtime revision cannot replace the exact approved recipient/time/content.
      f.setCalls([
        {
          name: wrapper.name,
          args:
            wrapper.name === "recruiting_scheduling"
              ? wrapper.args
              : {
                  ...args,
                  to: "wrong@example.test",
                  start: slots[2],
                  ...(name === mail.name
                    ? {
                        reply_to_uuid: "9a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
                        eaccount: "wrong@example.test",
                      }
                    : {}),
                },
          executionId: `resume-${index}`,
        },
      ]);
      await f.run();
      const isBooking = name === createBooking.name;
      const blockedBooking = isBooking && scenario === "booking_conflict";
      const dispatchCount = isBooking && !blockedBooking ? 2 : 1;
      expect(f.connector.execute).toHaveBeenCalledTimes(count + dispatchCount);
      if (!blockedBooking)
        expect(f.connector.execute).toHaveBeenLastCalledWith(
          expect.objectContaining({ args }),
          expect.anything(),
        );
      if (isBooking) {
        expect(f.connector.execute.mock.calls[count]?.[0].route?.toolName).toBe("get_availability");
        if (!blockedBooking)
          expect(f.connector.execute.mock.calls[count + 1]?.[0].route?.toolName).toBe(
            "create_booking",
          );
      }
      if (blockedBooking) {
        expect(effect).toMatchObject({ status: "approved", request });
        expect(f.results.at(-1)).toMatchObject({
          code: "CALENDAR_SLOT_CONFLICT",
          dispatched: false,
        });
        return effect;
      }
      expect(effect).toMatchObject({ status: outcome, request });
      f.setCalls([{ ...wrapper, executionId: `retry-${index}` }]);
      await f.run();
      expect(f.connector.execute).toHaveBeenCalledTimes(count + dispatchCount);
      return effect;
    }
    const listArgs = {};
    const readBookingList = async (expectedUid: string | null, expectedStatus?: string) => {
      const count = f.connector.execute.mock.calls.length;
      f.setCalls([{ name: listBookings.name, args: listArgs, executionId: "same-list-read" }]);
      await f.run();
      expect(f.connector.execute, JSON.stringify(f.results)).toHaveBeenCalledTimes(count + 1);
      expect(f.connector.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({ toolName: "get_bookings" }),
          args: listArgs,
        }),
        expect.anything(),
      );
      const result = f.results.at(-1) as { content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]!.text);
      expect(body.data).toEqual(
        expectedUid
          ? [
              expect.objectContaining({
                uid: expectedUid,
                ...(expectedStatus ? { status: expectedStatus } : {}),
              }),
            ]
          : [],
      );
    };
    await readBookingList(null);
    await approveAndExecute(
      mail.name,
      {
        reply_to_uuid: originalEmail.id,
        eaccount: originalEmail.eaccount,
        subject: "Interview options",
        body: {
          text: `Choose one: ${slots.map((slot) => `${participantTime(slot, timeZone)} (${timeZone}); ${participantTime(slot, interviewerTimeZone)} (${interviewerTimeZone})`).join("; ")}`,
        },
      },
      1,
    );
    if (usesPlan) {
      f.setCalls([
        {
          name: originalRead.name,
          args: { id: originalEmail.id },
          executionId: "plan-original-read",
        },
      ]);
      await f.run();
      const mailRead = f.effects.at(-1)!;
      f.setCalls([
        {
          name: availability.name,
          args: {
            eventTypeId: 42,
            start: selected,
            end,
            timeZone: "UTC",
            duration: 30,
            format: "range",
          },
          executionId: "plan-availability",
        },
      ]);
      await f.run();
      const availabilityRead = f.effects.at(-1)!;
      const input = {
        threadId: f.runData.threadId,
        roleId: "role-1",
        expectedRoleRevision: 1,
        originalEmail: {
          threadId: f.runData.threadId,
          roleId: "role-1",
          emailId: "original",
          sourceId: "mail-source",
          providerMessageId: originalEmail.id,
          providerThreadId: originalEmail.thread_id,
          eaccount: originalEmail.eaccount,
          savedRead: {
            effectId: mailRead.id,
            linkedRunId: f.runData.id,
            messageId: "source-message",
          },
          sourceName: "Mailbox",
          sender: recipient,
          subject: originalEmail.subject,
          date: null,
          snippet: false,
        },
        candidate: {
          candidateKey: recipient,
          name: "Synthetic candidate",
          email: recipient,
          timeZone,
        },
        interviewer: {
          name: "Synthetic interviewer",
          email: "interviewer@example.test",
          timeZone: interviewerTimeZone,
        },
        calendar: {
          sourceId: server.id,
          sourceRevision: server.revision,
          eventTypeId: 42,
          availabilityEffectId: availabilityRead.id,
          start: selected,
          end,
          lengthInMinutes: 30,
        },
      };
      await expect(
        createRecruitingSchedulingPlan(db, planActor, {
          ...input,
          originalEmail: { ...input.originalEmail, eaccount: "wrong@example.test" },
        }),
      ).rejects.toThrow();
      const plan = await createRecruitingSchedulingPlan(db, planActor, input);
      planId = plan.id;
      expect(plan.candidate.timeZone).not.toBe(plan.interviewer.timeZone);
      const callsBefore = f.connector.execute.mock.calls.length;
      const effectsBefore = f.effects.length;
      f.setCalls([
        {
          name: "recruiting_scheduling",
          args: {
            operation: "book",
            planId: "foreign-plan",
            arguments: {
              eventTypeId: 42,
              start: selected,
              lengthInMinutes: 30,
              attendee: input.candidate,
            },
          },
          executionId: "wrong-plan",
        },
      ]);
      await f.run();
      expect(f.results.at(-1)).toMatchObject({
        code: "SCHEDULING_PLAN_UNAVAILABLE",
        dispatched: false,
      });
      expect(f.connector.execute).toHaveBeenCalledTimes(callsBefore);
      expect(f.effects).toHaveLength(effectsBefore);
    }
    const booked = await approveAndExecute(
      createBooking.name,
      {
        eventTypeId: 42,
        lengthInMinutes: 30,
        start: selected,
        attendee: { name: "Synthetic candidate", email: recipient, timeZone },
      },
      2,
    );
    if (scenario !== "booking_conflict") await readBookingList("synthetic-booking-42", "accepted");
    // Read the UID from the actual persisted executor receipt, not from a separately
    // hard-coded projection fixture or the requested booking arguments.
    vi.mocked(getRecruitingWorkspace).mockResolvedValue({ role: { id: "role-1" } } as never);
    const actor = {
      spaceId: f.runData.spaceId,
      userId: f.runData.userId,
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const target = {
      kind: "group" as const,
      groupId: "synthetic-group",
      groupName: "Synthetic role",
      members: [],
      memberBotIds: [f.runData.botId],
      threadId: f.runData.threadId,
    };
    // The projection's persistence adapter returns only this store's completed native
    // reads; the production parser still checks tool, assignment, revision and result.
    const originalFindMany = f.prisma.externalEffect.findMany.getMockImplementation()!;
    let projecting = false;
    f.prisma.externalEffect.findMany.mockImplementation(async (query) => {
      if (!projecting) return originalFindMany(query);
      const request = query as unknown as {
        where: {
          id?: { in: string[] };
          run: { threadId: string; initialRecruitingRoleRevision?: { roleId: string } };
          spaceId: string;
        };
        select: { result?: boolean };
      };
      expect(request.where.spaceId).toBe(actor.spaceId);
      expect(request.where.run.threadId).toBe(target.threadId);
      return f.effects
        .filter((effect) => {
          const call = (effect.request as unknown[])[2] as { route?: { toolName?: string } };
          return (
            effect.status === "completed" &&
            (request.where.run.initialRecruitingRoleRevision
              ? ["create_booking", "reschedule_booking"].includes(call?.route?.toolName ?? "")
              : call?.route?.toolName === "get_booking") &&
            (!request.where.id || request.where.id.in.includes(effect.id))
          );
        })
        .toReversed()
        .map((effect) => ({
          ...effect,
          updatedAt: new Date("2026-10-23T18:00:00Z"),
          run: { ...f.runData },
        }));
    });
    const project = async () => {
      projecting = true;
      try {
        return await getRecruitingCorrespondence(db, actor, target, "interview");
      } finally {
        projecting = false;
      }
    };
    expect((await project()).events).toEqual([]);
    if (scenario === "booking_conflict") {
      expect(booked.status).toBe("approved");
      expect(providerBooking).toBeUndefined();
      expect(
        f.connector.execute.mock.calls.filter(
          ([call]) => call.route?.toolName === "create_booking",
        ),
      ).toHaveLength(0);
      expect(
        f.connector.execute.mock.calls.some(
          ([call]) => call.args.subject === "Interview confirmed",
        ),
      ).toBe(false);
      expect(messages).toHaveLength(2);
      // The real executor preflight blocks the mutation before provider dispatch.
      return;
    }
    const receipt = booked.result as { content: Array<{ text: string }> };
    const returned = JSON.parse(receipt.content[0]!.text).data as { uid: string };
    f.setCalls([
      { name: getBooking.name, args: { bookingUid: returned.uid }, executionId: "readback" },
    ]);
    await f.run();
    expect(messages).toHaveLength(2); // A read is not another outbound grant.
    const projected = await project();
    expect(projected).toMatchObject({
      roleId: "role-1",
      status: "ready",
      events: [
        {
          id: `cal-1:booking:${returned.uid}`,
          kind: "event",
          title: "Candidate interview",
          start: selected,
          end,
          attendees: [recipient],
          status: "accepted",
          url: "https://meeting.example.test/synthetic-42",
        },
      ],
    });
    await approveAndExecute(
      mail.name,
      {
        reply_to_uuid: originalEmail.id,
        eaccount: originalEmail.eaccount,
        subject: "Interview confirmed",
        body: {
          text: `Confirmed ${participantTime(projected.events[0]!.start!, timeZone)} (${timeZone}); ${participantTime(projected.events[0]!.start!, interviewerTimeZone)} (${interviewerTimeZone}); ${projected.events[0]!.url}`,
        },
      },
      3,
      scenario === "confirmation_uncertain" ? "uncertain" : "completed",
    );
    const confirmationEffect = f.effects.at(-1)!;
    if (planId && scenario !== "confirmation_uncertain") {
      const beforeReadback = await loadVerifiedRecruitingSchedulingPlan(db, planActor, {
        threadId: f.runData.threadId,
        planId,
      });
      expect(beforeReadback.confirmationStatus).toBe("uncertain");
      f.setCalls([
        {
          name: originalRead.name,
          args: { id: confirmationId },
          executionId: "confirmation-readback",
        },
      ]);
      await f.run();
    }
    if (planId) {
      const persisted = await loadVerifiedRecruitingSchedulingPlan(db, planActor, {
        threadId: f.runData.threadId,
        planId,
      });
      expect(persisted).toMatchObject({
        id: planId,
        bookingEffectId: booked.id,
        confirmationEffectId: confirmationEffect.id,
        bookingStatus: "completed",
        confirmationStatus: scenario === "confirmation_uncertain" ? "uncertain" : "completed",
      });
      expect(persisted.originalEmail).toMatchObject({
        providerMessageId: originalEmail.id,
        providerThreadId: originalEmail.thread_id,
        eaccount: originalEmail.eaccount,
      });
    }
    if (scenario !== "confirmation_uncertain" && scenario !== "confirmation_rejected") {
      const sendReceipt = confirmationEffect.result as { content: Array<{ text: string }> };
      const sent = JSON.parse(sendReceipt.content[0]!.text) as { id: string };
      const readback = await runInstantlyWrite(
        {} as never,
        replyRest as never,
        {} as never,
        "synthetic-mail-server",
        "native_instantly_get_email",
        { id: sent.id },
      );
      expect(readback).toMatchObject({
        id: sent.id,
        thread_id: originalEmail.thread_id,
        eaccount: originalEmail.eaccount,
        reply_to_uuid: originalEmail.id,
      });
    }
    expect(replyRest.mock.calls.filter(([method]) => method === "POST")).toHaveLength(
      scenario === "confirmation_uncertain" || scenario === "confirmation_rejected" ? 1 : 2,
    );
    if (scenario === "confirmation_uncertain") {
      expect(booked.status).toBe("completed");
      expect(f.effects.at(-1)).toMatchObject({ status: "uncertain", result: { uncertain: true } });
      // The native retry preserves the completed booking and does not resend an
      // acknowledgement-lost confirmation. Reconciliation remains required.
      expect(
        f.connector.execute.mock.calls.filter(
          ([call]) => call.args.subject === "Interview confirmed",
        ),
      ).toHaveLength(1);
    }
    if (scenario === "confirmation_rejected") {
      expect(booked.status).toBe("completed");
      expect(f.effects.at(-1)).toMatchObject({
        status: "completed",
        result: { error: "Synthetic provider rejected confirmation" },
      });
      // A definitive error is retained distinctly from a successful send; replaying
      // the same exact effect returns its error rather than silently resending.
      expect(
        f.connector.execute.mock.calls.filter(
          ([call]) => call.args.subject === "Interview confirmed",
        ),
      ).toHaveLength(1);
    }
    expect(messages).toHaveLength(3);
    expect(events.filter((event) => event.type === "effect.approval.answered")).toHaveLength(3);
    expect(
      f.connector.execute.mock.calls.filter(([call]) => call.route?.toolName === "create_booking"),
    ).toHaveLength(1);
    expect((await project()).events).toEqual(projected.events);
    // Public Cal contracts: /docs/api-reference/v2/bookings/reschedule-a-booking and
    // /cancel-a-booking. The schemas/provider here are synthetic; actual assigned
    // schemas and fresh authorization remain required by the production helpers.
    if (scenario.startsWith("reschedule_") || scenario.startsWith("cancel_")) {
      const cancelling = scenario.startsWith("cancel_");
      const mutation = cancelling ? cancelBooking : rescheduleBooking;
      const changeArgs = cancelling
        ? { bookingUid: returned.uid, cancellationReason: "Participant requested cancellation" }
        : { bookingUid: returned.uid, start: "2026-10-28T15:00:00Z", lengthInMinutes: 30 };
      const beforeChange = f.connector.execute.mock.calls.length;
      f.setCalls([{ name: mutation.name, args: changeArgs, executionId: "change-request" }]);
      await f.run();
      expect(
        f.connector.execute.mock.calls.slice(beforeChange).map(([call]) => call.route?.toolName),
      ).toEqual(["get_booking"]);
      const changeEffect = f.effects.at(-1)!;
      const approvalRequest = structuredClone(changeEffect.request);
      expect(changeEffect.result).toMatchObject({
        calendarApprovalEvidence: {
          snapshot: {
            uid: returned.uid,
            eventTypeId: 42,
            start: selected,
            end,
            status: "accepted",
          },
        },
      });
      const card = messages.at(-1)!;
      expect(JSON.stringify(card.blocks)).toContain("originalBooking");
      const input = {
        spaceId: f.runData.spaceId,
        threadId: f.runData.threadId,
        runId: f.runData.id,
        messageId: card.id,
        answeredByUserId: f.runData.userId,
        answer: "allow",
      };
      expect(await answerRunInput(db, input)).toBe(true);
      expect(await answerRunInput(db, input)).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "effect.approval.answered",
        payload: {
          effectId: changeEffect.id,
          requestHash: createHash("sha256").update(stableJsonValue(approvalRequest)).digest("hex"),
          approvalEvidenceHash: expect.any(String),
        },
      });
      if (scenario === "reschedule_changed_original")
        providerBooking!.attendees = [{ email: "different@example.test" }];
      const beforeReplay = f.connector.execute.mock.calls.length;
      f.setCalls([
        {
          name: mutation.name,
          args: { ...changeArgs, bookingUid: "wrong-booking", start: slots[2] },
          executionId: "change-resume",
        },
      ]);
      await f.run();
      const replayCalls = f.connector.execute.mock.calls
        .slice(beforeReplay)
        .map(([call]) => call.route?.toolName);
      expect(replayCalls[0]).toBe("get_booking");
      const blocked =
        scenario === "reschedule_changed_original" || scenario === "reschedule_slot_conflict";
      if (blocked) {
        expect(changeEffect.status).toBe("approved");
        expect(f.results.at(-1)).toMatchObject({ dispatched: false });
        expect(replayCalls).not.toContain(mutation.route.toolName);
        expect(providerBooking!.uid).toBe(returned.uid);
        return;
      }
      expect(replayCalls).toEqual(
        cancelling
          ? ["get_booking", "cancel_booking"]
          : ["get_booking", "get_availability", "reschedule_booking"],
      );
      expect(f.connector.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ args: changeArgs }),
        expect.anything(),
      );
      const callCount = f.connector.execute.mock.calls.length;
      f.setCalls([{ name: mutation.name, args: changeArgs, executionId: "change-retry" }]);
      await f.run();
      expect(f.connector.execute).toHaveBeenCalledTimes(callCount);
      expect(
        f.connector.execute.mock.calls.filter(
          ([call]) => call.route?.toolName === "create_booking",
        ),
      ).toHaveLength(1);
      if (scenario.endsWith("timeout")) {
        await readBookingList(returned.uid, "cancelled");
        expect(changeEffect).toMatchObject({ status: "uncertain", result: { uncertain: true } });
        expect((await project()).events).toEqual(projected.events);
        const beforeReconciliation = f.connector.execute.mock.calls.length;
        const uncertainResult = structuredClone(changeEffect.result);
        f.setCalls([
          {
            name: getBooking.name,
            args: { bookingUid: returned.uid },
            executionId: "timeout-reconciliation",
          },
        ]);
        await f.run();
        expect(f.connector.execute).toHaveBeenCalledTimes(beforeReconciliation + 1);
        expect(f.connector.execute).toHaveBeenLastCalledWith(
          expect.objectContaining({
            route: expect.objectContaining({ toolName: "get_booking" }),
            args: { bookingUid: returned.uid },
          }),
          expect.anything(),
        );
        expect(f.results.at(-1)).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining('"status":"cancelled"') }],
        });
        expect(changeEffect).toMatchObject({ status: "uncertain", result: uncertainResult });
        const reconciled = await project();
        expect(reconciled.events).toEqual([
          expect.objectContaining({ id: `cal-1:booking:${returned.uid}`, status: "cancelled" }),
        ]);
        expect(reconciled.events.some((event) => event.id.includes("unproven-replacement"))).toBe(
          false,
        );
        f.setCalls([
          { name: mutation.name, args: changeArgs, executionId: "after-reconciliation-retry" },
        ]);
        await f.run();
        expect(f.connector.execute).toHaveBeenCalledTimes(beforeReconciliation + 1);
        expect(
          f.connector.execute.mock.calls.filter(
            ([call]) => call.route?.toolName === mutation.route.toolName,
          ),
        ).toHaveLength(1);
        expect(changeEffect).toMatchObject({ status: "uncertain", result: uncertainResult });
        return;
      }
      expect(changeEffect.status).toBe("completed");
      const mutationReceipt = changeEffect.result as { content: Array<{ text: string }> };
      const changedUid = JSON.parse(mutationReceipt.content[0]!.text).data.uid as string;
      expect(changedUid).toBe(cancelling ? returned.uid : "synthetic-replacement-43");
      f.setCalls([
        { name: getBooking.name, args: { bookingUid: changedUid }, executionId: "change-readback" },
      ]);
      await f.run();
      expect(f.connector.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({ toolName: "get_booking" }),
          args: { bookingUid: changedUid },
        }),
        expect.anything(),
      );
      expect(f.results.at(-1)).toMatchObject({
        content: [
          {
            type: "text",
            text: expect.stringContaining(cancelling ? "cancelled" : "synthetic-replacement-43"),
          },
        ],
      });
      await readBookingList(changedUid, cancelling ? "cancelled" : "accepted");
      const changedProjection = await project();
      expect(changedProjection.events).toContainEqual(
        expect.objectContaining({
          id: `cal-1:booking:${changedUid}`,
          status: cancelling ? "cancelled" : "accepted",
          start: cancelling ? selected : "2026-10-28T15:00:00Z",
        }),
      );
      if (!cancelling) {
        expect(changedProjection.events).toContainEqual(
          expect.objectContaining({ id: `cal-1:booking:${returned.uid}`, status: "superseded" }),
        );
        expect(
          changedProjection.events.some(
            (event) =>
              event.id === `cal-1:booking:${returned.uid}` &&
              ["accepted", "confirmed"].includes(event.status ?? ""),
          ),
        ).toBe(false);
      }
      if (scenario === "reschedule_confirmation_rejected") {
        await approveAndExecute(
          mail.name,
          {
            reply_to_uuid: originalEmail.id,
            eaccount: originalEmail.eaccount,
            subject: "Interview changed",
            body: { text: `Changed to ${providerBooking!.start}` },
          },
          5,
        );
        expect(f.effects.at(-1)).toMatchObject({
          status: "completed",
          result: { error: "Synthetic provider rejected confirmation" },
        });
        expect(changeEffect.status).toBe("completed");
        expect((await project()).events).toEqual(changedProjection.events);
        expect(
          f.connector.execute.mock.calls.filter(
            ([call]) => call.route?.toolName === "reschedule_booking",
          ),
        ).toHaveLength(1);
      }
      await renderSchedulingProjection(changedProjection);
      return;
    }
    await renderSchedulingProjection(projected);
  });
});
