import assert from "node:assert/strict";
import test from "node:test";
import {
  completionOutcome,
  completionSummary,
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
