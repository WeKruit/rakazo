import type { RecruitingCorrespondence, RecruitingRoleCampaign } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OverviewReads } from "./recruiting-overview.js";
import { campaignStages, crmReplied, streamRecruitingOverview } from "./recruiting-overview.js";

async function getRecruitingOverview(...args: Parameters<typeof streamRecruitingOverview>) {
  const events = [];
  for await (const event of streamRecruitingOverview(...args)) events.push(event);
  expect(events.at(-1)).toEqual({ kind: "done" });
  return {
    roles: events.flatMap((event) => (event.kind === "role" ? [event.role] : [])),
    failedGroups: events.flatMap((event) => (event.kind === "failed" ? [event.groupId] : [])),
  };
}

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

describe("streamRecruitingOverview", () => {
  const groups = [
    { id: "g1", threadId: "t1" },
    { id: "g2", threadId: "t2" },
    { id: "g3", threadId: "t3" },
  ];
  const calendar = (roleId: string, start: string): RecruitingCorrespondence =>
    ({
      roleId,
      status: "ready",
      partial: false,
      events: [{ id: "e", kind: "event", status: "confirmed", start }],
    }) as RecruitingCorrespondence;
  const reads = (patch: Partial<OverviewReads> = {}): OverviewReads => ({
    roleId: async (group) => (group.id === "g3" ? null : `role-${group.id}`),
    shortlistPage: async (_roleId, cursor) =>
      ({
        items: [{ shortlisted: true, shortlistedAt: cursor ? "2026-10-22T00:00:00Z" : null }],
        total: 2,
        nextCursor: cursor ? null : "next",
      }) as Awaited<ReturnType<OverviewReads["shortlistPage"]>>,
    candidates: async () => ({
      items: [],
      nextCursor: null,
      total: 0,
      counts: { shortlisted: 2, replied: 1 },
      crmStatus: "ok",
      crmCountsComplete: true,
    }),
    campaign: async () => ({ status: "none", serverId: null, campaign: null, leads: [] }),
    calendar: async (group) => calendar(`role-${group.id}`, "2099-01-01T00:00:00Z"),
    ...patch,
  });

  it("reads every bound role once, with every shortlist page and its future bookings", async () => {
    const overview = await getRecruitingOverview(groups, reads(), new AbortController().signal);
    expect(overview.failedGroups).toEqual([]);
    expect(overview.roles.map((role) => role.groupId).sort()).toEqual(["g1", "g2"]);
    expect(overview.roles.find((role) => role.groupId === "g1")).toMatchObject({
      roleId: "role-g1",
      shortlisted: 2,
      shortlistedDates: [null, "2026-10-22T00:00:00Z"],
      replied: 1,
      contacted: null,
      interested: null,
      incomplete: false,
      bookingUnknown: false,
    });
    expect(overview.roles.find((role) => role.groupId === "g1")!.bookings).toHaveLength(1);
  });

  it("reports a slow source as partial instead of waiting for it", async () => {
    let aborted = false;
    const overview = await getRecruitingOverview(
      groups.slice(0, 1),
      reads({
        candidates: (_group, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            }),
          ),
      }),
      new AbortController().signal,
      { sourceMs: 20 },
    );
    expect(aborted).toBe(true);
    expect(overview.roles[0]).toMatchObject({ replied: null, incomplete: true, shortlisted: 2 });
  });

  it("keeps the other roles when one role's own numbers cannot be read", async () => {
    const overview = await getRecruitingOverview(
      groups,
      reads({
        shortlistPage: vi.fn(async (roleId: string) => {
          if (roleId === "role-g2") throw new Error("down");
          return { items: [], total: 0, nextCursor: null } as never;
        }),
      }),
      new AbortController().signal,
    );
    expect(overview.roles.map((role) => role.groupId)).toEqual(["g1"]);
    expect(overview.failedGroups).toEqual(["g2"]);
  });

  it("yields a fast role before a slow one finishes", async () => {
    let release = () => undefined as void;
    const seen: string[] = [];
    const stream = streamRecruitingOverview(
      groups.slice(0, 2),
      reads({
        roleId: (group) =>
          group.id === "g1"
            ? new Promise((resolve) => {
                release = () => resolve("role-g1");
              })
            : Promise.resolve("role-g2"),
      }),
      new AbortController().signal,
    );
    for await (const event of stream) {
      seen.push(event.kind === "role" ? event.role.groupId : event.kind);
      if (seen.length === 1) release();
    }
    expect(seen).toEqual(["g2", "g1", "done"]);
  });

  it("keeps at most four CRM, campaign and calendar reads in flight across roles", async () => {
    let running = 0;
    let peak = 0;
    const slow = async <T>(value: T) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return value;
    };
    const base = reads();
    const many = Array.from({ length: 6 }, (_, index) => ({
      id: `g${index}`,
      threadId: `t${index}`,
    }));
    const overview = await getRecruitingOverview(
      many,
      reads({
        roleId: async (group) => `role-${group.id}`,
        candidates: (group, signal) => base.candidates(group, signal).then(slow),
        campaign: (group, signal) => base.campaign(group, signal).then(slow),
        calendar: (group, signal) => base.calendar(group, signal).then(slow),
      }),
      new AbortController().signal,
    );
    expect(overview.roles).toHaveLength(6);
    expect(peak).toBe(4);
  });

  it("does not show another role's or a past calendar event as a booking", async () => {
    const overview = await getRecruitingOverview(
      groups.slice(0, 2),
      reads({
        calendar: async (group) =>
          group.id === "g1"
            ? calendar("role-other", "2099-01-01T00:00:00Z")
            : calendar("role-g2", "2000-01-01T00:00:00Z"),
      }),
      new AbortController().signal,
    );
    const byGroup = (id: string) => overview.roles.find((role) => role.groupId === id);
    expect(byGroup("g1")).toMatchObject({ bookings: [], bookingUnknown: true });
    expect(byGroup("g2")).toMatchObject({ bookings: [], bookingUnknown: false });
  });
});
