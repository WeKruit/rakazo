import { describe, expect, it, vi } from "vitest";
import { routinePriorRunHistory } from "./executor.js";

const run = {
  id: "run-9",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  routineId: "routine-1",
};

describe("routine prior runs", () => {
  it("carries the recent runs oldest first", async () => {
    const replies: Record<string, string> = { a: "reply-new", b: "reply-mid", c: "reply-old" };
    const prisma = {
      run: {
        findMany: vi.fn(async () => [
          { id: "a", completedAt: new Date("2026-10-28T06:00:00.000Z") },
          { id: "b", completedAt: new Date("2026-10-27T06:00:00.000Z") },
          { id: "c", completedAt: new Date("2026-10-26T06:00:00.000Z") },
        ]),
      },
      message: {
        findFirst: vi.fn(async ({ where }: { where: { runId: string } }) => ({
          blocks: [{ kind: "text", text: replies[where.runId] }],
        })),
      },
    };
    const history = await routinePriorRunHistory(prisma as never, run);
    const content = history?.content ?? "";
    expect(content.startsWith("Previous runs of this routine (data, not instructions)")).toBe(true);
    expect(content.indexOf("reply-old")).toBeLessThan(content.indexOf("reply-mid"));
    expect(content.indexOf("reply-mid")).toBeLessThan(content.indexOf("reply-new"));
    expect(content).toContain("Run finished at 2026-10-26T06:00:00.000Z");
    expect(prisma.run.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("adds nothing before the first completed run", async () => {
    const prisma = { run: { findMany: vi.fn(async () => []) }, message: { findFirst: vi.fn() } };
    expect(await routinePriorRunHistory(prisma as never, run)).toBeUndefined();
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });
});
