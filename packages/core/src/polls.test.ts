import type { PollBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPollVote,
  pollEveryoneVoted,
  pollIsOpen,
  pollTally,
  pollWakePrompt,
} from "./polls.js";

const now = new Date("2026-10-31T05:00:00Z");
const poll: PollBlock = {
  kind: "poll",
  pollId: "p1",
  question: "Which title first?",
  options: [
    { id: "1", label: "Staff engineer" },
    { id: "2", label: "Tech lead" },
  ],
  multiple: false,
  includeTeam: false,
  closesAt: "2026-10-31T05:05:00Z",
  status: "open",
  votes: [],
};

describe("polls", () => {
  it("counts votes live and replaces a voter's earlier choice", () => {
    const first = applyPollVote(
      poll,
      { voter: "user", voterId: "u1", name: "Ada", optionIds: ["1"] },
      now,
    );
    if (!first.ok) throw new Error(first.error);
    const second = applyPollVote(
      first.block,
      { voter: "user", voterId: "u1", name: "Ada", optionIds: ["2"] },
      now,
    );
    if (!second.ok) throw new Error(second.error);
    expect(pollTally(second.block).map((row) => row.count)).toEqual([0, 1]);
  });

  it("refuses votes after the deadline, unknown options and extra picks", () => {
    const late = new Date("2026-10-31T05:06:00Z");
    expect(pollIsOpen(poll, late)).toBe(false);
    expect(
      applyPollVote(poll, { voter: "user", voterId: "u1", name: "A", optionIds: ["1"] }, late).ok,
    ).toBe(false);
    expect(
      applyPollVote(poll, { voter: "user", voterId: "u1", name: "A", optionIds: ["9"] }, now).ok,
    ).toBe(false);
    expect(
      applyPollVote(poll, { voter: "user", voterId: "u1", name: "A", optionIds: ["1", "2"] }, now)
        .ok,
    ).toBe(false);
  });

  it("closes early only once everyone it waits for has voted", () => {
    const team = { ...poll, includeTeam: true };
    const voted = applyPollVote(
      team,
      { voter: "user", voterId: "u1", name: "A", optionIds: ["1"] },
      now,
    );
    if (!voted.ok) throw new Error(voted.error);
    expect(pollEveryoneVoted(voted.block, { userId: "u1", botIds: [] })).toBe(true);
    expect(pollEveryoneVoted(voted.block, { userId: "u1", botIds: ["b2"] })).toBe(false);
    expect(
      pollEveryoneVoted({ ...voted.block, includeTeam: false }, { userId: "u1", botIds: ["b2"] }),
    ).toBe(true);
  });

  it("tells the asker the result, or that nobody voted", () => {
    expect(pollWakePrompt(poll)).toContain("Nobody voted");
    const voted = applyPollVote(
      poll,
      { voter: "bot", voterId: "b2", name: "Sourcer", optionIds: ["2"] },
      now,
    );
    if (!voted.ok) throw new Error(voted.error);
    expect(pollWakePrompt(voted.block)).toContain("- Tech lead: 1 (Sourcer)");
  });
});
