import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFollowUpDelivery } from "./follow-up.mjs";

test("live regression rejects early, duplicate and missing follow-up delivery", () => {
  const received = { type: "thread.message.created", seq: 1, payload: { messageId: "message" } };
  const finished = { type: "run.completed", seq: 2, runId: "old" };
  const claim = {
    type: "run.steering.claimed",
    seq: 3,
    runId: "new",
    payload: { messageIds: ["message"] },
  };
  assert.doesNotThrow(() => assertFollowUpDelivery([received, finished, claim], "message", "old"));
  assert.throws(
    () => assertFollowUpDelivery([received, finished, { ...claim, seq: 1 }], "message", "old"),
    /before/,
  );
  assert.throws(
    () =>
      assertFollowUpDelivery([received, finished, { ...claim, runId: "old" }], "message", "old"),
    /before/,
  );
  assert.throws(
    () => assertFollowUpDelivery([received, finished, claim, claim], "message", "old"),
    /once/,
  );
  assert.throws(() => assertFollowUpDelivery([received, finished], "message", "old"), /once/);
});

test("repeat reply must follow an exact input claim on the same run", async () => {
  const { replyAfterInput } = await import("./follow-up.mjs");
  const input = { id: "input", role: "user", seq: 9 };
  const reply = {
    id: "reply",
    role: "bot",
    runId: "claimed",
    blocks: [{ kind: "text", text: "Done" }],
  };
  const source = {
    type: "thread.message.created",
    seq: 9,
    runId: "original",
    payload: { role: "user", messageId: "input", queued: true },
  };
  const claim = {
    type: "run.steering.claimed",
    seq: 10,
    runId: "claimed",
    payload: { messageIds: ["input"] },
  };
  const posted = {
    type: "thread.message.created",
    seq: 11,
    runId: "claimed",
    payload: { messageId: "reply" },
  };
  assert.equal(replyAfterInput([source, claim, posted], [input, reply], 9), reply);
  assert.equal(replyAfterInput([source, posted], [input, reply], 9), null);
  assert.equal(replyAfterInput([source, claim, { ...posted, seq: 8 }], [input, reply], 9), null);
  assert.equal(
    replyAfterInput([source, claim, posted], [input, { ...reply, runId: "concurrent" }], 9),
    null,
  );
  assert.equal(
    replyAfterInput([source, claim, posted], [input, { ...reply, internal: true }], 9),
    null,
  );
});

test("direct post-promotion input requires its own source event and later start", async () => {
  const { replyAfterInput } = await import("./follow-up.mjs");
  const input = { id: "input", role: "user", seq: 9, runId: "new-person" };
  const reply = {
    id: "reply",
    role: "bot",
    runId: "new-person",
    blocks: [{ kind: "text", text: "Done" }],
  };
  const source = {
    type: "thread.message.created",
    seq: 10,
    runId: "new-person",
    payload: { role: "user", messageId: "input" },
  };
  const started = { type: "run.started", seq: 11, runId: "new-person" };
  const posted = {
    type: "thread.message.created",
    seq: 12,
    runId: "new-person",
    payload: { messageId: "reply" },
  };
  assert.equal(replyAfterInput([source, started, posted], [input, reply], 9), reply);
  assert.equal(replyAfterInput([source, { ...started, seq: 8 }, posted], [input, reply], 9), null);
  assert.equal(
    replyAfterInput([source, started, posted], [{ ...input, runId: "other" }, reply], 9),
    null,
  );
  assert.equal(
    replyAfterInput(
      [{ ...source, payload: { ...source.payload, queued: true } }, started, posted],
      [input, reply],
      9,
    ),
    null,
  );
  assert.equal(replyAfterInput([started, posted], [input, reply], 9), null);
});
