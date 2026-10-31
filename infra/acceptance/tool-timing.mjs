import assert from "node:assert/strict";

/** Check the real saved tool transcript, so duration loss on persistence/reload fails release. */
export function checkToolTiming(messages) {
  const steps = messages.flatMap((message) =>
    (message.blocks ?? []).flatMap((block) => (block.kind === "steps" ? block.steps : [])),
  );
  assert.ok(steps.length, "tool timing check needs a completed tool in the test conversation");
  for (const step of steps) {
    assert.equal(step.count, 1, "timed executions must remain separate steps");
    assert.ok(Number.isFinite(Date.parse(step.startedAt)), "tool start time must survive reload");
    assert.ok(
      Number.isSafeInteger(step.durationMs) && step.durationMs >= 0,
      "each completed tool must keep its receipt duration after reload",
    );
  }
}

/** Completed background intervals must remain available after the foreground run has ended. */
export function checkBackgroundTiming(snapshot) {
  const completed = (snapshot.backgroundWork ?? []).filter((work) => work.endedAt);
  assert.ok(
    completed.length,
    "background total-time check needs an observed completed background task",
  );
  for (const work of completed) {
    const start = Date.parse(work.startedAt);
    const end = Date.parse(work.endedAt);
    assert.ok(
      Number.isFinite(start) && Number.isFinite(end) && end >= start,
      "background timing must use persisted observed start/end timestamps",
    );
    assert.ok(
      !("estimateMs" in work),
      "an ETA must not be substituted for observed background time",
    );
  }
}
