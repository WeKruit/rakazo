import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

vi.mock("./thread-target.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveThreadTarget: vi.fn(),
  sendThreadMessage: vi.fn(),
}));
vi.mock("./taught-skills.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertTeachingSendAllowed: vi.fn(async () => undefined),
}));

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const card = {
  kind: "ask",
  text: "Remote or onsite?",
  status: "expired",
  actions: [
    { id: "remote", label: "Remote is fine" },
    { id: "onsite", label: "Onsite only" },
  ],
};

function setup(options: { runStatus: string; group?: boolean; newerCard?: boolean }) {
  let blocks: unknown[] = [card];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findFirst: vi.fn(async (args: { where: { id?: string } }) =>
        args.where.id
          ? { botId: "sourcer", status: options.runStatus }
          : options.newerCard
            ? { id: "run-newer" }
            : null,
      ),
      findUnique: vi.fn(async () => ({ status: options.runStatus, startedAt: null })),
    },
    message: {
      findFirst: vi.fn(async () => ({ id: "ask-1", botId: "sourcer", blocks })),
      update: vi.fn(async (args: { data: { blocks: unknown[] } }) => {
        blocks = args.data.blocks;
        return {};
      }),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 8, userId: actor.userId })) },
    event: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        threadId: "thread-1",
        ...args.data,
      })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (inner: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const answerRunInput = vi.fn(async () => false);
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma,
    events: { answerRunInput, notify },
    jobs: { enqueue },
    env: {
      agentRuntime: "scripted",
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  vi.mocked(resolveThreadTarget).mockResolvedValue(
    (options.group
      ? {
          kind: "group",
          groupId: "group-1",
          threadId: "thread-1",
          groupName: "Staff Engineer",
          members: [],
          memberBotIds: ["main", "sourcer"],
        }
      : { kind: "bot", botId: "sourcer", threadId: "thread-1", bot: {} }) as Awaited<
      ReturnType<typeof resolveThreadTarget>
    >,
  );
  vi.mocked(sendThreadMessage).mockResolvedValue({
    taskId: "task-2",
    runId: "run-2",
    seq: 9,
    runIds: ["run-2"],
  });
  return {
    handler: new RPCHandler(createRouter(deps)),
    answerRunInput,
    notify,
    enqueue,
    blocks: () => blocks,
  };
}

async function answer(handler: RPCHandler<never>, body: Record<string, unknown>) {
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/threads/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { runId: "run-1", messageId: "ask-1", ...body } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

describe("answering a card whose wait expired", () => {
  beforeEach(() => {
    vi.mocked(sendThreadMessage).mockReset();
  });

  it("starts the work through the ordinary send, replying to the card, and closes the card", async () => {
    const { handler, answerRunInput, notify, enqueue, blocks } = setup({ runStatus: "cancelled" });
    const response = await answer(handler, { botId: "sourcer", answer: "onsite" });

    expect(response.status).toBe(200);
    expect(answerRunInput).toHaveBeenCalledOnce();
    expect(sendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ kind: "bot", botId: "sourcer" }),
      {
        botId: "sourcer",
        text: "Onsite only",
        replyToMessageId: "ask-1",
        clientNonce: "closed-ask:ask-1",
      },
      expect.any(Function),
    );
    // The new run is woken by the send; the ended run is never continued.
    expect(enqueue).not.toHaveBeenCalled();
    expect(blocks()).toEqual([{ ...card, status: "answered", answer: "onsite" }]);
    expect(notify).toHaveBeenCalledWith("thread-1", 7);
  });

  it("sends a group answer to the agent that asked", async () => {
    const { handler } = setup({ runStatus: "cancelled", group: true });
    const response = await answer(handler, { groupId: "group-1", answer: "remote" });

    expect(response.status).toBe(200);
    expect(sendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ kind: "group", groupId: "group-1" }),
      {
        groupId: "group-1",
        addressing: "mentions",
        mentions: [{ kind: "bot", id: "sourcer" }],
        text: "Remote is fine",
        replyToMessageId: "ask-1",
        clientNonce: "closed-ask:ask-1",
      },
      undefined,
    );
  });

  it("keeps the conflict when the card cannot be answered by a message", async () => {
    const { handler } = setup({ runStatus: "waiting_input" });
    const response = await answer(handler, { botId: "sourcer", answer: "onsite" });

    expect(response.status).toBe(409);
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });
});
