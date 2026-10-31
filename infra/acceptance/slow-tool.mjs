import assert from "node:assert/strict";

/** Inspect an existing real run; never launch or repeat a provider call for this check. */
export function assertSlowToolPromotion(events, messageId) {
  const received = events.find(
    (event) =>
      event.type === "thread.message.created" &&
      event.payload?.role === "user" &&
      event.payload?.messageId === messageId,
  );
  assert(received, "The slow-tool case needs the actual mid-tool person message");
  const promotions = events.filter(
    (event) =>
      event.type === "run.started" &&
      event.payload?.backgrounded === true &&
      event.payload?.trigger === "tool_background",
  );
  assert(promotions.length, "No slow tool was promoted; this case was not exercised");
  const promotion = promotions.find((event) => {
    const called = events.find(
      (row) =>
        row.type === "agent.tool.called" &&
        row.runId === event.runId &&
        row.payload?.executionId === event.payload.executionId,
    );
    const completed = events.find(
      (row) =>
        row.type === "agent.tool.completed" &&
        row.runId === event.runId &&
        row.payload?.executionId === event.payload.executionId,
    );
    return called && completed && called.seq < received.seq && received.seq < completed.seq;
  });
  assert(promotion, "No promoted tool was still running when the person steered");
  assert(
    Number.isFinite(promotion.payload.durationMs) && promotion.payload.durationMs >= 10_000,
    "The tool was promoted before its ten-second foreground interval",
  );
  const started = events
    .filter((event) => event.type === "run.started" && event.runId === promotion.runId)
    .sort((a, b) => a.seq - b.seq)[0];
  assert(
    started &&
      started.seq < promotion.seq &&
      started.payload.trigger === promotion.payload.sourceTrigger &&
      started.payload.trigger !== "tool_background",
    "Promotion lost the original durable turn identity",
  );
  const called = events.filter(
    (event) =>
      event.type === "agent.tool.called" &&
      event.runId === promotion.runId &&
      event.payload?.executionId === promotion.payload.executionId,
  );
  const completed = events.filter(
    (event) =>
      event.type === "agent.tool.completed" &&
      event.runId === promotion.runId &&
      event.payload?.executionId === promotion.payload.executionId,
  );
  assert.equal(called.length, 1, "The background tool was dispatched more than once");
  assert.equal(completed.length, 1, "The background result was delivered more than once");
  const finished = events.find(
    (event) => event.type === "run.completed" && event.runId === promotion.runId,
  );
  assert(
    finished && completed[0].seq < finished.seq,
    "The promoted tool never completed through its original run",
  );
  const claims = events.filter(
    (event) =>
      event.type === "run.steering.claimed" && event.payload?.messageIds?.includes(messageId),
  );
  let personRunId;
  let deliveredAt;
  if (claims.length) {
    assert.equal(claims.length, 1, "The person's steer was delivered more than once");
    personRunId = claims[0].runId;
    deliveredAt = claims[0].seq;
  } else {
    // A message sent after promotion is already the new run's source, so it has no steering row.
    personRunId = received.runId;
    deliveredAt = events.find(
      (event) => event.type === "run.started" && event.runId === personRunId,
    )?.seq;
  }
  assert(
    personRunId &&
      personRunId !== promotion.runId &&
      deliveredAt > promotion.seq &&
      deliveredAt < completed[0].seq,
    "The person's new turn waited for the background tool's result",
  );
  return { promotionsChecked: 1 };
}
