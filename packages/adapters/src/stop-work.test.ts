import type * as DatabaseModule from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { stopConversationWork } from "./stop-work.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

describe("stopConversationWork", () => {
  it("stops this conversation and the role teams it handed work to, never its own turn", async () => {
    const cancelledWhere: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        updateManyAndReturn: vi.fn(async ({ where }: { where: unknown }) => {
          cancelledWhere.push(where);
          return [
            {
              id: `stopped-${cancelledWhere.length}`,
              botId: "bot",
              taskId: "task",
            },
          ];
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
      task: { updateMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      externalEffect: { updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { updateMany: vi.fn(async () => ({ count: 0 })) },
      cloudAgent: { updateMany: vi.fn(async () => ({ count: 0 })) },
      event: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      thread: { findMany: vi.fn(async () => [{ id: "role-thread" }]) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const notify = vi.fn(async (_threadId: string, _seq: number) => undefined);
    const result = await stopConversationWork({ prisma, events: { notify } } as never, {
      id: "own-run",
      spaceId: "space",
      userId: "user",
      threadId: "kruit-thread",
    });
    expect(result).toEqual({ stoppedTurns: 2, conversations: 2 });
    expect(cancelledWhere).toEqual([
      expect.objectContaining({
        threadId: "kruit-thread",
        id: { not: "own-run" },
      }),
      expect.objectContaining({
        threadId: "role-thread",
        id: { not: "own-run" },
      }),
    ]);
    // The searches' follow-ups end in both; the person's reminders stay.
    expect(tx.externalEffect.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
    expect(notify.mock.calls.map(([threadId]) => threadId)).toEqual([
      "kruit-thread",
      "role-thread",
    ]);
  });
});
