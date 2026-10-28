import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_RUNS_PER_MINUTE, automationRateLimited } from "./automation-rate.js";

const fire = {
  spaceId: "space",
  botId: "bot",
  routineId: null,
  createdAt: new Date("2026-01-01T09:01:00Z"),
};

describe("automationRateLimited", () => {
  it("never counts a person's turns", async () => {
    const count = vi.fn(async () => AUTOMATION_RUNS_PER_MINUTE);
    for (const trigger of ["user", "follow_up", "messaging", "recruiting_research"]) {
      expect(await automationRateLimited({ run: { count } } as never, { ...fire, trigger })).toBe(
        false,
      );
    }
    expect(count).not.toHaveBeenCalled();
  });

  it("counts a routine's earlier fires in the last minute", async () => {
    const count = vi.fn(async () => AUTOMATION_RUNS_PER_MINUTE);
    const limited = await automationRateLimited({ run: { count } } as never, {
      ...fire,
      trigger: "webhook",
      routineId: "routine",
      id: "run",
    });
    expect(limited).toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        routineId: "routine",
        AND: expect.arrayContaining([
          {
            OR: [
              {
                createdAt: { gte: new Date("2026-01-01T09:00:00Z"), lt: fire.createdAt },
              },
              { createdAt: fire.createdAt, id: { lt: "run" } },
            ],
          },
        ]),
      }),
    });
  });
});
