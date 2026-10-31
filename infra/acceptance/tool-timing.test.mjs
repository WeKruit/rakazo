import assert from "node:assert/strict";
import test from "node:test";
import { checkBackgroundTiming, checkToolTiming } from "./tool-timing.mjs";

const messages = (step) => [{ blocks: [{ kind: "steps", steps: [step] }] }];
const timed = {
  label: "Reading a page",
  count: 1,
  startedAt: "2026-01-01T00:00:00Z",
  durationMs: 1200,
};

test("accepts the persisted start and duration of a completed tool", () => {
  assert.doesNotThrow(() => checkToolTiming(messages(timed)));
});

test("fails release when persistence drops tool timing or groups timed executions", () => {
  for (const step of [
    { ...timed, durationMs: undefined },
    { ...timed, startedAt: undefined },
    { ...timed, count: 2 },
  ])
    assert.throws(() => checkToolTiming(messages(step)));
  assert.throws(() => checkToolTiming([]));
});

test("checks an observed fifty-second background interval and rejects an estimated total", () => {
  const work = { startedAt: "2026-01-01T00:00:05Z", endedAt: "2026-01-01T00:00:55Z" };
  assert.doesNotThrow(() => checkBackgroundTiming({ backgroundWork: [work] }));
  assert.throws(() =>
    checkBackgroundTiming({ backgroundWork: [{ ...work, estimateMs: 300_000 }] }),
  );
  assert.throws(() => checkBackgroundTiming({ backgroundWork: [] }));
});
