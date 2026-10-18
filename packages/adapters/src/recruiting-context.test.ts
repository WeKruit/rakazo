import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";
import { buildRecruitingResearchRequest } from "./recruiting-research.js";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

const db = vi.hoisted(() => ({ workspace: vi.fn(), adopt: vi.fn(), feedback: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<object>()),
  getRecruitingWorkspace: db.workspace,
  recordRecruitingContextAdoption: db.adopt,
  listRecruitingFeedback: db.feedback,
}));

const run = { id: "run", spaceId: "space", userId: "owner", botId: "bot", threadId: "thread" };
const context: AdapterContext = {
  ...run,
  runId: run.id,
  operationId: "operation",
  traceId: "trace",
  signal: new AbortController().signal,
};
const workspace = {
  role: {
    id: "role",
    spaceId: run.spaceId,
    userId: run.userId,
    sourceThreadId: run.threadId,
    title: "Engineer",
    revision: 1,
    currentRevisionId: "revision",
  },
  revision: {
    id: "revision",
    roleId: "role",
    revision: 1,
    sourceRefs: [],
    preferences: [],
    definitionQuestions: [],
    createdAt: "2026-10-15T00:00:00.000Z",
    criteria: [
      {
        id: "years",
        priority: "hard",
        expression: {
          kind: "atom",
          id: "years",
          statement: "Seven years; secret-value",
        },
        sourceRefs: [],
        definitionQuestions: [],
      },
    ],
  },
} satisfies LoadedRecruitingRunContext["workspace"];

function fixture() {
  const bytes = new Map<string, Uint8Array>();
  let number = 0;
  const artifacts = {
    describe: () => ({
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { stream: false },
    }),
    put: vi.fn(async ({ bytes: content }) => {
      const id = `blob-${++number}`;
      bytes.set(id, new Uint8Array(content));
      return { id, hash: "provider hash is not SHA256" };
    }),
    get: vi.fn(async (id) => bytes.get(id)!),
    remove: vi.fn(async (id) => {
      bytes.delete(id);
    }),
  } satisfies ArtifactStore;
  const deps = {
    prisma: {} as PrismaClient,
    artifacts,
    events: { notify: vi.fn(async () => undefined) },
  };
  const saved = new Map<string, { artifact: object; event: object }>();
  db.adopt.mockImplementation(async (_prisma, _actor, input) => {
    const previous = saved.get(input.artifact.clientNonce);
    if (previous) return { ...previous, created: false };
    const result = {
      artifact: { id: `artifact-${saved.size}`, ...input.artifact },
      event: { threadId: run.threadId, seq: saved.size },
    };
    saved.set(input.artifact.clientNonce, result);
    return { ...result, created: true };
  });
  return { deps, artifacts, bytes, saved };
}

describe("recruiting run context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.mockResolvedValue(workspace);
    db.feedback.mockResolvedValue({ feedback: [], nextCursor: null });
  });

  it("adopts bounded durable human feedback with the role context after restart", async () => {
    const { deps } = fixture();
    const feedback = [
      {
        id: "feedback",
        source: { quote: "Use Example Candidate as a positive example" },
        feedback: { target: "candidate", candidateKeys: ["candidate"] },
      },
    ];
    db.feedback.mockResolvedValueOnce({ feedback, nextCursor: "older-feedback" });
    const loaded = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "restart",
    });
    expect(db.feedback).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ userId: run.userId }),
      { roleId: workspace.role.id, limit: 20 },
    );
    expect(loaded!.text).toContain(JSON.stringify(feedback));
    expect(loaded!.text).toContain("same originating research task");
    expect(loaded!.manifest.text).toContain(JSON.stringify(feedback));
  });

  it("bounds adopted feedback and points to its original source when a receipt exceeds the budget", async () => {
    const { deps } = fixture();
    const quote = "human feedback ".repeat(1500);
    db.feedback.mockResolvedValueOnce({
      feedback: [{ source: { quote, anchor: { kind: "message", messageId: "oversize-source" } } }],
      nextCursor: null,
    });
    const loaded = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "restart",
    });
    expect(loaded!.text).not.toContain(quote);
    expect(loaded!.text).toContain("omits further saved feedback");
    expect(loaded!.text).toContain("oversize-source");
  });

  it.each([
    ["present", workspace, 1],
    ["absent", null, 2],
  ] as const)(
    "keeps adoption validation for a %s native role workspace",
    async (_label, native, reads) => {
      db.workspace.mockResolvedValueOnce(native);
      const { deps } = fixture();
      deps.prisma = {
        run: { findFirst: vi.fn().mockResolvedValue({ ...run, bot: run }) },
      } as unknown as PrismaClient;
      const result = await executeRecruitingRoleTool(
        deps.prisma,
        {
          actor: { spaceId: run.spaceId, userId: run.userId, email: "", isDeploymentOwner: false },
          runId: run.id,
          sourceMessageId: null,
        },
        { operation: "read" },
      );
      const adopted = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
        reason: "role_tool",
        placement: "tool_result",
        trustedWorkspace: result.workspace ?? undefined,
      });

      expect(result.workspace).toBe(native);
      expect(db.workspace).toHaveBeenCalledTimes(reads);
      expect(adopted!.workspace).toBe(workspace);
      expect(db.adopt).toHaveBeenCalledExactlyOnceWith(
        deps.prisma,
        { spaceId: run.spaceId, userId: run.userId, email: "", isDeploymentOwner: false },
        expect.objectContaining({
          runId: run.id,
          threadId: run.threadId,
          botId: run.botId,
          roleId: workspace.role.id,
          roleRevisionId: workspace.revision.id,
        }),
      );
      expect(adopted!.manifest.placement).toBe("tool_result");
      expect(deps.events.notify).toHaveBeenCalledOnce();
    },
  );

  it.each(["instructions", "tool_result", "steering"] as const)(
    "distinguishes authorized exploration and continuation from formal calibration gates in %s context",
    async (placement) => {
      const { deps } = fixture();
      const loaded = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
        reason: "feedback",
        placement,
      });
      const text = loaded!.manifest.roleText;
      expect(text).toContain(
        "Intake, company/JD research and recovery reads do not require redundant confirmation",
      );
      expect(text).toContain(
        "Formal calibration requires actual human G0 approval and G1 approval of the JD/deck package",
      );
      expect(text).toContain("the human explicitly deferred S2 after G0");
      expect(text).toContain("Reconfirm materially revised requirements or JD/deck");
      expect(text).toContain(
        "Outside formal calibration or scale, small-scale exploration or same-task feedback/more results explicitly authorized by the current human request do not require G0/G1",
      );
      expect(text).toContain("follow the requested scope and usage limits");
      expect(text).toContain("reuse the same verified provider task for continuation");
      expect(text).toContain("Keep unknowns and pending cards");
      expect(text).toContain(
        "this does not approve requirements, JD/deck, business policies, calibration or scale",
      );
      expect(text).toContain("never recast changed qualification as round-only scope");
      expect(text).toContain(
        "G2 approval of the calibration profiles and rule changes is required before scale",
      );
      expect(text).toContain("These formal calibration/scale gates apply to native MCP too");
      expect(text).toContain(
        "ordinary continuation does not require saved-workspace research actions",
      );
      expect(text).toContain("Scheduling and outbound require their native approvals");
      expect(text).not.toContain("research requires G0 on the current brief revision");
      expect(text).not.toContain("Candidate sourcing requires actual human G0 approval");
      expect(loaded!.text).toContain(text);
      expect(loaded!.manifest.placement).toBe(placement);
      expect(loaded!.workspace).toBe(workspace);
    },
  );

  it("freezes retrieval filters separately from qualification in create and same-task continuation", async () => {
    const source = {
      id: "human-filter",
      kind: "original_material" as const,
      anchor: { kind: "message" as const, messageId: "human", locator: "blocks[0].text" },
      readState: "read" as const,
      readAt: "2026-10-16T00:00:00Z",
      quote: "Search this role",
    };
    const brief = {
      searchFilters: [
        {
          id: "agencies",
          statement: "Exclude staffing agencies from retrieval",
          mode: "exclude" as const,
          origin: "user_instruction" as const,
          sourceRefIds: [source.id],
        },
      ],
      fields: ["salary_range", "location"].map((key) => ({
        key,
        value: key === "location" ? "Unrestricted" : "GBP 90,000 to 120,000",
        state: "known" as const,
        origin: "user_instruction" as const,
        consequential: true,
        sourceRefIds: [source.id],
      })),
      rules: [
        {
          criterionId: "years",
          origin: "user_instruction" as const,
          effect: "reject" as const,
          sourceRefIds: [source.id],
        },
      ],
      questions: [],
      confirmation: {
        revision: 1,
        userId: "owner",
        messageId: "confirmation",
        confirmedAt: "2026-10-16T00:00:00Z",
      },
    };
    const current = {
      ...workspace,
      revision: { ...workspace.revision, brief, sourceRefs: [source] },
    };
    db.workspace.mockResolvedValue(current);
    const { deps } = fixture();
    const first = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "search",
    });
    const input = {
      source,
      intent: { basis: "direct" as const, quote: source.quote },
      purpose: "calibration" as const,
      approvalEffectId: "documents-approved",
      route: {
        connectorId: "mcp" as const,
        resourceId: "sourcing",
        resourceRevision: 1,
        toolName: "research" as const,
      },
      instructions: "Find profiles with source evidence for every criterion.",
      output: "Return all found profiles, including missing evidence.",
      recallScope: null,
    };
    const created = buildRecruitingResearchRequest({
      ...input,
      context: first!,
      operation: "create",
    });
    expect(created.manifest.args).toHaveProperty(
      "prompt",
      expect.stringContaining("Search filters control retrieval only"),
    );
    expect(JSON.stringify(created.manifest.args)).toContain(
      "Exclude staffing agencies from retrieval",
    );
    expect(JSON.stringify(created.manifest.args)).toContain("Seven years; secret-value");
    const next = {
      role: { ...current.role, revision: 2, currentRevisionId: "revision-2" },
      revision: {
        ...current.revision,
        id: "revision-2",
        revision: 2,
        brief: {
          ...brief,
          searchFilters: [],
          confirmation: { ...brief.confirmation, revision: 2 },
        },
      },
    };
    db.workspace.mockResolvedValue(next);
    const refreshed = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "filter edit",
    });
    const continued = buildRecruitingResearchRequest({
      ...input,
      context: refreshed!,
      operation: "continue",
      providerTaskId: "existing-provider-task",
      route: { ...input.route, toolName: "reply" },
    });
    expect(continued.manifest.args).toHaveProperty("task_id", "existing-provider-task");
    expect(JSON.stringify(continued.manifest.args)).not.toContain(
      "Exclude staffing agencies from retrieval",
    );
    expect(JSON.stringify(continued.manifest.args)).toContain("Seven years; secret-value");
    expect(continued.sha256).not.toBe(created.sha256);
    expect(refreshed!.contextArtifact.artifactId).not.toBe(first!.contextArtifact.artifactId);
    expect(current.revision.brief.searchFilters).toHaveLength(1);
  });

  it("does not publish an adoption when the authorized thread has no role", async () => {
    db.workspace.mockResolvedValue(null);
    const { deps, artifacts } = fixture();
    await expect(
      loadRecruitingRunContext(deps, run, { documents: [] }, context, { reason: "run" }),
    ).resolves.toBeUndefined();
    expect(db.workspace).toHaveBeenCalledWith(
      deps.prisma,
      { spaceId: run.spaceId, userId: run.userId, email: "", isDeploymentOwner: false },
      { threadId: run.threadId },
    );
    expect(artifacts.put).not.toHaveBeenCalled();
    expect(db.adopt).not.toHaveBeenCalled();
  });

  it("freezes exact untruncated role, actual memory and recall text in native artifact bytes", async () => {
    const { deps, bytes, artifacts } = fixture();
    const memory = {
      text: "actual memory text",
      documents: [
        {
          id: "memory",
          scope: "user" as const,
          path: "preference.md",
          revision: 3,
          sha256: "a".repeat(64),
          includedContent: "actual memory text",
          disposition: "truncated" as const,
        },
      ],
    };
    const result = await loadRecruitingRunContext(deps, run, memory, context, {
      reason: "steering",
      sourceMessageId: "message",
      recallScope: "Bay Area first",
      redact: (value) => value.replaceAll("secret-value", "[redacted]"),
    });
    expect(result!.workspace).toEqual(workspace);
    expect(result!.text).toContain("Seven years; [redacted]");
    expect(result!.text).toContain("Bay Area first");
    expect(result!.text).not.toContain(
      "Internal routing identifiers belong only in tool arguments",
    );
    expect(result!.text).toContain(memory.text);
    expect(result!.text).not.toContain("secret-value");
    const stored = bytes.get("blob-1")!;
    const manifest = JSON.parse(Buffer.from(stored).toString("utf8"));
    expect(manifest).toMatchObject({
      roleId: "role",
      roleRevisionId: "revision",
      roleRevision: 1,
      actor: { spaceId: "space", userId: "owner" },
      runId: "run",
      threadId: "thread",
      botId: "bot",
      text: result!.text,
      memory,
      recallScope: "Bay Area first",
      reason: "steering",
      sourceMessageId: "message",
    });
    expect(result!.contextArtifact).toEqual({
      artifactId: "artifact-0",
      sha256: createHash("sha256").update(stored).digest("hex"),
    });
    expect(artifacts.put).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/json" }),
      context,
    );
    expect(deps.events.notify).toHaveBeenCalledWith("thread", 0);
  });

  it("redacts quoted and multiline secret values before serializing role context", async () => {
    const secret = 'synthetic "quoted"\ncredential';
    db.workspace.mockResolvedValue({
      ...workspace,
      revision: {
        ...workspace.revision,
        criteria: [
          {
            ...workspace.revision.criteria[0],
            expression: {
              kind: "atom",
              id: "years",
              statement: `Seven years; ${secret}`,
            },
          },
        ],
      },
    });
    const { deps, bytes } = fixture();
    const result = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "run",
      redact: (value) => value.replaceAll(secret, "[redacted]"),
    });
    expect(result!.manifest.roleText).toContain('"statement": "Seven years; [redacted]"');
    expect(result!.text).not.toContain(JSON.stringify(secret).slice(1, -1));
    const manifest = JSON.parse(Buffer.from(bytes.get("blob-1")!).toString("utf8"));
    expect(manifest.roleText).toBe(result!.manifest.roleText);
  });

  it("reuses the first frozen manifest on resume without deleting possibly shared blobs", async () => {
    const { deps, artifacts, bytes, saved } = fixture();
    const first = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "run",
      sourceMessageId: "first-message",
    });
    const resumed = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "restart",
      sourceMessageId: "later-message",
    });
    expect(resumed!.contextArtifact).toEqual(first!.contextArtifact);
    expect(resumed!.manifest).toEqual(first!.manifest);
    expect(resumed!.manifest.reason).toBe("run");
    expect(saved.size).toBe(1);
    expect(bytes.size).toBe(2);
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(deps.events.notify).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("rejects a stale revision with workspace reuse %s", async (reuse) => {
    const { deps, artifacts, bytes } = fixture();
    db.adopt.mockRejectedValue(new Error("Recruiting revision changed"));
    await expect(
      loadRecruitingRunContext(deps, run, { documents: [] }, context, {
        reason: reuse ? "role_tool" : "run",
        ...(reuse ? { trustedWorkspace: workspace } : {}),
      }),
    ).rejects.toThrow("Recruiting revision changed");
    expect(db.adopt).toHaveBeenCalledOnce();
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(bytes.size).toBe(1);
    expect(deps.events.notify).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a different actor with workspace reuse %s", async (reuse) => {
    const { deps, artifacts } = fixture();
    await expect(
      loadRecruitingRunContext(
        deps,
        run,
        { documents: [] },
        { ...context, userId: "other" },
        { reason: "run", ...(reuse ? { trustedWorkspace: workspace } : {}) },
      ),
    ).rejects.toThrow();
    expect(db.workspace).not.toHaveBeenCalled();
    expect(artifacts.put).not.toHaveBeenCalled();
    expect(db.adopt).not.toHaveBeenCalled();
  });

  it("records the actual injection channel as part of adoption identity", async () => {
    const { deps, saved } = fixture();
    const instructions = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "run",
      placement: "instructions",
    });
    const steering = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "steering",
      placement: "steering",
    });
    expect(steering!.manifest.placement).toBe("steering");
    expect(steering!.contextArtifact.artifactId).not.toBe(instructions!.contextArtifact.artifactId);
    expect(saved.size).toBe(2);
    expect(db.workspace).toHaveBeenCalledTimes(2);
  });

  it("verifies immutable stored bytes before returning a resumed manifest", async () => {
    const { deps, artifacts } = fixture();
    await loadRecruitingRunContext(deps, run, { documents: [] }, context, { reason: "run" });
    artifacts.get.mockResolvedValue(Buffer.from("modified saved bytes"));
    await expect(
      loadRecruitingRunContext(deps, run, { documents: [] }, context, { reason: "restart" }),
    ).rejects.toThrow("hash does not match");
  });

  it("keeps role definition complete beyond the memory byte budget", async () => {
    db.workspace.mockResolvedValue({
      ...workspace,
      revision: { ...workspace.revision, preferences: ["role requirement ".repeat(4000)] },
    });
    const { deps } = fixture();
    const result = await loadRecruitingRunContext(deps, run, { documents: [] }, context, {
      reason: "run",
    });
    expect(result!.text).toContain("role requirement ".repeat(4000));
    expect(Buffer.byteLength(result!.manifest.roleText, "utf8")).toBeGreaterThan(32 * 1024);
  });
});
