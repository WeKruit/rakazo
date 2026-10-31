import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewerGradingEvidence, checkReviewerGrading } from "./reviewer-grading.mjs";

function evidence() {
  return {
    reviewerId: "reviewer",
    roleId: "role",
    events: [
      {
        type: "run.started",
        botId: "reviewer",
        runId: "grade",
        payload: { trigger: "recruiting_grade" },
      },
      {
        type: "recruiting.candidates.saved",
        botId: "reviewer",
        runId: "grade",
        payload: {
          roleId: "role",
          effectId: "page",
          outputArtifact: { artifactId: "artifact", sha256: "hash" },
        },
      },
    ],
    research: { tasks: [], actions: [] },
    candidates: [
      {
        roleId: "role",
        candidateKey: "person",
        match: { score: 0 },
        latestSource: {
          effectId: "page",
          artifactRef: { artifactId: "artifact", sha256: "hash" },
        },
      },
    ],
  };
}

test("requires native Reviewer grading and a scored row from its exact saved output", () => {
  assert.deepEqual(assertReviewerGradingEvidence(evidence()), { gradingRuns: 1, savedGrades: 1 });
  for (const change of [
    (value) => {
      value.events[0].botId = "sourcer";
    },
    (value) => {
      value.events[1].botId = "sourcer";
    },
    (value) => {
      value.events[1].runId = "initial-search";
    },
    (value) => {
      value.events.shift();
    },
    (value) => {
      value.events.pop();
    },
    (value) => {
      value.candidates[0].match.score = null;
    },
    (value) => {
      value.candidates[0].latestSource.artifactRef.sha256 = "different";
    },
    (value) => {
      value.candidates[0].latestSource.effectId = "initial-search-page";
    },
    (value) => {
      value.candidates[0].roleId = "different-role";
    },
  ]) {
    const value = evidence();
    change(value);
    assert.throws(() => assertReviewerGradingEvidence(value));
  }
});

test("follows async research into a later Reviewer wake using retained task/action/artifact proof", () => {
  const value = evidence();
  value.events.push({
    type: "run.started",
    botId: "reviewer",
    runId: "wake",
    payload: { trigger: "recruiting_grade" },
  });
  value.events[1] = {
    type: "recruiting.read",
    botId: "reviewer",
    runId: "wake",
    payload: {
      phase: "recorded",
      taskId: "task",
      actionId: "action",
      effectId: "page",
      outputArtifact: { artifactId: "artifact", sha256: "hash" },
    },
  };
  value.research = {
    tasks: [{ id: "task", roleId: "role", createdByRunId: "grade" }],
    actions: [
      {
        id: "action",
        taskId: "task",
        runId: "grade",
        effectId: "research-start-effect",
        outputArtifacts: [{ artifactId: "artifact", sha256: "hash" }],
      },
    ],
  };
  assert.deepEqual(assertReviewerGradingEvidence(value), { gradingRuns: 2, savedGrades: 1 });
  value.research.tasks[0].createdByRunId = "sourcer-run";
  assert.throws(() => assertReviewerGradingEvidence(value));
  value.research.tasks[0].createdByRunId = "grade";
  value.research.actions[0].outputArtifacts = [];
  assert.throws(() => assertReviewerGradingEvidence(value));
});

test("live helper only reads the existing native copy and source-scoped saved candidates", async () => {
  const value = evidence();
  const calls = [];
  const rpc = async (route, input) => {
    calls.push({ route, input });
    switch (route) {
      case "groups/get":
        return {
          name: "测试副本 · acceptance",
          members: ["Main", "Sourcer", "Outreach", "Reviewer"].map((name) => ({
            name,
            botId: name.toLowerCase(),
          })),
        };
      case "threads/get":
        return { threadId: "thread" };
      case "recruiting/getWorkspace":
        return { role: { id: "role" } };
      case "recruiting/listResearch":
        return value.research;
      case "recruiting/listCandidates":
        assert.equal(input.sourceEffectId, "page");
        return { items: value.candidates, nextCursor: null };
      default:
        throw new Error("unexpected write or provider route");
    }
  };
  assert.deepEqual(
    await checkReviewerGrading(rpc, "copy", async () => value.events, { maxWaitMs: 0 }),
    {
      gradingRuns: 1,
      savedGrades: 1,
    },
  );
  assert.equal(calls.filter(({ route }) => route === "recruiting/listCandidates").length, 1);
});
