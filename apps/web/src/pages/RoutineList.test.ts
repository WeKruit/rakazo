import { i18n } from "@lingui/core";
import type { Routine } from "@rakazo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { routineNextRun } from "./RoutineList";

const routine = (patch: Partial<Routine>) =>
  ({ active: true, nextRunAt: null, ...patch }) as Routine;

describe("routineNextRun", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });
  const now = new Date("2026-10-31T08:00:00");

  it("shows when an active routine runs next", () => {
    expect(
      routineNextRun(routine({ nextRunAt: new Date("2026-10-31T09:30:00").toISOString() }), now),
    ).toMatch(/^Next .*9:30/);
    expect(
      routineNextRun(routine({ nextRunAt: new Date("2026-11-02T09:30:00").toISOString() }), now),
    ).toMatch(/^Next Nov 2/);
  });

  it("shows nothing for paused or unscheduled routines", () => {
    expect(
      routineNextRun(routine({ active: false, nextRunAt: now.toISOString() }), now),
    ).toBeNull();
    expect(routineNextRun(routine({}), now)).toBeNull();
  });
});
