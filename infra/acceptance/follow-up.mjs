/** The live event log must show the old reply finished before delayed input was read. */
export function assertFollowUpDelivery(events, messageId, previousRunId) {
  const received = events.find(
    (event) => event.type === "thread.message.created" && event.payload?.messageId === messageId,
  );
  const finished = events.find(
    (event) =>
      event.runId === previousRunId &&
      ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
  );
  const claims = events.filter(
    (event) =>
      event.type === "run.steering.claimed" && event.payload?.messageIds?.includes(messageId),
  );
  if (!received || !finished || claims.length !== 1)
    throw new Error("Follow-up was not received and delivered once after a finished reply");
  const claim = claims[0];
  if (received.seq >= finished.seq || claim.seq <= finished.seq || claim.runId === previousRunId) {
    throw new Error("Follow-up entered the model before the current reply finished");
  }
}

/** A reply must follow this exact input's claim, or its own newly started source run. */
export function replyAfterInput(events, messages, inputSeq) {
  const input = messages.find((message) => message.role === "user" && message.seq === inputSeq);
  if (!input) return null;
  const source = events.find(
    (event) =>
      event.type === "thread.message.created" &&
      event.payload?.role === "user" &&
      event.payload?.messageId === input.id,
  );
  if (!source) return null;
  const claim = events.find(
    (event) =>
      event.type === "run.steering.claimed" &&
      event.payload?.messageIds?.includes(input.id) &&
      event.seq > source.seq,
  );
  const delivered =
    claim ??
    (source.payload.queued !== true &&
      source.runId === input.runId &&
      events.find(
        (event) =>
          event.type === "run.started" && event.runId === source.runId && event.seq > source.seq,
      ));
  if (!delivered) return null;
  return (
    messages.find(
      (message) =>
        message.role !== "user" &&
        !message.internal &&
        message.runId === delivered.runId &&
        (message.blocks ?? []).some((block) => block.kind === "text" && block.text?.trim()) &&
        events.some(
          (event) =>
            event.type === "thread.message.created" &&
            event.payload?.messageId === message.id &&
            event.runId === delivered.runId &&
            event.seq > delivered.seq,
        ),
    ) ?? null
  );
}
