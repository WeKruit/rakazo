import type { RecruitingReminder, RecruitingRoleCampaign } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { RoleSummary } from "./dashboard";
import {
  bucketByWeek,
  campaignStages,
  crmReplied,
  firstName,
  mapWithConcurrency,
  openTasks,
  outreachFunnel,
  recentRoles,
  roleSummary,
  weekStart,
} from "./dashboard";

const role = (patch: Partial<RoleSummary> = {}): RoleSummary => ({
  groupId: "g",
  roleId: "r",
  shortlisted: 0,
  shortlistedDates: [],
  contacted: null,
  replied: null,
  interested: null,
  ...patch,
});

describe("bucketByWeek", () => {
  // Thursday, local time.
  const now = new Date(2026, 9, 22, 15);

  it("starts weeks on Monday and returns five buckets, oldest first", () => {
    const weeks = bucketByWeek([], now);
    expect(weeks).toHaveLength(5);
    expect(weeks.at(-1)!.start).toEqual(new Date(2026, 9, 19));
    expect(weeks[0]!.start).toEqual(new Date(2026, 8, 21));
    expect(weekStart(new Date(2026, 9, 25, 23))).toEqual(new Date(2026, 9, 19));
  });

  it("counts each date in its week and ignores older, future, missing or invalid dates", () => {
    const weeks = bucketByWeek(
      [
        new Date(2026, 9, 19, 0, 0).toISOString(),
        new Date(2026, 9, 21).toISOString(),
        new Date(2026, 9, 18, 23, 59).toISOString(),
        new Date(2026, 8, 21, 9).toISOString(),
        new Date(2026, 8, 20).toISOString(),
        new Date(2026, 9, 27).toISOString(),
        null,
        "not a date",
      ],
      now,
    );
    expect(weeks.map((week) => week.count)).toEqual([1, 0, 0, 1, 2]);
  });
});

describe("outreachFunnel", () => {
  it("sums roles and expresses each stage as a share of shortlisted", () => {
    const stages = outreachFunnel([
      role({ shortlisted: 30, contacted: 20, replied: 6, interested: 2 }),
      role({ shortlisted: 10, contacted: 4, replied: 2, interested: 1 }),
    ]);
    expect(stages).toEqual([
      { key: "shortlisted", count: 40, percent: 100 },
      { key: "contacted", count: 24, percent: 60 },
      { key: "replied", count: 8, percent: 20 },
      { key: "interested", count: 3, percent: 8 },
    ]);
  });

  it("keeps a stage no role reports unknown instead of zero, and sums the roles that do", () => {
    const stages = outreachFunnel([
      role({ shortlisted: 5, replied: 1 }),
      role({ shortlisted: 5, replied: null }),
    ]);
    expect(stages.map((stage) => stage.count)).toEqual([10, null, 1, null]);
    expect(stages.map((stage) => stage.percent)).toEqual([100, null, 10, null]);
  });

  it("has no percentages without shortlisted people or roles", () => {
    expect(outreachFunnel([role({ contacted: 3 })])[1]).toEqual({
      key: "contacted",
      count: 3,
      percent: null,
    });
    expect(outreachFunnel([]).every((stage) => stage.count === null)).toBe(true);
  });
});

describe("source mapping", () => {
  const campaign = (
    status: number | null,
    leads: { status: number | null; interestStatus: number | null }[],
  ): RecruitingRoleCampaign => ({
    status: "ready",
    serverId: "s",
    campaign: { id: "c", name: "Role", eaccount: null, status, stopOnReply: true },
    leads: leads.map((lead, index) => ({ candidateKey: null, email: `${index}@x.test`, ...lead })),
  });

  it("counts launched campaign leads as contacted and interested-or-further as interested", () => {
    expect(
      campaignStages(
        campaign(1, [
          { status: 1, interestStatus: null },
          { status: 3, interestStatus: 1 },
          { status: 3, interestStatus: 2 },
          { status: -1, interestStatus: -1 },
        ]),
      ),
    ).toEqual({ contacted: 4, interested: 2 });
    expect(campaignStages(campaign(0, [{ status: 1, interestStatus: null }]))).toEqual({
      contacted: 0,
      interested: 0,
    });
  });

  it("reports unknown without a readable campaign or CRM", () => {
    expect(campaignStages(null)).toEqual({ contacted: null, interested: null });
    expect(campaignStages({ status: "none", serverId: null, campaign: null, leads: [] })).toEqual({
      contacted: null,
      interested: null,
    });
    const counts = { shortlisted: 1, replied: 4 };
    expect(crmReplied({ items: [], nextCursor: null, total: 0, counts, crmStatus: "ok" })).toBe(4);
    expect(
      crmReplied({ items: [], nextCursor: null, total: 0, counts, crmStatus: "not_bound" }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("orders recent roles by activity and leaves out archived ones", () => {
    const group = (id: string, updatedAt: string, archivedAt: string | null = null) =>
      ({ id, updatedAt, archivedAt }) as Parameters<typeof recentRoles>[0][number];
    expect(
      recentRoles([
        group("a", "2026-10-01T00:00:00Z"),
        group("b", "2026-10-20T00:00:00Z"),
        group("c", "2026-10-21T00:00:00Z", "2026-10-21T00:00:00Z"),
      ]).map((item) => item.id),
    ).toEqual(["b", "a"]);
  });

  it("runs at most the given number of tasks at once and keeps order", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(4);
  });

  it("lists open tasks earliest due first and marks overdue ones", () => {
    const reminder = (id: string, dueAt: string, status: RecruitingReminder["status"] = "open") =>
      ({ id, dueAt, status }) as RecruitingReminder;
    const tasks = openTasks(
      [
        reminder("later", "2026-10-30T00:00:00Z"),
        reminder("done", "2026-10-01T00:00:00Z", "done"),
        reminder("late", "2026-10-20T00:00:00Z"),
      ],
      new Date("2026-10-22T00:00:00Z"),
    );
    expect(tasks.map(({ reminder, overdue }) => [reminder.id, overdue])).toEqual([
      ["late", true],
      ["later", false],
    ]);
  });

  it("greets by first name", () => {
    expect(firstName("  Ada Lovelace ")).toBe("Ada");
    expect(firstName(undefined)).toBe("");
  });
});
