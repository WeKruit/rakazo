/** Checks live API deadlines against the clock attributes rendered in the conversation. */
export function assertCardDeadlines(snapshot, renderedDeadlines) {
  const runs = snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []);
  const expected = (snapshot.messages ?? []).flatMap((message) => {
    const run = runs.find((run) => run.id === message.runId && run.status === "waiting_input");
    if (!run) return [];
    const pending = (message.blocks ?? []).filter(
      (block) => block.kind === "ask" && block.status !== "answered" && block.status !== "expired",
    );
    if (!pending.length) return [];
    const updatedAt = Date.parse(run.updatedAt);
    if (!Number.isFinite(updatedAt))
      throw new Error("Waiting card has no persisted deadline anchor");
    return pending.map(() => new Date(updatedAt + 24 * 60 * 60_000).toISOString());
  });
  if (!expected.length) throw new Error("Card deadline regression needs an unanswered test card");
  const remaining = [...renderedDeadlines];
  for (const deadline of expected) {
    const index = remaining.indexOf(deadline);
    if (index < 0) throw new Error("A waiting card does not show its persisted 24-hour deadline");
    remaining.splice(index, 1);
  }
  if (remaining.length) throw new Error("A closed card still shows a deadline");
}
