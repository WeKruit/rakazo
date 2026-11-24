import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";

const listRecruitingCandidates = vi.fn();
const createThreadMessageInTransaction = vi.fn(async () => ({ id: "steer-message" }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  listRecruitingCandidates: (...args: unknown[]) => listRecruitingCandidates(...args),
  createThreadMessageInTransaction: (...args: unknown[]) =>
    createThreadMessageInTransaction(...(args as [])),
}));

const {
  GRADE_BATCH,
  GRADE_IN_FLIGHT,
  GRADE_TOOL_CALL_LIMIT,
  gradingToolRefusal,
  gradingTools,
  RECRUITING_GRADE_NONCE_PREFIX,
  RECRUITING_GRADE_REPORT_NONCE_PREFIX,
  scheduleRecruitingGrading,
  startRecruitingGrading,
} = await import("./recruiting-grading.js");

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

type Occurrence = {
  candidateKey: string;
  name: string;
  linkedinUrl: string | null;
  page?: { observedAt: Date };
  report?: unknown;
};
const person = (slug: string): Occurrence => ({
  candidateKey: `linkedin:/in/${slug}`,
  name: slug,
  linkedinUrl: `https://x.test/in/${slug}`,
  page: { observedAt: new Date(0) },
});

/** A round as stored: one after feedback waits for its check unless the test says otherwise. */
const stored = (round: { round: number; createdAt: Date; status?: string }) => ({
  status: round.round >= 2 ? "checking" : "shown",
  statusAt: round.createdAt,
  version: 0,
  ownerBotId: "lead",
  approvedAt: null,
  ...round,
});

function fixture(options: {
  busy?: boolean;
  found?: Occurrence[];
  graded?: string[];
  requests?: Array<{ id: string; createdAt: Date; task: { prompt: string } }>;
  /** Request run ids that started research. */
  researched?: string[];
  gradesSaved?: boolean;
  wakes?: string[];
  researchBots?: string[];
  /** Bots whose research assignment allows only reads of earlier research. */
  readOnlyBots?: string[];
  /** Bots whose people-search assignment allows agent runs. */
  agentRunBots?: string[];
  /** The role's calibration rounds, latest first. */
  rounds?: Array<{
    id: string;
    round: number;
    candidateKeys: string[];
    createdAt: Date;
    status?: string;
  }>;
  /** Whether the latest round was recorded as a correction. */
  corrects?: boolean;
  /** The tier of each graded person, by candidateKey. */
  tiers?: Record<string, string>;
  /** Grades of the latest round's people saved since the previous round. */
  roundGrades?: Array<{
    candidateKey: string;
    name: string;
    matchFields: unknown;
    pageId?: string;
  }>;
  /** The recruiter's messages in the role's conversation, oldest first. */
  said?: Array<{ blocks: unknown[]; createdAt?: Date }>;
}) {
  const runCreate = vi.fn(async () => ({ id: "grade-run" }));
  const taskCreate = vi.fn(async () => ({ id: "grade-task" }));
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: runCreate },
    task: { create: taskCreate },
    message: { findFirst: vi.fn(async () => null) },
    steeringMessage: { create: vi.fn(async () => ({ id: "steering" })) },
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
      findMany: vi.fn(async ({ where }: { where: { clientNonce?: { startsWith?: string } } }) =>
        where.clientNonce?.startsWith === "recruiting-research-wake:"
          ? (options.wakes ?? []).map((clientNonce) => ({ clientNonce }))
          : (options.requests ?? []),
      ),
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
      findMany: vi.fn(async ({ where }: { where: { page?: unknown; candidateKey?: unknown } }) =>
        where.candidateKey
          ? (options.roundGrades ?? []).map((row) => ({ title: null, company: null, ...row }))
          : where.page
            ? (options.graded ?? []).map((candidateKey) => ({
                candidateKey,
                matchFields: options.tiers?.[candidateKey]
                  ? { match_tier: options.tiers[candidateKey] }
                  : null,
              }))
            : (options.found ?? []),
      ),
    },
    recruitingCalibrationRound: {
      findMany: vi.fn(async () => (options.rounds ?? []).map(stored)),
      findFirst: vi.fn(async () => (options.rounds?.[0] ? stored(options.rounds[0]) : null)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    recruitingRole: {
      findUnique: vi.fn(async () => ({
        currentRevision: {
          criteria: null,
          brief: {
            fields: [
              { key: "Title", value: "Data Engineer", state: "known", origin: "user_instruction" },
            ],
          },
        },
      })),
    },
    message: {
      findFirst: vi.fn(async () => ({ id: "said-last" })),
      findMany: vi.fn(async ({ where }: { where?: { role?: string } } = {}) =>
        where?.role === "user" ? (options.said ?? []) : [],
      ),
    },
    chatGroupMember: {
      findMany: vi.fn(async () => [{ botId: "main" }, { botId: "sourcer" }]),
    },
    botMcpServer: {
      findMany: vi.fn(async () =>
        [...(options.readOnlyBots ?? []), ...(options.researchBots ?? ["sourcer"])]
          .map((botId) => ({
            botId,
            serverId: "server-1",
            allowAllTools: false,
            allowedTools: options.readOnlyBots?.includes(botId)
              ? ["get_task", "get_rows"]
              : ["research", "get_task", "get_rows"],
            server: { slug: "research", endpoint: "https://api.autumn.ai/mcp" },
          }))
          .concat(
            (options.agentRunBots ?? []).map((botId) => ({
              botId,
              serverId: "server-2",
              allowAllTools: false,
              allowedTools: ["agent_run"],
              server: {
                slug: "people-search",
                endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa",
              },
            })),
          ),
      ),
    },
    externalEffect: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => ({ request: { corrects: options.corrects } })),
    },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: prisma as unknown as PrismaClient, jobs: { enqueue } },
    prisma,
    tx,
    runCreate,
    taskCreate,
    enqueue,
  };
}

const promptOf = (f: ReturnType<typeof fixture>) =>
  (f.taskCreate.mock.calls[0] as unknown as [{ data: { prompt: string } }])[0].data.prompt;

describe("startRecruitingGrading", () => {
  const round = (keys: string[]) => [
    { id: "round-2", round: 2, candidateKeys: keys, createdAt: new Date(now - 5 * 60_000) },
    { id: "round-1", round: 1, candidateKeys: [], createdAt: new Date(now - 60 * 60_000) },
  ];

  it("grades the round under review first, against what the recruiter said", async () => {
    const f = fixture({
      found: [person("newer"), person("picked")],
      // Graded before the recruiter's feedback on round 1.
      graded: ["linkedin:/in/picked"],
      rounds: round(["linkedin:/in/picked"]),
      researchBots: [],
      agentRunBots: ["sourcer"],
    });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    const prompt = promptOf(f);
    expect(prompt.indexOf("in/picked")).toBeLessThan(prompt.indexOf("in/newer"));
    expect(prompt).toContain("* Title: Data Engineer");
  });

  // fr 11-22 (6aa4c10d): round 2 waited minutes on a pool batch sent before it that never finished.
  // fosp 11-23 (df2c09cb): the search said "Apache Flink Contributor"; the public page showed only
  // courses, so the check graded Flink unknown and the list said there was no such experience.
  it("gives the check what the search said of each person", async () => {
    const f = fixture({
      found: [
        {
          ...person("flink"),
          report: {
            fields: [{ label: "Snippet", value: "Apache Flink Contributor,\n streaming" }],
          },
        },
      ],
      rounds: round(["linkedin:/in/flink"]),
      researchBots: [],
      agentRunBots: ["sourcer"],
    });
    // 11-23: the Reviewer judged Mandarin again and left it unknown for people the language check
    // had already decided; the check's finding comes with the person instead.
    f.prisma.externalEffect.findMany.mockResolvedValue([
      {
        result: {
          languageLevels: {
            requirement: "Mandarin",
            levels: { "linkedin:/in/flink": "confirmed" },
          },
        },
      },
    ] as never);
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(promptOf(f)).toContain(
      "- flink: https://x.test/in/flink\n  Saved profile: Snippet: Apache Flink Contributor, streaming\n  The language check found: Mandarin: confirmed",
    );
  });

  it("grades against the recruiter's own feedback words, also when a teammate handed them in", async () => {
    // Staging 11-16: "senior only, 6+ years" was never saved as feedback, so the next round's
    // check graded without it and juniors came back.
    const f = fixture({
      found: [person("picked")],
      rounds: round(["linkedin:/in/picked"]),
      researchBots: [],
      agentRunBots: ["sourcer"],
      said: [
        { blocks: [{ kind: "text", text: "senior only, 6+ years" }] },
        {
          blocks: [
            {
              kind: "bot_message_received",
              text: 'The recruiter wrote, word for word:\n"no agency people"',
            },
          ],
        },
        { blocks: [{ kind: "bot_message_received", text: "Reviewer: 3 of 10 checked" }] },
      ],
    });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    const prompt = promptOf(f);
    expect(prompt).toContain('* "senior only, 6+ years"');
    expect(prompt).toContain('* "no agency people"');
    expect(prompt).not.toContain("3 of 10 checked");
  });

  // fosp 11-22 (352978a2): the round was left for a later turn to show and that turn never came.
  // fr 11-22 (6aa4c10d): round 2 waited minutes on a pool batch sent before it that never finished.

  // s45/s46 11-24: one batch at a time, a held round's 20 people took about two minutes to check.

  // fosp 11-22 (352978a2): the round was left for a later turn to show and that turn never came.

  it("has the lead post the ranked grades once grading of a scaled-out role is done", async () => {
    const f = fixture({
      found: [person("graded")],
      graded: ["linkedin:/in/graded"],
      requests: [
        {
          id: "last-batch",
          createdAt: new Date(now - 10 * 60_000),
          task: { prompt: "Grade these\n\n- graded: https://x.test/in/graded" },
        },
      ],
      researched: ["last-batch"],
      wakes: ["recruiting-research-wake:research-last-batch:done"],
    });
    const prisma = f.prisma as unknown as {
      recruitingCandidate: { count: ReturnType<typeof vi.fn> };
      chatGroupMember: { findMany: ReturnType<typeof vi.fn> };
    };
    prisma.recruitingCandidate = { count: vi.fn(async () => 150) };
    prisma.chatGroupMember.findMany.mockResolvedValue([
      { botId: "sourcer", bot: { name: "Sourcer", spawnKey: null } },
      { botId: "lead", bot: { name: "Main", spawnKey: null } },
    ]);
    const graded = (key: string, score: number | null, tier: string) => ({
      candidateKey: `linkedin:/in/${key}`,
      name: `Person ${key}`,
      title: "Chair",
      company: "USC APASA",
      match: { rank: null, score, tier },
    });
    listRecruitingCandidates
      .mockResolvedValueOnce({
        items: [graded("a", 98, "Strong"), graded("b", 40, "Partial")],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ items: [graded("c", null, "Uncertain")], nextCursor: null });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    // The server counts every page; the lead relays the counts and the order as given.
    expect(promptOf(f)).toContain("Strong 1, Promising 0, Partial 1, Uncertain 1");
    expect(promptOf(f)).toContain(
      "1. Person a, Chair at USC APASA: score 98, Strong (candidateKey linkedin:/in/a)",
    );
    expect(promptOf(f)).not.toContain("Person c,");
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "lead",
        trigger: "recruiting_research",
        clientNonce: `${RECRUITING_GRADE_REPORT_NONCE_PREFIX}thread:last-batch`,
      }),
    });
    // Grades still on their way would be missing, so the report waits for them.
    const early = fixture({
      found: [person("graded")],
      graded: ["linkedin:/in/graded"],
      requests: [
        {
          id: "last-batch",
          createdAt: new Date(now - 10 * 60_000),
          task: { prompt: "Grade these\n\n- graded: https://x.test/in/graded" },
        },
      ],
      researched: ["last-batch"],
    });
    (early.prisma as unknown as typeof prisma).recruitingCandidate = {
      count: vi.fn(async () => 150),
    };
    await startRecruitingGrading(early.deps, { threadId: "thread" }, now);
    expect(early.runCreate).not.toHaveBeenCalled();
    // A calibration-sized role gets no report.
    const small = fixture({ found: [], requests: [], researched: [] });
    (small.prisma as unknown as typeof prisma).recruitingCandidate = {
      count: vi.fn(async () => 150),
    };
    await startRecruitingGrading(small.deps, { threadId: "thread" }, now);
    expect(small.runCreate).not.toHaveBeenCalled();
  });

  it("sends a person again once when their request ended without their grade", async () => {
    const f = fixture({
      found: [person("expired"), person("waiting")],
      requests: [
        {
          id: "recent-request",
          createdAt: new Date(now - 40 * 60_000),
          task: { prompt: "Grade these\n\n- waiting: https://x.test/in/waiting" },
        },
        {
          id: "expired-request",
          createdAt: new Date(now - 3 * 60 * 60_000),
          task: { prompt: "Grade these\n\n- expired: https://x.test/in/expired" },
        },
      ],
      researched: ["recent-request", "expired-request"],
    });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    const prompt = promptOf(f);
    expect(prompt).toContain("- expired: https://x.test/in/expired");
    expect(prompt).not.toContain("in/waiting");
  });

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
          id: "older-request",
          createdAt: new Date(now - 5 * 60 * 60_000),
          task: { prompt: "Grade these\n\n- sent: https://x.test/in/sent" },
        },
        {
          id: "never-started",
          createdAt: new Date(now - 4 * 60 * 60_000),
          task: { prompt: "Grade these\n\n- new-b: https://x.test/in/new-b" },
        },
      ],
      // "sent" went out twice with no grade back, so it is not sent a third time.
      researched: ["old-request", "older-request"],
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

  it("grades with a people-search agent run when a teammate may start one", async () => {
    const f = fixture({ found: [person("a")], agentRunBots: ["main"] });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ botId: "main" }),
    });
    expect(promptOf(f)).toContain('connectors_execute_tool with id "server-2:agent_run"');
    expect(promptOf(f)).toContain("save_results with providerTaskId set to the run's id");
    // A job opening is graded on fit for the job, not on one listed condition.
    expect(promptOf(f)).toContain(
      "current role, experience and seniority against the job description",
    );
    // Even a short last batch checks again, which finds nobody left and reports.
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "recruiting_grade.start", keepExisting: false }),
    );
  });

  it("sends at most one batch, newest first", async () => {
    const found = Array.from({ length: GRADE_BATCH + 5 }, (_, index) => person(`p${index}`));
    const f = fixture({ found });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(promptOf(f)).toContain(`grade these ${GRADE_BATCH} people`);
    expect(promptOf(f)).not.toContain(`in/p${GRADE_BATCH}\n`);
    // A full batch schedules the next one in place of the start that is running now.
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "recruiting_grade.start", keepExisting: false }),
    );
  });

  // Reliability plan S3 (11-16): the check is the Reviewer's own work. It waits only on the
  // Reviewer's turns, not on teammates working in the same role conversation.
  it("waits only on the grader's own turns, not on teammates' turns", async () => {
    const f = fixture({ found: [person("a")] });
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread", botId: "sourcer" }),
      }),
    );
    // Staging 11-16 (d06ea499): the lead recorded round 2 mid-turn, the start saw the lead's turn
    // when it created the check, gave up without a retry, and the round sat unchecked 4 minutes.
    const leadWorking = fixture({ found: [person("a")] });
    leadWorking.tx.run.findFirst.mockImplementation((async ({ where }: { where: object }) =>
      "status" in where && !("botId" in where) ? { id: "lead-turn" } : null) as never);
    await startRecruitingGrading(leadWorking.deps, { threadId: "thread" }, now);
    expect(leadWorking.runCreate).toHaveBeenCalledOnce();
  });

  it("keeps a few batches in flight and waits when all of them are", async () => {
    const requests = Array.from({ length: GRADE_IN_FLIGHT }, (_, index) => ({
      id: `request-${index}`,
      createdAt: new Date(now - 60_000 * (index + 1)),
      task: { prompt: "" },
    }));
    const full = fixture({
      found: [person("a")],
      requests,
      researched: requests.map((request) => request.id),
    });
    await startRecruitingGrading(full.deps, { threadId: "thread" }, now);
    expect(full.runCreate).not.toHaveBeenCalled();
    const room = fixture({
      found: [person("a")],
      requests: requests.slice(1),
      researched: requests.slice(1).map((request) => request.id),
    });
    await startRecruitingGrading(room.deps, { threadId: "thread" }, now);
    expect(room.runCreate).toHaveBeenCalledOnce();
    // An agent run grades within its own turn; research requests still out never hold it.
    const agentRun = fixture({
      found: [person("a")],
      requests,
      researched: requests.map((request) => request.id),
      agentRunBots: ["sourcer"],
    });
    await startRecruitingGrading(agentRun.deps, { threadId: "thread" }, now);
    expect(agentRun.runCreate).toHaveBeenCalledOnce();
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

describe("scheduleRecruitingGrading", () => {
  it("starts a held round's check now, replacing a later start already waiting", async () => {
    // Staging 11-16 (94b302cd run 4): a start pushed 30 s out by "next round coming" was kept,
    // so the check of the held round waited 26 s for it.
    const enqueue = vi.fn(async () => undefined);
    await scheduleRecruitingGrading({ enqueue }, "thread", now, 0);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ keepExisting: false, availableAt: new Date(now) }),
    );
    await scheduleRecruitingGrading({ enqueue }, "thread", now);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ keepExisting: true }));
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
    // An agent run's grades are saved in the turn that ran it.
    ["recruiting_research", { operation: "save_results" }],
  ] as const;
  const reads = [
    ["mcp__research__get_rows", { task_id: "t" }],
    ["connectors_execute_tool", { id: "mcp__research__get_rows", arguments: { task_id: "t" } }],
  ] as const;
  const starts = [
    ["mcp__research__research", { query: "grade" }],
    ["connectors_execute_tool", { id: "server-1:research", arguments: { prompt: "grade" } }],
  ] as const;

  it("lets the request turn grade with an agent run and save it", () => {
    expect(
      gradingToolRefusal("mcp__people-search__agent_run", { query: "Grade" }, start),
    ).toBeUndefined();
    expect(
      gradingToolRefusal("recruiting_research", { operation: "save_results" }, start),
    ).toBeUndefined();
  });

  it("lets the quality check save its own grades and open no page", () => {
    expect(
      gradingToolRefusal("web_fetch", { url: "https://www.linkedin.com/in/a" }, start),
    ).toMatch(/saved profile/i);
    expect(
      gradingToolRefusal("recruiting_research", { operation: "save_grades" }, start),
    ).toBeUndefined();
    expect(gradingToolRefusal("web_search", { query: "a" }, start)).toMatch(/end the turn/i);
  });

  it("lets the request turn only start the research, then end", () => {
    for (const [name, args] of [...either, ...starts])
      expect(gradingToolRefusal(name, args, start)).toBeUndefined();
    for (const [name, args] of [...never, ...reads])
      expect(gradingToolRefusal(name, args, start)).toMatch(/end the turn/i);
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
      "recruiting_research",
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
    ).toEqual([
      "recruiting_candidates",
      "recruiting_research",
      "connectors_search_tools",
      "connectors_execute_tool",
    ]);
  });
});
