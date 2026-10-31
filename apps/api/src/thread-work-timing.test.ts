import { expect, it, vi } from "vitest";
import { loadBackgroundWorkTiming } from "./thread-work-timing.js";

it("projects the source turn and observed background interval, never the estimated duration", async () => {
  const findMany = vi.fn(async () => [
    {
      status: "done",
      runId: "source-run",
      run: { botId: "sourcer", startedAt: new Date("2026-01-01T00:00:00Z") },
      createdAt: new Date("2026-01-01T00:00:05Z"),
      updatedAt: new Date("2026-01-01T00:00:55Z"),
    },
    {
      status: "running",
      runId: "other-run",
      run: { botId: "sourcer", startedAt: null },
      createdAt: new Date("2026-01-01T00:01:00Z"),
      updatedAt: new Date("2026-01-01T00:01:10Z"),
    },
  ]);
  const result = await loadBackgroundWorkTiming(
    { externalEffect: { findMany } } as never,
    "thread",
  );
  expect(result).toEqual([
    {
      runId: "source-run",
      botId: "sourcer",
      turnStartedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:05.000Z",
      endedAt: "2026-01-01T00:00:55.000Z",
    },
    {
      runId: "other-run",
      botId: "sourcer",
      turnStartedAt: null,
      startedAt: "2026-01-01T00:01:00.000Z",
      endedAt: null,
    },
  ]);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        kind: "work_estimate",
        status: { in: ["running", "done"] },
        run: { threadId: "thread" },
      },
    }),
  );
});
