import assert from "node:assert/strict";
import test from "node:test";
import { assertSlowToolPromotion } from "./slow-tool.mjs";

const row = (seq, type, runId, payload) => ({ seq, type, runId, payload });
const fixture = () => [
  row(1, "run.started", "original", { trigger: "user" }),
  row(2, "agent.tool.called", "original", { executionId: "tool" }),
  row(3, "thread.message.created", "original", { role: "user", messageId: "steer" }),
  row(4, "run.started", "original", {
    trigger: "tool_background",
    sourceTrigger: "user",
    backgrounded: true,
    executionId: "tool",
    durationMs: 10_000,
  }),
  row(5, "run.started", "person", { trigger: "follow_up" }),
  row(6, "run.steering.claimed", "person", { messageIds: ["steer"] }),
  row(7, "agent.tool.completed", "original", { executionId: "tool" }),
  row(8, "run.completed", "original", {}),
];

test("the existing native events prove one background result and a separate mid-tool person turn", () => {
  assert.deepEqual(assertSlowToolPromotion(fixture(), "steer"), { promotionsChecked: 1 });
});
test("a message sent after promotion can be the new run's source without a steering row", () => {
  const events = fixture().filter((event) => event.type !== "run.steering.claimed");
  events[2] = row(4.5, "thread.message.created", "person", { role: "user", messageId: "steer" });
  assertSlowToolPromotion(events, "steer");
});
test("a run without a slow tool is an unexercised failure", () => {
  assert.throws(
    () =>
      assertSlowToolPromotion(
        fixture().filter((event) => !event.payload.backgrounded),
        "steer",
      ),
    /not exercised/,
  );
});
test("early promotion, lost source identity, duplicate result and a blocked steer each fail", () => {
  const early = fixture();
  early[3].payload.durationMs = 9_999;
  assert.throws(() => assertSlowToolPromotion(early, "steer"), /ten-second/);
  const identity = fixture();
  identity[3].payload.sourceTrigger = "messaging";
  assert.throws(() => assertSlowToolPromotion(identity, "steer"), /identity/);
  const duplicate = fixture();
  duplicate.push(row(9, "agent.tool.completed", "original", { executionId: "tool" }));
  assert.throws(() => assertSlowToolPromotion(duplicate, "steer"), /more than once/);
  const blocked = fixture();
  blocked[5].seq = 7.5;
  assert.throws(() => assertSlowToolPromotion(blocked, "steer"), /waited/);
});
