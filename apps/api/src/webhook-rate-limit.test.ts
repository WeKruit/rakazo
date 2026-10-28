import { describe, expect, it, vi } from "vitest";
import { deliverWebhookEvent, ROUTINE_RUNS_PER_MINUTE } from "./webhook-inbound.js";

const target = {
  bot: { id: "bot", spaceId: "space", userId: "user", webhookSecretId: "secret" },
  threadId: "thread",
} as unknown as Parameters<typeof deliverWebhookEvent>[1];
const routine = (id: string) => ({
  id,
  userId: "user",
  threadId: null,
  name: id,
  prompt: "Check replies",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
});

describe("routine rate limit", () => {
  it("skips a routine that already started its per-minute limit of runs", async () => {
    const sendUserMessage = vi.fn(async () => ({ messageId: "m", runId: "r", seq: 1 }));
    const count = vi.fn(async ({ where }: { where: { routineId: string } }) =>
      where.routineId === "busy" ? ROUTINE_RUNS_PER_MINUTE : 0,
    );
    const result = await deliverWebhookEvent(
      {
        events: { sendUserMessage } as never,
        jobs: { enqueue: vi.fn(async () => undefined) } as never,
        prisma: { run: { count } } as never,
      },
      target,
      { prompt: "{}", routines: [routine("busy"), routine("calm")], source: "webhook" },
    );
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      deliveries: [{ routineId: "calm" }],
      skipped: [{ routineId: "busy", reason: "rate_limited" }],
    });
  });

  it("delivers when the count itself fails", async () => {
    const sendUserMessage = vi.fn(async () => ({ messageId: "m", runId: "r", seq: 1 }));
    const result = await deliverWebhookEvent(
      {
        events: { sendUserMessage } as never,
        jobs: { enqueue: vi.fn(async () => undefined) } as never,
        prisma: {
          run: { count: vi.fn(async () => Promise.reject(new Error("db down"))) },
        } as never,
      },
      target,
      { prompt: "{}", routines: [routine("calm")], source: "webhook" },
    );
    expect(result).toMatchObject({ deliveries: [{ routineId: "calm" }] });
  });
});
