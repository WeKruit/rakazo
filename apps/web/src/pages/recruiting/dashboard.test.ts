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
  readShortlistPages,
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
        new Date(2026, 9, 23).toISOString(),
        null,
        "not a date",
      ],
      now,
    );
    expect(weeks.map((week) => week.count)).toEqual([1, 0, 0, 1, 2]);
  });
});

describe("outreachFunnel", () => {
  it("sums available role counts without inventing conversion percentages", () => {
    const stages = outreachFunnel([
      role({ shortlisted: 30, contacted: 20, replied: 6, interested: 2 }),
      role({ shortlisted: 10, contacted: 4, replied: 2, interested: 1 }),
    ]);
    expect(stages).toEqual([
      { key: "shortlisted", count: 40, partial: false },
      { key: "contacted", count: 24, partial: false },
      { key: "replied", count: 8, partial: false },
      { key: "interested", count: 3, partial: false },
    ]);
  });

  it("keeps an aggregate unknown when any role has no reported count", () => {
    const stages = outreachFunnel([
      role({ shortlisted: 5, replied: 1 }),
      role({ shortlisted: 5, replied: null }),
    ]);
    expect(stages.map((stage) => stage.count)).toEqual([10, null, null, null]);
    expect(stages.map((stage) => stage.partial)).toEqual([false, false, false, false]);
  });

  it("keeps unknown separate from known zero and does not infer stage relationships", () => {
    expect(outreachFunnel([role({ contacted: 3 })])[1]).toEqual({
      key: "contacted",
      count: 3,
      partial: false,
    });
    expect(outreachFunnel([]).every((stage) => stage.count === null)).toBe(true);
  });

  it("marks a bounded interest read as partial even when every role returned a count", () => {
    const stages = outreachFunnel([
      role({ shortlisted: 2, interested: 5, interestedPartial: true }),
    ]);
    expect(stages.find((stage) => stage.key === "interested")).toEqual({
      key: "interested",
      count: 5,
      partial: true,
    });
    expect(stages.some((stage) => "percent" in stage)).toBe(false);
  });
});

describe("source mapping", () => {
  const campaign = (
    status: number | null,
    leads: { status: number | null; interestStatus: number | null }[],
  ): RecruitingRoleCampaign => ({
    status: "ready",
    leadsComplete: true,
    serverId: "s",
    campaign: { id: "c", name: "Role", eaccount: null, status, stopOnReply: true },
    leads: leads.map((lead, index) => ({ candidateKey: null, email: `${index}@x.test`, ...lead })),
  });

  it("does not count enrolled leads as contacted, while preserving reported interest", () => {
    expect(
      campaignStages(
        campaign(1, [
          { status: 1, interestStatus: null },
          { status: 3, interestStatus: 1 },
          { status: 3, interestStatus: 2 },
          { status: -1, interestStatus: -1 },
        ]),
      ),
    ).toEqual({ contacted: null, interested: 2, interestedPartial: false });
    expect(campaignStages(campaign(0, [{ status: 1, interestStatus: null }]))).toEqual({
      contacted: 0,
      interested: 0,
      interestedPartial: false,
    });
  });

  it("keeps failed, partial or unproven campaign lead totals unknown", () => {
    for (const leadsComplete of [false, undefined])
      expect(campaignStages({ ...campaign(1, []), leadsComplete })).toEqual({
        contacted: null,
        interested: null,
        interestedPartial: false,
      });
    expect(campaignStages(campaign(null, []))).toEqual({
      contacted: null,
      interested: null,
      interestedPartial: false,
    });
    expect(campaignStages(campaign(1, []))).toEqual({
      contacted: null,
      interested: 0,
      interestedPartial: false,
    });
  });

  it("reports unknown without a readable campaign or CRM", () => {
    expect(campaignStages(null)).toEqual({
      contacted: null,
      interested: null,
      interestedPartial: false,
    });
    expect(campaignStages({ status: "none", serverId: null, campaign: null, leads: [] })).toEqual({
      contacted: null,
      interested: null,
      interestedPartial: false,
    });
    const counts = { shortlisted: 1, replied: 4 };
    for (const crmCountsComplete of [undefined, false])
      expect(
        crmReplied({
          items: [],
          nextCursor: null,
          total: 0,
          counts,
          crmStatus: "ok",
          crmCountsComplete,
        }),
      ).toBeNull();
    expect(
      crmReplied({
        items: [],
        nextCursor: null,
        total: 0,
        counts,
        crmStatus: "ok",
        crmCountsComplete: true,
      }),
    ).toBe(4);
    expect(
      crmReplied({ items: [], nextCursor: null, total: 0, counts, crmStatus: "not_bound" }),
    ).toBeNull();
  });

  it("keeps launched sends unknown and counts only complete known campaign lead reads", () => {
    for (const status of [0, 1, 2, 3, 999]) {
      expect(campaignStages(campaign(status, [{ status: 3, interestStatus: 4 }]))).toEqual({
        contacted: status === 0 ? 0 : null,
        interested: 1,
        interestedPartial: false,
      });
    }
    expect(campaignStages(campaign(null, [{ status: 3, interestStatus: 4 }]))).toEqual({
      contacted: null,
      interested: null,
      interestedPartial: false,
    });
    expect(campaignStages(campaign(1, []))).toEqual({
      contacted: null,
      interested: 0,
      interestedPartial: false,
    });
    expect(
      campaignStages(
        campaign(1, [
          { status: 3, interestStatus: 999 },
          { status: 3, interestStatus: -1 },
        ]),
      ).interested,
    ).toBe(0);
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

it("counts recorded shortlist dates from all pages and keeps unknown dates unknown", async () => {
  const calls: (string | undefined)[] = [];
  const dates = [null, "2026-10-22T12:00:00Z"];
  const result = await readShortlistPages(async (cursor) => {
    calls.push(cursor);
    const index = cursor ? 1 : 0;
    return {
      items: [
        {
          shortlisted: true,
          shortlistedAt: dates[index],
          firstDiscoveredAt: "2026-10-01T00:00:00Z",
        },
      ],
      total: 2,
      nextCursor: cursor ? null : "next",
    } as Awaited<ReturnType<Parameters<typeof readShortlistPages>[0]>>;
  });
  expect(calls).toEqual([undefined, "next"]);
  const summary = roleSummary("g", "r", result, null, null);
  expect(summary.shortlistedDates).toEqual(dates);
  expect(
    bucketByWeek(summary.shortlistedDates, new Date("2026-10-23T12:00:00Z")).at(-1)?.count,
  ).toBe(1);
});
