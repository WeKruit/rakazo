import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createSharedRoutines } from "./shared-routines.js";

const actor = { spaceId: "space-1", userId: "member" } as never;
const original = {
  id: "shared-1",
  spaceId: "space-1",
  userId: "owner",
  botId: "owner-bot",
  name: "Morning digest",
  prompt: "Summarize new people.",
  crons: ["0 9 * * 1-5"],
  timezone: "UTC",
  sessionMode: "new",
  condition: null,
  probeCommand: null,
  recordTrigger: null,
  webhookEnabled: true,
  shared: true,
  sharedFromId: null,
};

function fakeDeps(input: { original?: unknown; bot?: unknown; existing?: unknown } = {}) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "copy-1",
    ...data,
  }));
  const routineFindFirst = vi
    .fn()
    .mockResolvedValueOnce(input.original === undefined ? original : input.original)
    .mockResolvedValueOnce(input.existing ?? null);
  const prisma = {
    routine: { findFirst: routineFindFirst, create },
    bot: { findFirst: vi.fn(async () => (input.bot === undefined ? { id: "my-bot" } : input.bot)) },
  };
  const enqueue = vi.fn(async () => undefined);
  return { deps: { prisma: prisma as never, jobs: { enqueue } }, create, enqueue, prisma };
}

describe("shared routines", () => {
  it("copies the schedule to the member's own bot, never the owner's identity or webhook", async () => {
    const { deps, create, enqueue } = fakeDeps();
    const copy = await createSharedRoutines(deps).add(actor, {
      routineId: "shared-1",
      botId: "my-bot",
      active: true,
    });
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      spaceId: "space-1",
      userId: "member",
      botId: "my-bot",
      prompt: "Summarize new people.",
      crons: ["0 9 * * 1-5"],
      sharedFromId: "shared-1",
      active: true,
    });
    expect(data).not.toHaveProperty("webhookEnabled");
    expect(data).not.toHaveProperty("shared");
    expect(copy.nextRunAt).toBeInstanceOf(Date);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("returns the existing copy instead of adding the routine twice", async () => {
    const { deps, create } = fakeDeps({ existing: { id: "copy-0" } });
    const copy = await createSharedRoutines(deps).add(actor, {
      routineId: "shared-1",
      botId: "my-bot",
      active: true,
    });
    expect(copy).toEqual({ id: "copy-0" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses routines that aren't shared in this Space and bots the member doesn't own", async () => {
    for (const missing of [{ original: null }, { bot: null }]) {
      const { deps, create } = fakeDeps(missing);
      await expect(
        createSharedRoutines(deps).add(actor, { routineId: "x", botId: "y", active: true }),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(create).not.toHaveBeenCalled();
    }
  });
});
