import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({}));

import { datedSends, sequenceObservations } from "./SequenceOverview";

it("does not equate enrolled, active or completed leads with actual contact or interest", () => {
  const campaign: RecruitingRoleCampaign = {
    status: "ready",
    serverId: "source",
    campaign: { id: "c", name: "Example", eaccount: null, status: 1, stopOnReply: true },
    leads: [
      { email: "one@example.test", candidateKey: null, status: 1, interestStatus: null },
      { email: "two@example.test", candidateKey: null, status: 3, interestStatus: -1 },
    ],
  };
  expect(sequenceObservations(campaign)).toEqual({ active: 1, interested: null, partial: true });
  expect(sequenceObservations({ ...campaign, leads: [] })).toEqual({
    active: null,
    interested: null,
    partial: true,
  });
  expect(sequenceObservations({ ...campaign, status: "unavailable" })).toEqual({
    active: null,
    interested: null,
    partial: false,
  });
  campaign.leads[1]!.interestStatus = 1;
  expect(sequenceObservations(campaign).interested).toBe(1);
});

it("uses a completeness receipt for exact positive and zero counts", () => {
  const campaign: RecruitingRoleCampaign = {
    status: "ready",
    serverId: "source",
    campaign: { id: "c", name: "Example", eaccount: null, status: 1, stopOnReply: true },
    leadsComplete: true,
    leads: [],
  };
  expect(sequenceObservations(campaign)).toEqual({ active: 0, interested: 0, partial: false });
  campaign.leads = [
    { email: "one@example.test", candidateKey: null, status: 1, interestStatus: 2 },
  ];
  expect(sequenceObservations(campaign)).toEqual({ active: 1, interested: 1, partial: false });
  campaign.leadsComplete = false;
  expect(sequenceObservations(campaign)).toEqual({ active: 1, interested: 1, partial: true });
});

it("buckets only valid supplied send timestamps into the visible UTC dates", () => {
  const days = datedSends(
    [
      "not a date",
      "2026-10-22T23:30:00-02:00",
      "2026-10-20T09:00:00Z",
      "2020-01-01",
      "2026-10-23",
      "2026-10-23T10:00:00",
      "2026-10-23T22:00:00Z",
    ],
    new Date("2026-10-23T12:00:00Z"),
  );
  expect(days.map((day) => day.count)).toEqual([0, 0, 0, 1, 0, 0, 1]);
});
