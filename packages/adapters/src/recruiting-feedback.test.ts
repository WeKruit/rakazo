import type { AdapterContext, MemoryCommitRequest, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { Actor, RecruitingPreferenceFeedbackInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeRecruitingFeedback } from "./recruiting-feedback.js";

const db = vi.hoisted(() => ({ readContext: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<object>()),
  readRecruitingFeedbackContext: db.readContext,
}));
const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const trusted = { actor, runId: "run", sourceMessageId: "human" };
const context: AdapterContext = {
  spaceId: actor.spaceId,
  userId: actor.userId,
  botId: "bot",
  runId: "run",
  operationId: "run",
  traceId: "run",
  signal: new AbortController().signal,
};
const intent = { basis: "direct", quote: "Always show the complete prompt" } as const;
const source = {
  id: "human-message:human",
  kind: "original_material",
  anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
  readState: "read",
  readAt: "2026-10-15T00:00:00.000Z",
  quote: intent.quote,
};
const workspace = {
  role: { id: "role", sourceThreadId: "earlier-role-thread" },
  revision: { id: "role-revision", revision: 1 },
};
const preference: RecruitingPreferenceFeedbackInput = {
  target: "preference",
  operation: "add",
  scope: "user",
  path: "preferences.md",
  expectedRevision: 1,
  intent,
  sourceRefs: [],
  content: "Show the complete prompt",
};

function fixture(content = "keep this preference", revision = 1) {
  const read = vi.fn(async () => ({
    documents: revision ? [{ id: "doc", path: preference.path, content, revision }] : [],
  }));
  const commit = vi.fn(async (request: MemoryCommitRequest) => ({
    id: "doc",
    path: request.path,
    content: request.content,
    revision: request.expectedRevision + 1,
  }));
  return {
    read,
    commit,
    deps: { prisma: {} as PrismaClient, memory: { read, commit } as unknown as MemoryStore },
  };
}

describe("recruiting feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.readContext.mockResolvedValue({
      source,
      workspace,
      threadId: "actual-run-thread",
      botId: "bot",
    });
  });

  it("constructs and commits one reusable preference with runtime provenance and the loaded revision", async () => {
    const f = fixture();
    const result = await executeRecruitingFeedback(f.deps, trusted, preference, context);
    expect(db.readContext).toHaveBeenCalledWith(f.deps.prisma, actor, {
      runId: "run",
      sourceMessageId: "human",
      intent,
      sourceRefs: [],
    });
    expect(f.read).toHaveBeenCalledWith({ scope: "user", path: preference.path }, context);
    expect(f.commit).toHaveBeenCalledWith(
      {
        scope: "user",
        path: preference.path,
        content: "keep this preference\n\nShow the complete prompt",
        expectedRevision: 1,
        sourceRunId: "run",
        sourceThreadId: "actual-run-thread",
        recruiting: { sourceMessageId: "human", feedback: preference },
      },
      context,
    );
    expect(result).toMatchObject({
      status: "saved",
      source,
      workspace,
      document: {
        id: "doc",
        scope: "user",
        path: preference.path,
        revision: 2,
        anchor: { start: 22, end: 46, quote: preference.content },
      },
    });
  });

  it("uses trusted bot scope and revision zero for a new document", async () => {
    const f = fixture("", 0);
    await executeRecruitingFeedback(
      f.deps,
      trusted,
      { ...preference, scope: "bot", expectedRevision: 0 },
      context,
    );
    expect(f.read).toHaveBeenCalledWith(
      { scope: "bot", botId: "bot", path: preference.path },
      context,
    );
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "bot",
        botId: "bot",
        expectedRevision: 0,
        content: preference.content,
      }),
      context,
    );
  });

  it("returns inferred intent for clarification without reading or writing memory", async () => {
    const f = fixture();
    const result = await executeRecruitingFeedback(
      f.deps,
      trusted,
      { ...preference, intent: { ...intent, basis: "inferred" } },
      context,
    );
    expect(result).toMatchObject({ status: "needs_clarification", source });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("keeps role feedback as a scoped proposal", async () => {
    const f = fixture();
    const input = {
      target: "role",
      operation: "revise",
      roleId: "role",
      expectedRoleRevision: 1,
      summary: "Scoped feedback",
      intent,
      sourceRefs: [],
    };
    expect(await executeRecruitingFeedback(f.deps, trusted, input, context)).toMatchObject({
      status: "proposed",
      nextTool: "recruiting_role",
      feedback: input,
      source,
    });
    expect(db.readContext).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ roleId: "role", expectedRoleRevision: 1 }),
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("records round feedback for the native receipt without forcing a research action", async () => {
    const f = fixture();
    const roundIntent = {
      basis: "direct",
      quote: "Prioritize infrastructure evidence in this search.",
    } as const;
    const humanSource = { ...source, quote: roundIntent.quote };
    db.readContext.mockResolvedValueOnce({
      source: humanSource,
      workspace,
      threadId: "actual-run-thread",
      botId: "bot",
    });
    const input = {
      target: "round",
      operation: "scope",
      roleId: "role",
      expectedRoleRevision: 1,
      summary: roundIntent.quote,
      intent: roundIntent,
      sourceRefs: [],
    };
    expect(await executeRecruitingFeedback(f.deps, trusted, input, context)).toEqual({
      status: "recorded",
      feedback: input,
      source: humanSource,
      workspace,
    });
    expect(db.readContext).toHaveBeenCalledWith(f.deps.prisma, actor, {
      runId: trusted.runId,
      sourceMessageId: trusted.sourceMessageId,
      intent: roundIntent,
      sourceRefs: [],
      roleId: "role",
      expectedRoleRevision: 1,
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([["candidate"], ["candidate", "second", "third"]])(
    "records exactly the selected candidate subset %j without local assessment or memory",
    async (...candidateKeys) => {
      const f = fixture();
      const input = {
        target: "candidate",
        operation: "review",
        roleId: "role",
        expectedRoleRevision: 1,
        candidateKeys,
        summary: "Prefer this experience in the next search",
        intent,
        sourceRefs: [],
      };
      expect(await executeRecruitingFeedback(f.deps, trusted, input, context)).toEqual({
        feedback: input,
        source,
        workspace,
        status: "recorded",
      });
      expect(db.readContext).toHaveBeenCalledWith(
        f.deps.prisma,
        actor,
        expect.objectContaining({ candidateKeys }),
      );
      expect(f.read).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();
    },
  );

  it("revokes the last exact preference as an empty native revision", async () => {
    const f = fixture("old");
    const { content: _content, ...base } = preference;
    const result = await executeRecruitingFeedback(
      f.deps,
      trusted,
      { ...base, operation: "revoke", anchor: { start: 0, end: 3, quote: "old" } },
      context,
    );
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: "", expectedRevision: 1 }),
      context,
    );
    expect(result).toMatchObject({ status: "saved", document: { anchor: null, revision: 2 } });
  });

  it("refuses a changed revision without replacing the caller's expected revision", async () => {
    const f = fixture("concurrent edit", 2);
    await expect(executeRecruitingFeedback(f.deps, trusted, preference, context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("makes generic memory callers prove their full replacement matches the semantic edit", async () => {
    const f = fixture();
    const expectedMemory = {
      scope: "user" as const,
      path: preference.path,
      expectedRevision: 1,
      content: "keep this preference\n\nShow the complete prompt",
    };
    for (const invalid of [
      { content: "Unrelated role criteria" },
      { scope: "bot" },
      { path: "other.md" },
      { expectedRevision: 2 },
    ]) {
      await expect(
        executeRecruitingFeedback(f.deps, trusted, preference, context, {
          expectedMemory: { ...expectedMemory, ...invalid } as typeof expectedMemory,
        }),
      ).rejects.toMatchObject({ name: "RecruitingFeedbackValidationError" });
    }
    expect(f.commit).not.toHaveBeenCalled();
    await executeRecruitingFeedback(f.deps, trusted, preference, context, { expectedMemory });
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it("explains a pre-write summary mismatch and accepts the corrected exact preference edit", async () => {
    const f = fixture();
    const content =
      "# Recruiting preferences\n\n- Show the complete prompt.\n- Preserve source references.";
    const expectedMemory = {
      scope: preference.scope,
      path: preference.path,
      expectedRevision: preference.expectedRevision,
      content: `keep this preference\n\n${content}`,
    };
    await expect(
      executeRecruitingFeedback(f.deps, trusted, preference, context, { expectedMemory }),
    ).rejects.toMatchObject({
      name: "RecruitingFeedbackValidationError",
      message: expect.stringContaining(
        'Nothing was written. Use recruiting_feedback with target:"preference"',
      ),
    });
    expect(f.commit).not.toHaveBeenCalled();

    const corrected = { ...preference, content };
    await executeRecruitingFeedback(f.deps, trusted, corrected, context);
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope: expectedMemory.scope,
        path: expectedMemory.path,
        expectedRevision: expectedMemory.expectedRevision,
        content: expectedMemory.content,
        sourceRunId: trusted.runId,
        sourceThreadId: "actual-run-thread",
        recruiting: { sourceMessageId: trusted.sourceMessageId, feedback: corrected },
      }),
      context,
    );
    expect(db.readContext).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      runId: trusted.runId,
      sourceMessageId: trusted.sourceMessageId,
      intent: preference.intent,
      sourceRefs: preference.sourceRefs,
    });
  });

  it("rejects forged identity, unverified sources and mismatched adapter context before writing", async () => {
    const f = fixture();
    await expect(
      executeRecruitingFeedback(
        f.deps,
        trusted,
        { ...preference, sourceMessageId: "forged" },
        context,
      ),
    ).rejects.toThrow();
    expect(db.readContext).not.toHaveBeenCalled();
    await expect(
      executeRecruitingFeedback(f.deps, trusted, preference, { ...context, userId: "other" }),
    ).rejects.toThrow();
    expect(db.readContext).not.toHaveBeenCalled();
    db.readContext.mockRejectedValue(new Error("Source is unavailable"));
    await expect(executeRecruitingFeedback(f.deps, trusted, preference, context)).rejects.toThrow(
      "Source is unavailable",
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("rejects a sibling bot context before reading native preferences", async () => {
    const f = fixture();
    db.readContext.mockResolvedValue({
      source,
      workspace,
      threadId: "actual-run-thread",
      botId: "other-bot",
    });
    await expect(executeRecruitingFeedback(f.deps, trusted, preference, context)).rejects.toThrow(
      "does not belong",
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("classifies an exact-span mismatch as local validation without committing", async () => {
    const f = fixture("old");
    const { content: _content, ...base } = preference;
    await expect(
      executeRecruitingFeedback(
        f.deps,
        trusted,
        { ...base, operation: "revoke", anchor: { start: 0, end: 3, quote: "different" } },
        context,
      ),
    ).rejects.toMatchObject({
      name: "RecruitingFeedbackValidationError",
      message: "Preference anchor does not match the loaded memory revision",
    });
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(["read", "commit"] as const)(
    "propagates unexpected native memory %s errors unchanged",
    async (operation) => {
      const f = fixture();
      const error = new Error("Unexpected storage failure");
      f[operation].mockRejectedValue(error);
      await expect(executeRecruitingFeedback(f.deps, trusted, preference, context)).rejects.toBe(
        error,
      );
    },
  );
});
