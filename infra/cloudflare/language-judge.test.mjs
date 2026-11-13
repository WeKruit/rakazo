import { afterEach, expect, test } from "vitest";
import worker from "./language-judge.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (body, authorization = "Bearer key") =>
  worker.fetch(
    new Request("https://check.example/", {
      method: "POST",
      headers: authorization ? { authorization } : {},
      body: JSON.stringify(body),
    }),
  );
/** A judge that answers from the profile text, and records what it was asked. */
const judgeAnswering = (answer, calls = []) => {
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    const p = answer(JSON.parse(init.body).state.profile);
    return p === undefined
      ? new Response("", { status: 500 })
      : new Response(JSON.stringify({ answers: { answer: { noul: p } } }));
  };
  return calls;
};

test("judges every row of a batch on its whole profile", async () => {
  const profile = `Wei Test\n${"Controls work. ".repeat(2_000)}\nLanguages: Mandarin`;
  const calls = judgeAnswering((text) => (text.includes("Mandarin") ? 0.8 : 0.1));
  const response = await post({
    requirement: "Must speak Mandarin",
    rows: [
      { id: "a", name: "Wei Test", profile },
      { id: "b", name: "Joe Sample", profile: "Joe Sample, Technician" },
    ],
  });
  expect(await response.json()).toEqual({
    verdicts: { a: { verdict: "shown", p: 0.8 }, b: { verdict: "no sign", p: 0.1 } },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].headers.authorization).toBe("Bearer key");
  const first = JSON.parse(calls[0].body);
  expect(first.state.profile).toBe(profile);
  expect(first.questions.answer.instructions).toMatch(/"Must speak Mandarin"/);
});

test("maps the probability to a verdict, leaves out rows the judge fails, and refuses bad input", async () => {
  judgeAnswering((text) => ({ six: 0.6, three: 0.3, one: 0.1 })[text]);
  const response = await post({
    requirement: "Mandarin",
    rows: ["six", "three", "one", "fails"].map((id) => ({ id, profile: id })),
  });
  expect(await response.json()).toEqual({
    verdicts: {
      six: { verdict: "shown", p: 0.6 },
      three: { verdict: "unclear", p: 0.3 },
      one: { verdict: "no sign", p: 0.1 },
    },
  });
  const rows = [{ id: "a", profile: "x" }];
  expect((await post({ requirement: "Mandarin", rows }, "")).status).toBe(401);
  expect((await post({ rows })).status).toBe(400);
  expect((await post({ requirement: "Mandarin", rows: [] })).status).toBe(400);
});
