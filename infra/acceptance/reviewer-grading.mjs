import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { assertTestCopy } from "./workloop-task-controls.mjs";

/** Native save proofs, including research that finishes in a later Reviewer wake. */
export function reviewerGradePages({ reviewerId, roleId, events, research }) {
  const starts = events.filter(
    (event) => event.type === "run.started" && event.payload?.trigger === "recruiting_grade",
  );
  assert.ok(
    starts.every((event) => event.botId === reviewerId),
    "a grading run belongs to a crew member other than Reviewer",
  );
  const runs = new Set(starts.map((event) => event.runId));
  const tasks = new Set(
    research.tasks
      .filter((task) => task.roleId === roleId && runs.has(task.createdByRunId))
      .map((task) => task.id),
  );
  const pages = new Map();
  for (const event of events) {
    if (event.botId !== reviewerId || !event.payload?.outputArtifact) continue;
    const payload = event.payload;
    const nativeSave =
      event.type === "recruiting.candidates.saved" &&
      payload.roleId === roleId &&
      runs.has(event.runId);
    const researchSave =
      event.type === "recruiting.read" &&
      payload.phase === "recorded" &&
      runs.has(event.runId) &&
      tasks.has(payload.taskId) &&
      research.actions.some(
        (action) =>
          action.id === payload.actionId &&
          action.taskId === payload.taskId &&
          action.outputArtifacts.some(
            (artifact) =>
              artifact.artifactId === payload.outputArtifact.artifactId &&
              artifact.sha256 === payload.outputArtifact.sha256,
          ),
      );
    if ((nativeSave || researchSave) && payload.effectId)
      pages.set(payload.effectId, payload.outputArtifact);
  }
  return { runs, pages };
}

export function assertReviewerGradingEvidence(evidence) {
  const { runs, pages } = reviewerGradePages(evidence);
  assert.ok(runs.size > 0, "no native Reviewer grading run was observed");
  const saved = new Set();
  for (const candidate of evidence.candidates) {
    const source = candidate.latestSource;
    const artifact = pages.get(source?.effectId);
    if (
      artifact &&
      candidate.roleId === evidence.roleId &&
      source.artifactRef?.artifactId === artifact.artifactId &&
      source.artifactRef?.sha256 === artifact.sha256 &&
      Number.isFinite(candidate.match?.score)
    )
      saved.add(candidate.candidateKey);
  }
  assert.ok(
    saved.size > 0,
    "Reviewer grading has no persisted scored candidate with native save proof",
  );
  return { gradingRuns: runs.size, savedGrades: saved.size };
}

/** Read-only follow-through of the harness's existing search; never starts paid work. */
export async function checkReviewerGrading(rpc, groupId, readEvents, { maxWaitMs = 120_000 } = {}) {
  await assertTestCopy(rpc, groupId);
  const group = await rpc("groups/get", { groupId });
  const reviewerId = group.members.find((member) => member.name === "Reviewer")?.botId;
  assert.ok(reviewerId, "the test-copy crew has no native Reviewer");
  const snapshot = await rpc("threads/get", { groupId });
  const workspace = await rpc("recruiting/getWorkspace", { threadId: snapshot.threadId });
  const roleId = workspace?.role.id;
  assert.ok(roleId, "the existing search has no recruiting role");
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const [events, research] = await Promise.all([
      readEvents(groupId),
      rpc("recruiting/listResearch", { roleId }),
    ]);
    const evidence = { reviewerId, roleId, events, research, candidates: [] };
    const { pages } = reviewerGradePages(evidence);
    // A source-scoped list avoids confusing an older sourcing score with Reviewer grades.
    for (const sourceEffectId of pages.keys()) {
      let cursor;
      do {
        const page = await rpc("recruiting/listCandidates", {
          roleId,
          sourceEffectId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        evidence.candidates.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
    }
    try {
      return assertReviewerGradingEvidence(evidence);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
  }
}
