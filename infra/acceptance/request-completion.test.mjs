import assert from "node:assert/strict";
import test from "node:test";
import {
  completionOutcome,
  completionSummary,
  overlapOf,
  overlapSummary,
  profilesIn,
  requestCompletion,
} from "./request-completion.mjs";

const link = (handle) => `[x](https://www.linkedin.com/in/${handle})`;
const at = (seconds) => new Date(Date.UTC(2026, 10, 24, 12, 0, seconds)).toISOString();
const say = (turn, seconds, people) => ({
  turn,
  at: at(seconds),
  move: { action: "say", text: "…", people },
});
const bot = (seconds, text) => ({ role: "bot", at: at(seconds), text });

test("profilesIn decodes and lowercases handles", () => {
  assert.deepEqual(
    [...profilesIn(`${link("Ann-Li")} and ${link("%E9%92%B0-a")} ${link("ann-li/")}`)],
    ["ann-li", "钰-a"],
  );
});

test("counts only new people shown before the next move, across chats", () => {
  const turns = [say(1, 0, 3), say(2, 100, 2), say(3, 200, 0), say(4, 300, 2)];
  const chats = [
    // The role chat lists the first round; Kruit's chat copies it (same people, not new twice).
    { messages: [bot(40, `${link("a")} ${link("b")}`), bot(150, link("c"))] },
    {
      messages: [
        bot(41, `${link("a")} ${link("b")}`),
        bot(60, link("z")),
        // A repeat of a person already shown is not new.
        bot(160, link("a")),
        bot(250, "现有 79 人，搜索已完成"),
      ],
    },
  ];
  assert.deepEqual(requestCompletion(turns, chats), [
    { turn: 1, asked: 3, shown: 3, seconds: 60 },
    { turn: 2, asked: 2, shown: 1, seconds: 50 },
    { turn: 4, asked: 2, shown: 0, seconds: null },
  ]);
});

test("a large ask also counts the new graded fits in Results", () => {
  const turns = [
    { ...say(1, 0, 60), records: [{ chat: "Role", saved: 90, fit: 55 }] },
    { ...say(2, 100, 3), records: [{ chat: "Role", saved: 95, fit: 58 }] },
  ];
  // The chat lists the top two and a link; three more are shown for the small ask.
  const chats = [
    { messages: [bot(50, `${link("a")} ${link("b")}`), bot(150, link("c"))] },
  ];
  assert.deepEqual(
    requestCompletion(turns, chats).map((row) => row.shown),
    [55, 1],
  );
});

test("outcomes and summary", () => {
  const rows = [
    { asked: 3, shown: 3, seconds: 60 },
    { asked: 2, shown: 1, seconds: 50 },
    { asked: 2, shown: 0, seconds: null },
  ].map((row, i) => ({ ...row, outcome: completionOutcome(row, i === 1 ? "said" : "not said") }));
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["delivered", "stated", "not delivered"],
  );
  assert.deepEqual(completionSummary(rows), {
    requests: 3,
    delivered: 1,
    stated: 1,
    notDelivered: 1,
    p50: 50,
    p90: 50,
  });
});

test("overlap of searches and runs left going", () => {
  const rows = [
    overlapOf([{ chat: "Role", finds: 30, foundAgain: 6, sameLinkedIn: 1 }, { chat: "Kruit" }]),
    {
      ...overlapOf([{ chat: "Other", finds: 10, foundAgain: 0 }]),
      leftRunning: [{ status: "running" }],
    },
    overlapOf([]),
  ];
  assert.deepEqual(rows[2], {});
  assert.deepEqual(overlapSummary(rows), {
    plays: 3,
    finds: 40,
    foundAgain: 6,
    sameLinkedIn: 1,
    leftRunning: 1,
  });
});
