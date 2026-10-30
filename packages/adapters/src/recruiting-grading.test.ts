import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  GRADE_BATCH,
  GRADE_TOOL_CALL_LIMIT,
  gradingToolRefusal,
  gradingTools,
  RECRUITING_GRADE_NONCE_PREFIX,
  startRecruitingGrading,
} from "./recruiting-grading.js";

const now = Date.parse("2026-10-29T01:00:00Z");
const role = { id: "role", userId: "user", archivedAt: null };
const thread = {
  id: "thread",
  spaceId: "space",
  userId: "user",
  botId: null,
  groupId: "group",
  activeRecruitingRole: role,
};

type Occurrence = { candidateKey: string; name: string; linkedinUrl: string | null };
const person = (slug: string): Occurrence => ({
  candidateKey: `linkedin:/in/${slug}`,
  name: slug,
  linkedinUrl: `https://x.test/in/${slug}`,
});

function fixture(options: {
  busy?: boolean;
  found?: Occurrence[];
  graded?: string[];
  requests?: Array<{ id: string; createdAt: Date; task: { prompt: string } }>;
  /** Request run ids that started research. */
  researched?: string[];
  gradesSaved?: boolean;
  researchBots?: string[];
  /** Bots whose research assignment allows only reads of earlier research. */
  readOnlyBots?: string[];
}) {
  const runCreate = vi.fn(async () => ({ id: "grade-run" }));
  const taskCreate = vi.fn(async () => ({ id: "grade-task" }));
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: { findFirst: vi.fn(async () => null), create: runCreate },
    task: { create: taskCreate },
  };
  const prisma = {
    thread: { findUnique: vi.fn(async () => thread) },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { status?: unknown } }) =>
        where.status
          ? options.busy
            ? { id: "busy" }
            : null
          : options.gradesSaved
            ? { id: "wake" }
            : null,
      ),
      findMany: vi.fn(async () => options.requests ?? []),
    },
    recruitingResearchTask: {
      findMany: vi.fn(async () =>
        (options.researched ?? []).map((createdByRunId) => ({
          id: `research-${createdByRunId}`,
          createdByRunId,
        })),
      ),
    },
    recruitingCandidateOccurrence: {
      findMany: vi.fn(async ({ where }: { where: { page?: unknown } }) =>
        where.page
          ? (options.graded ?? []).map((candidateKey) => ({ candidateKey }))
          : (options.found ?? []),
      ),
    },
    chatGroupMember: {
      findMany: vi.fn(async () => [{ botId: "main" }, { botId: "sourcer" }]),
    },
    botMcpServer: {
      findMany: vi.fn(async () =>
        [...(options.readOnlyBots ?? []), ...(options.researchBots ?? ["sourcer"])].map(
          (botId) => ({
            botId,
            serverId: "server-1",
            allowAllTools: false,
            allowedTools: options.readOnlyBots?.includes(botId)
              ? ["get_task", "get_rows"]
              : ["research", "get_task", "get_rows"],
            server: { slug: "research" },
          }),
        ),
      ),
    },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: prisma as unknown as PrismaClient, jobs: { enqueue } },
    prisma,
    runCreate,
    taskCreate,
    enqueue,
  };
}

const promptOf = (f: ReturnType<typeof fixture>) =>
  (f.taskCreate.mock.calls[0] as unknown as [{ data: { prompt: string } }])[0].data.prompt;

describe("startRecruitingGrading", () => {
  it("sends people without a research grade to the research teammate, skipping anyone sent before", async () => {
    const f = fixture({
      found: [person("new-a"), person("graded"), person("sent"), person("new-b"), person("new-a")],
      graded: ["linkedin:/in/graded"],
      requests: [
        {
          id: "old-request",
          createdAt: new Date(now - 3 * 60 * 60_000),
          task: { prompt: "Grade these\n\n- sent: https://x.test/in/sent" },
        },
        {
          id: "never-started",
          createdAt: new Date(now - 4 * 60 * 60_000),
          task: { prompt: "Grade these\n\n- new-b: https://x.test/in/new-b" },
        },
      ],
      researched: ["old-request"],
    });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "sourcer",
        threadId: "thread",
        trigger: "recruiting_grade",
        clientNonce: expect.stringMatching(new RegExp(`^${RECRUITING_GRADE_NONCE_PREFIX}thread:`)),
      }),
    });
    const prompt = promptOf(f);
    expect(prompt).toContain("grade these 2 people");
    expect(prompt).toContain("- new-a: https://x.test/in/new-a");
    expect(prompt).toContain("- new-b: https://x.test/in/new-b");
    expect(prompt).not.toContain("in/graded");
    expect(prompt).not.toContain("in/sent");
    expect(prompt).toContain("don't look for anyone new");
    expect(prompt).toContain('connectors_execute_tool with id "server-1:research"');
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "grade-run" } }),
    );
  });

  it("sends at most one batch, newest first", async () => {
    const found = Array.from({ length: GRADE_BATCH + 5 }, (_, index) => person(`p${index}`));
    const f = fixture({ found });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(promptOf(f)).toContain(`grade these ${GRADE_BATCH} people`);
    expect(promptOf(f)).not.toContain(`in/p${GRADE_BATCH}\n`);
  });

  it("waits while a turn is working and checks again later", async () => {
    const f = fixture({ busy: true, found: [person("a")] });
    await startRecruitingGrading(f.deps, { threadId: "thread", attempt: 2 }, now);
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "recruiting_grade.start",
        payload: { threadId: "thread", attempt: 3 },
        replaceKey: "recruiting_grade.start:thread",
      }),
    );
  });

  it("waits for the previous batch's grades before sending the next", async () => {
    const request = { id: "request", createdAt: new Date(now - 60_000), task: { prompt: "" } };
    const waiting = fixture({ found: [person("a")], requests: [request], researched: ["request"] });
    await startRecruitingGrading(waiting.deps, { threadId: "thread" }, now);
    expect(waiting.runCreate).not.toHaveBeenCalled();
    const saved = fixture({
      found: [person("a")],
      requests: [request],
      researched: ["request"],
      gradesSaved: true,
    });
    await startRecruitingGrading(saved.deps, { threadId: "thread" }, now);
    expect(saved.runCreate).toHaveBeenCalledOnce();
  });

  it("holds the next batch for a while after a request that never started research", async () => {
    const request = { id: "request", createdAt: new Date(now - 60_000), task: { prompt: "" } };
    const recent = fixture({ found: [person("a")], requests: [request] });
    await startRecruitingGrading(recent.deps, { threadId: "thread" }, now);
    expect(recent.runCreate).not.toHaveBeenCalled();
    const old = { ...request, createdAt: new Date(now - 31 * 60_000) };
    const later = fixture({ found: [person("a")], requests: [old] });
    await startRecruitingGrading(later.deps, { threadId: "thread" }, now);
    expect(later.runCreate).toHaveBeenCalledOnce();
  });

  it("does nothing when everyone is graded or no teammate has the research service", async () => {
    const none = fixture({ found: [person("a")], graded: ["linkedin:/in/a"] });
    await startRecruitingGrading(none.deps, { threadId: "thread" }, now);
    expect(none.runCreate).not.toHaveBeenCalled();
    const noTeammate = fixture({ found: [person("a")], researchBots: [] });
    await startRecruitingGrading(noTeammate.deps, { threadId: "thread" }, now);
    expect(noTeammate.runCreate).not.toHaveBeenCalled();
  });

  it("skips a teammate whose research service only allows reading earlier research", async () => {
    const f = fixture({ found: [person("a")], readOnlyBots: ["main"] });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ botId: "sourcer" }),
    });
    const readOnly = fixture({ found: [person("a")], readOnlyBots: ["main"], researchBots: [] });
    await startRecruitingGrading(readOnly.deps, { threadId: "thread" }, now);
    expect(readOnly.runCreate).not.toHaveBeenCalled();
  });
});

describe("gradingToolRefusal", () => {
  const start = `${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`;
  const save = "recruiting-research-wake:task:1";
  const never = [
    ["recruiting_role", { operation: "update" }],
    ["recruiting_research", { operation: "calibration_round" }],
    ["recruiting_feedback", { target: "round", operation: "approve" }],
    ["recruiting_shortlist", {}],
    ["ask_user", {}],
    ["message_user", {}],
    ["handoff_to_bot", {}],
    ["scratchpad_add", {}],
    ["mcp__research__reply", { task_id: "t" }],
    ["mcp__research__research", { task_id: "t" }],
    ["mcp__mail__send_email", {}],
    ["connectors_execute_tool", { id: "server-1:reply", arguments: { task_id: "t" } }],
    ["connectors_execute_tool", { id: "server-1:research", arguments: { task_id: "t" } }],
    ["connectors_execute_tool", { id: "server-2:send_email", arguments: {} }],
    ["connectors_execute_tool", { id: "mcp__mail__send_email", arguments: {} }],
  ] as const;
  const either = [
    ["recruiting_candidates", { operation: "list" }],
    ["skill_read", {}],
    ["connectors_search_tools", { query: "research" }],
    ["connectors_load_tool", { id: "server-1:research" }],
    // One status read after starting is harmless.
    ["mcp__research__get_task", { task_id: "t" }],
  ] as const;
  const reads = [
    ["mcp__research__get_rows", { task_id: "t" }],
    ["recruiting_research", { operation: "save_results" }],
    ["connectors_execute_tool", { id: "mcp__research__get_rows", arguments: { task_id: "t" } }],
  ] as const;
  const starts = [
    ["mcp__research__research", { query: "grade" }],
    ["connectors_execute_tool", { id: "server-1:research", arguments: { prompt: "grade" } }],
  ] as const;

  it("lets the request turn only start the research, then end", () => {
    for (const [name, args] of [...either, ...starts])
      expect(gradingToolRefusal(name, args, start)).toBeUndefined();
    for (const [name, args] of [...never, ...reads])
      expect(gradingToolRefusal(name, args, start)).toMatch(/end the turn/);
  });

  it("lets the turn the research's finish wakes only read and save its rows", () => {
    for (const [name, args] of [...either, ...reads])
      expect(gradingToolRefusal(name, args, save)).toBeUndefined();
    for (const [name, args] of [...never, ...starts])
      expect(gradingToolRefusal(name, args, save)).toMatch(/only reads/);
  });

  it("tells a grading turn to end once it has used its tool calls", () => {
    expect(
      gradingToolRefusal(
        "mcp__research__get_rows",
        { task_id: "t" },
        save,
        GRADE_TOOL_CALL_LIMIT - 1,
      ),
    ).toBeUndefined();
    expect(
      gradingToolRefusal("mcp__research__get_rows", { task_id: "t" }, save, GRADE_TOOL_CALL_LIMIT),
    ).toMatch(/End the turn now/);
  });
});

describe("gradingTools", () => {
  const all = [
    "recruiting_candidates",
    "recruiting_research",
    "recruiting_role",
    "request_connection",
    "schedule_update",
    "connectors_search_tools",
    "connectors_execute_tool",
    "mcp__research__research",
    "mcp__research__get_task",
    "mcp__research__get_rows",
    "mcp__research__reply",
    "mcp__people-search__web_search_advanced_exa",
  ].map((name) => ({ name }));
  const names = (nonce: string) => gradingTools(all, nonce).map((tool) => tool.name);

  it("gives the request turn only what starting the grading needs", () => {
    expect(names(`${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`)).toEqual([
      "recruiting_candidates",
      "mcp__research__research",
      "mcp__research__get_task",
    ]);
  });

  it("gives the save turn only the reads and the save", () => {
    expect(names("recruiting-research-wake:task:1")).toEqual([
      "recruiting_candidates",
      "recruiting_research",
      "mcp__research__get_task",
      "mcp__research__get_rows",
    ]);
  });

  it("keeps the connector catalog when the research service is not loaded directly", () => {
    const catalog = all.filter((tool) => !tool.name.startsWith("mcp__research__"));
    expect(
      gradingTools(catalog, `${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`).map((t) => t.name),
    ).toEqual(["recruiting_candidates", "connectors_search_tools", "connectors_execute_tool"]);
  });
});
