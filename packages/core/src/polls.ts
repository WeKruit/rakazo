import type { PollBlock, PollVote } from "@rakazo/contracts";

/** Shortest and longest time a poll stays open. */
export const POLL_MIN_MINUTES = 1;
export const POLL_MAX_MINUTES = 24 * 60;
export const POLL_DEFAULT_MINUTES = 5;

export type PollTallyRow = { id: string; label: string; count: number; voters: string[] };

/** Votes per option, in the poll's own option order. */
export function pollTally(block: PollBlock): PollTallyRow[] {
  return block.options.map((option) => {
    const voters = block.votes
      .filter((vote) => vote.optionIds.includes(option.id))
      .map((vote) => vote.name);
    return { id: option.id, label: option.label, count: voters.length, voters };
  });
}

export function pollIsOpen(block: PollBlock, now: Date): boolean {
  return block.status === "open" && Date.parse(block.closesAt) > now.getTime();
}

/** Records one voter's choice; a second vote by the same voter replaces the first. */
export function applyPollVote(
  block: PollBlock,
  vote: PollVote,
  now: Date,
): { ok: true; block: PollBlock } | { ok: false; error: string } {
  if (!pollIsOpen(block, now)) return { ok: false, error: "This poll is closed." };
  const known = new Set(block.options.map((option) => option.id));
  const optionIds = [...new Set(vote.optionIds)];
  if (optionIds.length === 0 || optionIds.some((id) => !known.has(id)))
    return { ok: false, error: "Choose one of the poll's options." };
  if (!block.multiple && optionIds.length > 1)
    return { ok: false, error: "This poll takes one choice." };
  const others = block.votes.filter(
    (existing) => !(existing.voter === vote.voter && existing.voterId === vote.voterId),
  );
  return { ok: true, block: { ...block, votes: [...others, { ...vote, optionIds }] } };
}

/** Everyone the poll waits for has voted, so it can close before its deadline. */
export function pollEveryoneVoted(
  block: PollBlock,
  expected: { userId: string; botIds: readonly string[] },
): boolean {
  const voted = (voter: PollVote["voter"], id: string) =>
    block.votes.some((vote) => vote.voter === voter && vote.voterId === id);
  if (!voted("user", expected.userId)) return false;
  return !block.includeTeam || expected.botIds.every((id) => voted("bot", id));
}

/** One plain line per option, for the asker's wake prompt and tool results. */
export function pollResultLines(block: PollBlock): string {
  const rows = pollTally(block);
  const lines = rows.map(
    (row) =>
      `- ${row.label}: ${row.count}${row.voters.length ? ` (${row.voters.join(", ")})` : ""}`,
  );
  return [`"${block.question}"`, ...lines].join("\n");
}

export function pollWakePrompt(block: PollBlock): string {
  const votes = block.votes.length;
  return [
    "Your poll has closed. Nobody wrote this message; you are continuing your own work.",
    pollResultLines(block),
    votes === 0
      ? "Nobody voted before the deadline. Carry on with your best judgment and say in one line what you chose and why."
      : "Use the result in the work it was for. Tell the conversation the outcome in one line, then carry on.",
  ].join("\n");
}
