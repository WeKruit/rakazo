import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCardDeadlines } from "./card-deadlines.mjs";

test("live card regression rejects missing or reset clocks and clocks on closed cards", () => {
  const run = { id: "run", status: "waiting_input", updatedAt: "2026-10-30T12:00:00.000Z" };
  const snapshot = {
    run,
    messages: [{ runId: "run", blocks: [{ kind: "ask", status: "pending" }] }],
  };
  const deadline = "2026-10-31T12:00:00.000Z";
  assert.doesNotThrow(() => assertCardDeadlines(snapshot, [deadline]));
  assert.throws(() => assertCardDeadlines(snapshot, []), /does not show/);
  assert.throws(() => assertCardDeadlines(snapshot, ["2026-11-01T12:00:00.000Z"]), /does not show/);
  assert.throws(() => assertCardDeadlines(snapshot, [deadline, deadline]), /closed card/);
  assert.throws(
    () => assertCardDeadlines({ ...snapshot, run: { ...run, updatedAt: undefined } }, []),
    /no persisted/,
  );
  assert.throws(
    () => assertCardDeadlines({ ...snapshot, messages: [] }, []),
    /unanswered test card/,
  );
});
