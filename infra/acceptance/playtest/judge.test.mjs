import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeRound, parseJudgement, SpendCap, summarizeRound } from "./judge.mjs";

const judged = (scores, failed = "none", defects = "") =>
  `SCORES ${scores}\nCHECKS 3/3   FAILED: ${failed}\nDEFECTS\n${defects}`;
const fives = "concise=5 correct=5 judgment=5 voice=5 magic=5";

test("reads scores, failed checks and defects, and rejects a malformed reply", () => {
  const parsed = parseJudgement(
    judged(
      "concise=3 correct=4 judgment=5 voice=5 magic=4",
      "first ten shown, stops at target",
      '- correct: asked for the location twice | violates: "Never ask for what is known."\n- concise: three status messages',
    ),
  );
  assert.deepEqual(parsed.scores, { concise: 3, correct: 4, judgment: 5, voice: 5, magic: 4 });
  assert.deepEqual(parsed.checks.failed, ["first ten shown", "stops at target"]);
  assert.deepEqual(parsed.defects, [
    {
      dimension: "correct",
      what: "asked for the location twice",
      violates: "Never ask for what is known.",
    },
    { dimension: "concise", what: "three status messages", violates: null },
  ]);
  assert.equal(parseJudgement("SCORES concise=9"), null);
});

test("a round passes only at 4.5 everywhere with no failed sample; one-off defects never recur", () => {
  const sample = (name, text) => ({ name, judgement: parseJudgement(text) });
  const repeated = '- correct: re-asked | violates: "Never ask for what is known."';
  const round = summarizeRound([
    sample("a#1", judged(fives, "none", repeated)),
    sample("a#2", judged("concise=4 correct=4 judgment=5 voice=5 magic=5", "none", repeated)),
    sample(
      "b#1",
      judged(
        "concise=3 correct=5 judgment=5 voice=5 magic=5",
        "none",
        "- voice: said a vendor name",
      ),
    ),
  ]);
  assert.equal(round.passed, false);
  assert.equal(round.averages.concise, 4);
  assert.equal(round.recurring.length, 1);
  assert.equal(round.recurring[0].violates, "Never ask for what is known.");
  assert.equal(
    summarizeRound([sample("a", judged(fives)), sample("b", judged(fives))]).passed,
    true,
  );
  assert.equal(summarizeRound([sample("a", judged(fives, "booked without card"))]).passed, false);
  assert.equal(summarizeRound([{ name: "broken", judgement: null }]).passed, false);
});

test("stops before a call that could pass the cap and counts reported usage", () => {
  const cap = new SpendCap({ capUsd: 0.01, inPerMTok: 3, outPerMTok: 15 });
  cap.record({ prompt_tokens: 1000, completion_tokens: 100 });
  assert.equal(Math.round(cap.spentUsd * 1e6), 4500);
  assert.throws(() => cap.reserve(30_000, 1500), /US\$0.01 cap/);
});

test("judges each sample in its own request and drafts a fix only for recurring defects", async () => {
  const calls = [];
  const repeated = '- correct: re-asked | violates: "Never ask for what is known."';
  const replies = [
    judged(fives, "none", repeated),
    judged(fives, "none", repeated),
    "BEFORE: x\nAFTER: y\nWHY: z",
  ];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({
      choices: [{ message: { content: replies[calls.length - 1] } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
  };
  const report = await judgeRound({
    samples: [
      { name: "s#1", scenario: "scenario one", transcript: "transcript one" },
      { name: "s#2", scenario: "scenario one", transcript: "transcript two" },
    ],
    instructions: "Never ask for what is known.",
    rubric: "rubric",
    cap: new SpendCap({ capUsd: 3, inPerMTok: 3, outPerMTok: 15 }),
    fetchImpl,
    env: { JUDGE_BASE_URL: "https://judge.example.test/v1", JUDGE_API_KEY: "k", JUDGE_MODEL: "m" },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].messages[1].content.includes("transcript one"));
  assert.ok(!calls[0].messages[1].content.includes("transcript two"));
  assert.equal(report.fixes.length, 1);
  assert.match(report.fixes[0].proposal, /AFTER: y/);
  assert.equal(report.spentUsd, 0.003);
});

test("benchmark compares a round with the last one in the history file", async () => {
  const { compareRounds, lastRound } = await import("./benchmark.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-")), "history.jsonl");
  assert.equal(lastRound(file), null);
  const averages = { concise: 4, correct: 4.5, judgment: 5, voice: 5, magic: 4 };
  fs.appendFileSync(file, `${JSON.stringify({ averages })}\n`);
  assert.deepEqual(compareRounds(lastRound(file), { averages: { ...averages, concise: 4.5 } }), {
    concise: 0.5,
    correct: 0,
    judgment: 0,
    voice: 0,
    magic: 0,
  });
  assert.equal(compareRounds(null, { averages }), null);
});
