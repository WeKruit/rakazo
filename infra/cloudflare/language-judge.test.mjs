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
const judgeAnswering = (p, calls = []) => {
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ answers: { answer: { noul: p } } }));
  };
  return calls;
};

test("asks the judge about one row with the name hidden and answers its verdict", async () => {
  const calls = judgeAnswering(0.8);
  const response = await post({
    requirement: "Must speak Mandarin",
    name: "Wei Test",
    profile: "Wei Test, Languages: Mandarin",
  });
  expect(await response.json()).toEqual({ verdict: "shown", p: 0.8 });
  expect(calls[0].headers.authorization).toBe("Bearer key");
  const body = JSON.parse(calls[0].body);
  expect(body.state.profile).toBe("[name], Languages: Mandarin");
  expect(body.questions.answer.instructions).toMatch(/"Must speak Mandarin"/);
});

test("maps the probability to a verdict and refuses what it cannot judge", async () => {
  for (const [p, verdict] of [
    [0.6, "shown"],
    [0.3, "unclear"],
    [0.1, "no sign"],
  ]) {
    judgeAnswering(p);
    const response = await post({ requirement: "Mandarin", profile: "x" });
    expect((await response.json()).verdict).toBe(verdict);
  }
  expect((await post({ requirement: "Mandarin", profile: "x" }, "")).status).toBe(401);
  expect((await post({ profile: "x" })).status).toBe(400);
  globalThis.fetch = async () => new Response("", { status: 500 });
  expect((await post({ requirement: "Mandarin", profile: "x" })).status).toBe(502);
});
