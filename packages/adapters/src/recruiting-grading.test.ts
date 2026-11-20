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
  checkedRoundPeople,
  gradingTools,
  heldRoundSearchRefusal,
  nextRoundHeld,
  roundAwaitingReview,
  roundListHeld,
  RECRUITING_GRADE_NONCE_PREFIX,
  RECRUITING_GRADE_REPORT_NONCE_PREFIX,
  RECRUITING_ROUND_REVIEW_NONCE_PREFIX,
  roundSize,
  ROUND_HELD_SEARCH_REFUSAL,
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

type Occurrence = { candidateKey: string; name: string; linkedinUrl: string | null };
const person = (slug: string): Occurrence => ({
  candidateKey: `linkedin:/in/${slug}`,
  name: slug,
  linkedinUrl: `https://x.test/in/${slug}`,
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
  said?: Array<{ blocks: unknown[] }>;
}) {
  const runCreate = vi.fn(async () => ({ id: "grade-run" }));
  const taskCreate = vi.fn(async () => ({ id: "grade-task" }));
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: { findFirst: vi.fn(async () => null), create: runCreate },
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
    expect(prompt).toContain('* In their words: "senior only, 6+ years"');
    expect(prompt).toContain('* In their words: "no agency people"');
    expect(prompt).not.toContain("3 of 10 checked");
  });

  it("has the lead replace a held round's people the Reviewer found not to fit", async () => {
    const team = [
      { botId: "lead", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ];
    const options = {
      found: [person("fits"), person("misfit"), person("unshown"), person("spare")],
      graded: [
        "linkedin:/in/fits",
        "linkedin:/in/misfit",
        "linkedin:/in/unshown",
        "linkedin:/in/spare",
      ],
      tiers: { "linkedin:/in/spare": "Strong" },
      rounds: round(["linkedin:/in/fits", "linkedin:/in/misfit", "linkedin:/in/unshown"]),
      roundGrades: [
        { candidateKey: "linkedin:/in/fits", name: "Fits", matchFields: { match_tier: "Strong" } },
        {
          candidateKey: "linkedin:/in/misfit",
          name: "Misfit",
          matchFields: { match_tier: "Partial" },
          pageId: "grades",
        },
        // Staging 11-16: people whose profile doesn't show Kafka stayed in the checked round, and
        // the recruiter asked why they were there.
        {
          candidateKey: "linkedin:/in/unshown",
          name: "Unshown",
          matchFields: { match_tier: "Promising" },
        },
      ],
    };
    const f = fixture(options);
    f.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    // Staging 11-16: the swap re-read all ten people's profiles five times (about 7 minutes), so
    // the request carries each misfit's gaps and the saved people it can take.
    f.prisma.externalEffect.findMany.mockResolvedValue([
      {
        id: "grades",
        request: {
          rows: [
            {
              linkedin_url: "https://www.linkedin.com/in/misfit/",
              concerns: ["Architect role"],
              requirements_assessment: [
                { requirement: "Spark in production", status: "met" },
                { requirement: "Kafka in production", status: "unknown" },
              ],
            },
          ],
        },
      },
    ] as never);
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "lead",
        clientNonce: `${RECRUITING_ROUND_REVIEW_NONCE_PREFIX}thread:said-last`,
      }),
    });
    // The system picks the round: who fits, then Strong people from Results in the misfits'
    // places, then the closest misfit; the Partial one and anyone unchecked stay out.
    expect(promptOf(f)).toContain(
      "1. Fits (candidateKey linkedin:/in/fits)\n2. spare (candidateKey linkedin:/in/spare)\n3. Unshown (candidateKey linkedin:/in/unshown)\n\n",
    );
    expect(promptOf(f)).not.toContain("linkedin:/in/misfit");
    // fosp 11-20: a short round has saved people no round showed checked first, once, then shows.
    const short = fixture({ ...options, found: [...options.found, person("new")] });
    short.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    short.prisma.externalEffect.findMany.mockResolvedValue([] as never);
    await startRecruitingGrading(short.deps, { threadId: "thread" }, now);
    expect(short.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ botId: "reviewer" }),
    });
    expect(promptOf(short)).toContain("x.test/in/new");
    expect(promptOf(short)).not.toContain("x.test/in/fits");
    // Nothing is shown while a round person still waits for a grade made with the feedback.
    const waiting = fixture({ ...options, roundGrades: options.roundGrades.slice(1) });
    waiting.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    await startRecruitingGrading(waiting.deps, { threadId: "thread" }, now);
    // A round already shown is never swapped afterwards: the recruiter sees each round once.
    const shown = fixture(options);
    await startRecruitingGrading(shown.deps, { threadId: "thread" }, now);
    for (const g of [waiting, shown])
      expect(
        (g.runCreate.mock.calls as unknown as [{ data: { clientNonce: string } }][]).map(
          ([call]) => call.data.clientNonce,
        ),
      ).not.toContainEqual(expect.stringContaining(RECRUITING_ROUND_REVIEW_NONCE_PREFIX));
  });

  it("holds other people's grading while the lead picks the next round after feedback", async () => {
    // Staging 11-16 (9e15e896): a batch of pool people started while the lead was still picking
    // round 2, and round 2's check waited 2.5 minutes behind it.
    const team = [
      { botId: "lead", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ];
    const shown = [
      {
        id: "round-1",
        round: 1,
        candidateKeys: ["linkedin:/in/shown"],
        createdAt: new Date(now - 5 * 60_000),
      },
    ];
    const picking = fixture({ found: [person("pool")], rounds: shown });
    picking.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    picking.prisma.run.findFirst.mockImplementation((async ({ where }: { where: object }) =>
      "botId" in where && typeof (where as { botId: unknown }).botId === "object"
        ? { id: "lead-turn" }
        : null) as never);
    await startRecruitingGrading(picking.deps, { threadId: "thread" }, now);
    expect(picking.runCreate).not.toHaveBeenCalled();
    expect(picking.enqueue).toHaveBeenCalledOnce();
    // The shown round's own people wait too (staging 11-16, feedback-round play 3: grading the
    // unchecked round 1 after feedback held round 2's check back 80 seconds).
    const ownPeople = fixture({ found: [person("shown"), person("pool")], rounds: shown });
    ownPeople.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    ownPeople.prisma.run.findFirst.mockImplementation(picking.prisma.run.findFirst);
    await startRecruitingGrading(ownPeople.deps, { threadId: "thread" }, now);
    expect(ownPeople.runCreate).not.toHaveBeenCalled();
    // With the lead idle the pool is graded as before.
    const idle = fixture({ found: [person("pool")], rounds: shown });
    idle.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    await startRecruitingGrading(idle.deps, { threadId: "thread" }, now);
    expect(idle.runCreate).toHaveBeenCalledOnce();
  });

  it("grades only the held round's people while the recruiter waits for it", async () => {
    // Staging 11-15: one round person left to grade was padded with nine from the pool, and the
    // recruiter waited a whole extra batch for the checked round.
    const team = [
      { botId: "lead", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ];
    const f = fixture({
      found: [person("pool"), person("left"), person("fits")],
      graded: ["linkedin:/in/fits"],
      rounds: round(["linkedin:/in/fits", "linkedin:/in/left"]),
      roundGrades: [
        { candidateKey: "linkedin:/in/fits", name: "Fits", matchFields: { match_tier: "Strong" } },
      ],
    });
    f.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(promptOf(f)).toContain("in/left");
    expect(promptOf(f)).not.toContain("in/pool");
  });

  it("has the lead show a round held for the Reviewer once everyone in it is checked", async () => {
    const team = [
      { botId: "lead", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ];
    const f = fixture({
      found: [person("fits")],
      graded: ["linkedin:/in/fits"],
      rounds: round(["linkedin:/in/fits"]),
      roundGrades: [
        { candidateKey: "linkedin:/in/fits", name: "Fits", matchFields: { match_tier: "Strong" } },
      ],
    });
    f.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "lead",
        clientNonce: `${RECRUITING_ROUND_REVIEW_NONCE_PREFIX}thread:said-last`,
      }),
    });
    expect(promptOf(f)).toContain("1. Fits (candidateKey linkedin:/in/fits)\n\n");
    // Staging 11-16 (7838c505): the check ended while the lead was answering "where's round 2?",
    // the start found the conversation busy, and the checked round waited 3.5 min for a free
    // moment. As a teammate's report joins the lead's running turn (S4), so does the round.
    const answering = fixture({
      found: [person("fits")],
      graded: ["linkedin:/in/fits"],
      rounds: round(["linkedin:/in/fits"]),
      roundGrades: [
        { candidateKey: "linkedin:/in/fits", name: "Fits", matchFields: { match_tier: "Strong" } },
      ],
    });
    answering.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
    answering.tx.run.findFirst.mockImplementation((async ({ where }: { where: object }) =>
      "botId" in where && (where as { botId: string }).botId === "lead"
        ? { id: "lead-turn" }
        : null) as never);
    await startRecruitingGrading(answering.deps, { threadId: "thread" }, now);
    expect(answering.runCreate).not.toHaveBeenCalled();
    expect(answering.tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ runId: "lead-turn", botId: "lead" }),
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      answering.tx,
      expect.objectContaining({
        clientNonce: `${RECRUITING_ROUND_REVIEW_NONCE_PREFIX}thread:said-last`,
        blocks: [expect.objectContaining({ kind: "handoff", toBotId: "lead" })],
      }),
    );
    // The check's end is stored before the lead is asked to show the round.
    expect(f.prisma.recruitingCalibrationRound.updateMany).toHaveBeenCalledWith({
      where: { id: "round-2", version: 0, status: "checking" },
      data: expect.objectContaining({ status: "checked" }),
    });
    // The round after a shown one waits for the check; nothing streams into chat before it.
    const next = (status: string) => {
      const g = fixture({ rounds: [{ ...round([])[0]!, createdAt: new Date(), status }] });
      g.prisma.chatGroupMember.findMany.mockResolvedValue(team as never);
      return nextRoundHeld(g.deps.prisma, { threadId: "thread", roleId: "role" });
    };
    await expect(next("shown")).resolves.toBe(true);
    await expect(next("checked")).resolves.toBe(false);
    // Staging 11-16: attempts made while a round was unshown streamed their lists, then were
    // refused, so the recruiter saw the same people again. Nothing of them is listed.
    const listed = (status: string) => {
      const g = fixture({ rounds: [{ ...round([])[0]!, createdAt: new Date(), status }] });
      return roundListHeld(g.deps.prisma, { threadId: "thread", roleId: "role" });
    };
    await expect(listed("checking")).resolves.toBe(true);
    await expect(listed("checked")).resolves.toBe(true);
    // Kruit's chat lists none of Results while the round waits (staging 11-15), unless it waited long.
    const waiting = (at: number) =>
      roundAwaitingReview(f.deps.prisma, { threadId: "thread", roleId: "role" }, at);
    await expect(waiting(now)).resolves.toBe(2);
    await expect(waiting(now + 60 * 60_000)).resolves.toBeNull();
    // Without the Reviewer nothing holds the round, so nothing is started for it.
    const solo = fixture({
      found: [person("fits")],
      graded: ["linkedin:/in/fits"],
      rounds: round(["linkedin:/in/fits"]).map((row) => ({ ...row, status: "shown" })),
      roundGrades: [
        { candidateKey: "linkedin:/in/fits", name: "Fits", matchFields: { match_tier: "Strong" } },
      ],
    });
    await startRecruitingGrading(solo.deps, { threadId: "thread" }, now);
    expect(solo.runCreate).not.toHaveBeenCalled();
    await expect(
      nextRoundHeld(solo.deps.prisma, { threadId: "thread", roleId: "role" }),
    ).resolves.toBe(false);
    await expect(
      roundAwaitingReview(solo.deps.prisma, { threadId: "thread", roleId: "role" }, now),
    ).resolves.toBeNull();
  });

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

  it("has the quality check grade itself from full profiles, ten at a time", async () => {
    const f = fixture({
      found: Array.from({ length: 14 }, (_, index) => person(`p${index}`)),
      agentRunBots: ["main"],
    });
    f.prisma.chatGroupMember.findMany.mockResolvedValue([
      { botId: "main", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ] as never);
    await startRecruitingGrading(f.deps, { threadId: "thread" }, now);
    expect(f.runCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ botId: "reviewer" }),
    });
    const prompt = promptOf(f);
    expect(prompt).toContain("Grade these 10 people");
    expect(prompt).toContain("one web_fetch per person");
    expect(prompt).toContain("recruiting_research save_grades");
    expect(prompt).toContain("never judge ethnicity, race or background");
    expect(prompt).not.toContain("agent_run");
    expect(prompt).not.toContain("in/p10");
    // Grades the quality check saved itself count as graded.
    expect(f.prisma.recruitingCandidateOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          page: {
            effect: {
              OR: [
                { request: { path: ["operation"], equals: "save_results" } },
                { request: { path: ["operation"], equals: "save_grades" } },
              ],
            },
          },
        }),
      }),
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

  it("waits while a turn is working and checks again later", async () => {
    const f = fixture({ busy: true, found: [person("a")] });
    await startRecruitingGrading(f.deps, { threadId: "thread", attempt: 2 }, now);
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "recruiting_grade.start",
        payload: { threadId: "thread", attempt: 3 },
        replaceKey: "recruiting_grade.start:thread",
        // The running start holds this key until it ends; a kept job would end with it.
        keepExisting: false,
        availableAt: new Date(now + 30_000),
      }),
    );
    // Behind a grading batch the next one is tried within seconds.
    const behind = fixture({ busy: true, found: [person("a")] });
    behind.prisma.run.findFirst.mockResolvedValueOnce({
      id: "busy",
      trigger: "recruiting_grade",
    } as never);
    await startRecruitingGrading(behind.deps, { threadId: "thread" }, now);
    expect(behind.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ availableAt: new Date(now + 5_000) }),
    );
    // Staging 11-15: a held round's check gave up after six minutes behind other turns, and the
    // round was never shown. It keeps trying while the round is held.
    const heldBusy = fixture({
      busy: true,
      found: [person("a")],
      rounds: round(["linkedin:/in/a"]),
    });
    heldBusy.prisma.chatGroupMember.findMany.mockResolvedValue([
      { botId: "lead", bot: { name: "Main", spawnKey: null, archivedAt: null } },
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ] as never);
    await startRecruitingGrading(heldBusy.deps, { threadId: "thread", attempt: 500 }, now);
    expect(heldBusy.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ availableAt: new Date(now + 3_000) }),
    );
    const gaveUp = fixture({ busy: true, found: [person("a")] });
    await startRecruitingGrading(gaveUp.deps, { threadId: "thread", attempt: 500 }, now);
    expect(gaveUp.enqueue).not.toHaveBeenCalled();
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

  it("holds the next batch for a while after a request that never started research", async () => {
    const request = { id: "request", createdAt: new Date(now - 60_000), task: { prompt: "" } };
    const recent = fixture({ found: [person("a")], requests: [request] });
    await startRecruitingGrading(recent.deps, { threadId: "thread" }, now);
    expect(recent.runCreate).not.toHaveBeenCalled();
    const old = { ...request, createdAt: new Date(now - 31 * 60_000) };
    const later = fixture({ found: [person("a")], requests: [old] });
    await startRecruitingGrading(later.deps, { threadId: "thread" }, now);
    expect(later.runCreate).toHaveBeenCalledOnce();
    // Staging 11-15: nothing came back after the hold, so a search's people stayed unscored.
    expect(recent.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ availableAt: new Date(now - 60_000 + 30 * 60_000) }),
    );
    // The Reviewer grades within its own turn: its first unsaved turn is retried at once, a
    // second waits out the hold, and after four in a row grading stops trying on its own.
    const reviewer = [
      { botId: "reviewer", bot: { name: "Reviewer", spawnKey: null, archivedAt: null } },
    ];
    const tries = (count: number) => {
      const f = fixture({
        found: [person("a")],
        requests: Array.from({ length: count }, (_, index) => ({
          ...request,
          id: `request-${index}`,
        })),
      });
      f.prisma.chatGroupMember.findMany.mockResolvedValue(reviewer as never);
      return f;
    };
    const once = tries(1);
    await startRecruitingGrading(once.deps, { threadId: "thread" }, now);
    expect(once.runCreate).toHaveBeenCalledOnce();
    const twice = tries(2);
    await startRecruitingGrading(twice.deps, { threadId: "thread" }, now);
    expect(twice.runCreate).not.toHaveBeenCalled();
    expect(twice.enqueue).toHaveBeenCalledOnce();
    const stopped = tries(4);
    await startRecruitingGrading(stopped.deps, { threadId: "thread" }, now);
    expect(stopped.runCreate).not.toHaveBeenCalled();
    expect(stopped.enqueue).not.toHaveBeenCalled();
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

  it("lets the quality check read profiles and save its own grades", () => {
    expect(
      gradingToolRefusal("web_fetch", { url: "https://www.linkedin.com/in/a" }, start),
    ).toBeUndefined();
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

describe("checkedRoundPeople", () => {
  const grade = (name: string, tier: string) => ({ name, tier });
  it("keeps who fits in order, then Strong replacements, then the closest misfits, up to ten", () => {
    const keys = ["a", "b", "c", "d"];
    const grades = new Map([
      ["a", grade("A", "Uncertain")],
      ["b", grade("B", "Strong")],
      ["c", grade("C", "Partial")],
      ["d", grade("D", "Promising")],
    ]);
    expect(checkedRoundPeople(keys, grades, [{ key: "e", name: "E" }]).map((p) => p.name)).toEqual([
      "B",
      "E",
      "D",
      "A",
    ]);
    // Ten places at most: Strong replacements go before any misfit.
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `r${i}`, name: null }));
    const picked = checkedRoundPeople(keys, grades, many);
    expect(picked).toHaveLength(10);
    expect(picked.map((p) => p.key)).not.toContain("d");
    expect(picked[1]).toEqual({ key: "r0", name: "r0" });
  });

  it("fills a mostly turned-down round with checked Promising people from Results, never Partial", () => {
    // Branch 2026-11-20 (feedback-round x5): the Reviewer graded 1–5 of up to 84 saved people
    // Strong, so round 2 kept its 5 Promising, dropped its 5 Partial, found no Strong replacement
    // and came back with 5 while 16 checked Promising people sat in Results.
    const keys = ["p1", "p2", "p3", "p4", "p5", "x1", "x2", "x3", "x4", "x5"];
    const grades = new Map([
      ...keys.slice(0, 5).map((key) => [key, grade(key, "Promising")] as const),
      ...keys.slice(5).map((key) => [key, grade(key, "Partial")] as const),
    ]);
    const replacements = [
      { key: "s1", name: "S1", tier: "Strong" },
      ...Array.from({ length: 6 }, (_, i) => ({ key: `q${i}`, name: `Q${i}`, tier: "Promising" })),
    ];
    expect(checkedRoundPeople(keys, grades, replacements).map((p) => p.key)).toEqual([
      "s1",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "q0",
      "q1",
      "q2",
      "q3",
    ]);
  });
});

describe("roundSize", () => {
  it("shows the few people the recruiter asked for, else ten", () => {
    // fosp 11-20: "再来5个" was filled to 6.
    const handIn = (words: string) => [
      {
        kind: "bot_message_received",
        text: `The recruiter wrote, word for word:\n"${words}"\n\nKruit's note: find 10 more`,
      },
    ];
    expect(roundSize([handIn("再来5个")])).toBe(5);
    expect(roundSize([[{ kind: "text", text: "2 more people like the rest" }]])).toBe(2);
    expect(roundSize([handIn("#7 and #8 aren't a fit, find more like the rest")])).toBe(10);
    expect(roundSize([[{ kind: "text", text: "find 50" }]])).toBe(10);
    // fosp 11-20 (a2d787f8): the newest message only asked where they were; the ask before set 5.
    expect(
      roundSize([
        [{ kind: "text", text: "那5个出来了吗？Results页面里标了没" }],
        handIn("再来5个"),
      ]),
    ).toBe(5);
    expect(roundSize([])).toBe(10);
    expect(checkedRoundPeople(["a", "b", "c"], new Map(), [], 2)).toHaveLength(2);
  });
});

describe("heldRoundSearchRefusal", () => {
  const prismaWith = (round: Record<string, unknown> | null) =>
    ({
      recruitingCalibrationRound: { findFirst: vi.fn(async () => round) },
    }) as never;
  const held = (status: string, ownerBotId = "lead") => ({
    id: "r2",
    round: 2,
    candidateKeys: [],
    approvedAt: null,
    status,
    statusAt: new Date(),
    ownerBotId,
    version: 1,
  });

  it("refuses a search in a later turn while an earlier turn's round waits for the check", async () => {
    // Staging 11-16 (982a0ac9): "still waiting" started a new lead turn that searched again while
    // round 2 was being checked, and the checked round was steered into that busy turn.
    const refusal = await heldRoundSearchRefusal(prismaWith(held("checking")), {
      roleId: "role",
      botId: "lead",
      recordedThisTurn: false,
    });
    expect(refusal).toContain("Not run");
  });

  it("lets a search run when the latest round is shown, and in the owner's turn showing it", async () => {
    const shown = { roleId: "role", botId: "lead", recordedThisTurn: false };
    expect(await heldRoundSearchRefusal(prismaWith(held("shown")), shown)).toBeNull();
    expect(await heldRoundSearchRefusal(prismaWith(null), shown)).toBeNull();
    expect(await heldRoundSearchRefusal(prismaWith(held("checked")), shown)).toBeNull();
    expect(
      await heldRoundSearchRefusal(prismaWith(held("checked", "other")), shown),
    ).not.toBeNull();
  });

  it("refuses after this turn recorded the held round, whatever the stored state", async () => {
    expect(
      await heldRoundSearchRefusal(prismaWith(null), {
        roleId: undefined,
        botId: "lead",
        recordedThisTurn: true,
      }),
    ).toBe(ROUND_HELD_SEARCH_REFUSAL);
  });
});
