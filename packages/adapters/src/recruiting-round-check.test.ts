import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  inGroupOrder,
  listedBeforeRound,
  requestTarget,
  roundCountLine,
  roundCriteria,
  roundListedNotRecorded,
  roundRepeats,
  roundStillMissing,
  searchRowForAgent,
  withoutShownBefore,
} from "./recruiting-round-check.js";

describe("roundCriteria", () => {
  // The role's requirements are its hard criteria as saved: nothing reworded, joined or added by
  // code, and a brief field never adds a second copy.
  const prisma = {
    recruitingRole: {
      findUnique: async () => ({
        currentRevision: {
          criteria: [
            {
              id: "titles",
              priority: "hard",
              expression: { kind: "atom", statement: "data engineer titles only" },
            },
            {
              id: "place",
              priority: "hard",
              expression: { kind: "atom", statement: "Seattle metro, hybrid" },
            },
            {
              id: "nice",
              priority: "preferred",
              expression: { kind: "atom", statement: "Kafka" },
            },
          ],
        },
      }),
    },
  } as unknown as PrismaClient;

  it("returns each hard criterion in the words saved", async () => {
    expect(await roundCriteria(prisma, { roleId: "r" })).toEqual([
      { id: "titles", statement: "data engineer titles only" },
      { id: "place", statement: "Seattle metro, hybrid" },
    ]);
  });
});

const marks = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<object>()),
  readRecruitingResultsMarks: marks,
}));

describe("requestTarget", () => {
  const role = { roleId: "role", userId: "u", spaceId: "s" };
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));
  // Each round: the minute it was shown, the number its request asked for, the people in it.
  const db = (rounds: Array<[number, number, string[]]>, wrote: number[] = []) =>
    ({
      recruitingCalibrationRound: {
        findMany: async () =>
          rounds.map(([minute, , candidateKeys], index) => ({
            effectId: `e${index}`,
            candidateKeys,
            createdAt: at(minute),
          })),
      },
      externalEffect: {
        findMany: async () =>
          rounds.map(([, asked], index) => ({
            id: `e${index}`,
            request: { asked },
          })),
      },
      message: {
        findMany: async () => wrote.map((minute) => ({ createdAt: at(minute) })),
      },
    }) as unknown as PrismaClient;
  const people = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("starts a request where the count stood when the recruiter asked", async () => {
    marks.mockResolvedValue([]);
    // Nine counted before, "3 more", first round of the request shows one: met at twelve.
    await expect(
      requestTarget(
        db([
          [0, 10, people("a", 9)],
          [5, 3, ["b"]],
        ]),
        role,
        "t",
        3,
        10,
      ),
    ).resolves.toBe(12);
    // Someone delivered in this request and turned down since no longer counts either way.
    marks.mockResolvedValue([{ candidateKey: "b", mark: "not a fit" }]);
    await expect(
      requestTarget(
        db([
          [0, 10, people("a", 9)],
          [5, 3, ["b"]],
          [6, 3, ["c"]],
        ]),
        role,
        "t",
        3,
        10,
      ),
    ).resolves.toBe(12);
  });

  it("keeps the target when the recruiter writes before the request is met", async () => {
    marks.mockResolvedValue([]);
    // Find 100: 52 shown, "进度？" at minute 7, two more rounds: still 100.
    const rounds: Array<[number, number, string[]]> = [
      [0, 100, people("a", 10)],
      [3, 100, people("b", 42)],
      [8, 100, people("c", 10)],
    ];
    await expect(requestTarget(db(rounds, [7]), role, "t", 100, 62)).resolves.toBe(100);
  });

  it("starts a new request for a different number or after a met one the recruiter followed up", async () => {
    marks.mockResolvedValue([]);
    // "补足48人" with 52 shown: met at 100.
    await expect(
      requestTarget(
        db(
          [
            [0, 100, people("a", 52)],
            [9, 48, people("b", 10)],
          ],
          [8],
        ),
        role,
        "t",
        48,
        62,
      ),
    ).resolves.toBe(100);
    // Ten shown, three turned down, "再找10个": ten more than the seven counted.
    marks.mockResolvedValue(
      ["a0", "a1", "a2"].map((candidateKey) => ({
        candidateKey,
        mark: "not a fit",
      })),
    );
    await expect(
      requestTarget(
        db(
          [
            [0, 10, people("a", 10)],
            [9, 10, people("b", 10)],
          ],
          [8],
        ),
        role,
        "t",
        10,
        17,
      ),
    ).resolves.toBe(17);
    // The same three turned down with no new message: the request fills the three.
    await expect(
      requestTarget(
        db([
          [0, 10, people("a", 10)],
          [9, 10, people("b", 3)],
        ]),
        role,
        "t",
        10,
        10,
      ),
    ).resolves.toBe(10);
  });
});

describe("roundCountLine", () => {
  it("says how many are still to come when the round leaves the request short", () => {
    expect(roundCountLine({ counted: 9, turnedDown: 3 }, 2, true, 17)).toBe(
      "累计展示 12 人，你淘汰了 3 人，计入 9 人。还差 8 人，继续找。",
    );
    expect(roundCountLine({ counted: 13, turnedDown: 0 }, 3, false, 13)).toBe("13 shown so far.");
    expect(roundCountLine({ counted: 6, turnedDown: 0 }, 6, false, 10)).toBe("4 still to come.");
    expect(roundStillMissing(9, 17).stillMissing).toBe(8);
    expect(roundStillMissing(13, 13)).toEqual({});
  });
});

describe("listedBeforeRound", () => {
  // Staging 11-15: Kruit listed saved, unreviewed people mid-round; the round then picked four of
  // them, and asked about repeats Kruit called them repeats of round 1 and had them removed.
  it("names round people this chat listed before the round, outside any round list", async () => {
    const findMany = vi.fn(async () => [
      {
        updatedAt: new Date("2026-11-15T03:45:00Z"),
        blocks: [
          {
            kind: "text",
            text: "Data Eng · 1–8 / 141:\n1. **[Aditi](https://www.linkedin.com/in/aditi-g)**",
          },
        ],
      },
      {
        updatedAt: new Date("2026-11-15T03:46:00Z"),
        blocks: [
          {
            kind: "text",
            text: "10 people this round:\n1. **[Bo](https://www.linkedin.com/in/bo)**",
            recruitingRoundList: { roundId: "effect-round-1" },
          },
        ],
      },
    ]);
    const prisma = {
      recruitingCalibrationRound: {
        findMany: vi.fn(async () => [{ createdAt: new Date("2026-11-15T03:40:00Z") }]),
      },
      message: { findMany },
    } as unknown as PrismaClient;
    const listed = await listedBeforeRound(prisma, {
      threadId: "thread-global",
      roleId: "role-1",
      round: 2,
      createdAt: "2026-11-15T03:51:00Z",
      candidates: [
        { name: "Aditi", linkedinUrl: "https://www.linkedin.com/in/aditi-g/" },
        { name: "Aditya", linkedinUrl: "https://www.linkedin.com/in/aditi" },
        { name: "Bo", linkedinUrl: "https://www.linkedin.com/in/bo" },
      ],
    });
    expect(listed).toEqual(["Aditi"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-global",
          role: "bot",
          createdAt: { gt: new Date("2026-11-15T03:40:00Z"), lt: new Date("2026-11-15T03:51:00Z") },
        }),
      }),
    );
  });

  // Staging 11-15: Kruit's reply began before round 2 was recorded and listed the round once it
  // was; read back as "listed before the round", Kruit told the recruiter its new ten were repeats.
  it("leaves out a reply finished after the round was recorded", async () => {
    const prisma = {
      recruitingCalibrationRound: { findMany: vi.fn(async () => []) },
      message: {
        findMany: vi.fn(async () => [
          {
            updatedAt: new Date("2026-11-15T18:08:25Z"),
            blocks: [
              { kind: "text", text: "1. **Joel** · [LinkedIn](https://www.linkedin.com/in/joel)" },
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const listed = await listedBeforeRound(prisma, {
      threadId: "thread-global",
      roleId: "role-1",
      round: 2,
      createdAt: "2026-11-15T18:08:14Z",
      candidates: [{ name: "Joel", linkedinUrl: "https://www.linkedin.com/in/joel" }],
    });
    expect(listed).toEqual([]);
  });
});

describe("roundListedNotRecorded", () => {
  // Staging 11-15: the role's chat showed the new ten at 04:51:03 but the round was recorded at
  // 04:51:26; in between Kruit read round 1, reposted it and said the new round was not ready.
  it("sees a round list the role's chat posted that is not recorded yet", async () => {
    const findMany = vi.fn(async () => [
      { blocks: [{ kind: "text", text: "Here's what changed." }] },
      {
        blocks: [
          { kind: "text", text: "10 people this round:\n\n1. **[A](x)**", recruitingRoundList: {} },
        ],
      },
    ]);
    const prisma = {
      recruitingRole: { findFirst: vi.fn(async () => ({ sourceThreadId: "thread-role" })) },
      message: { findMany },
    } as unknown as PrismaClient;
    await expect(
      roundListedNotRecorded(prisma, { roleId: "role-1", after: "2026-11-15T04:48:02Z" }),
    ).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-role",
          role: "bot",
          createdAt: { gt: new Date("2026-11-15T04:48:02Z") },
        }),
      }),
    );
    // The list of a round that is recorded is not a next round still being written.
    findMany.mockResolvedValueOnce([
      {
        blocks: [{ kind: "text", text: "…", recruitingRoundList: { roundId: "effect-round-2" } }],
      },
    ]);
    await expect(
      roundListedNotRecorded(prisma, { roleId: "role-1", after: "2026-11-15T04:48:02Z" }),
    ).resolves.toBe(false);
  });
});

describe("withoutShownBefore", () => {
  it("drops people an earlier round showed and keeps the rest in order", async () => {
    const prisma = {
      recruitingCalibrationRound: {
        findMany: async () => [{ candidateKeys: ["a", "x"] }, { candidateKeys: ["c"] }],
      },
    };
    await expect(
      withoutShownBefore(prisma as never, "role", ["a", "b", "c", "d", "b"]),
    ).resolves.toEqual({ keys: ["b", "d"], shownBefore: 3 });
  });
});

describe("roundRepeats", () => {
  const person = (key: string) => ({ candidateKey: key, name: key.toUpperCase() });
  const rounds = (earlier: Array<{ round: number; candidateKeys: string[] }>) =>
    ({
      recruitingCalibrationRound: { findMany: vi.fn(async () => earlier) },
    }) as unknown as PrismaClient;

  it("names who a topped-up round kept from the round before (staging 11-15)", async () => {
    // Round 3 was round 2's eight plus two new; Kruit was told a round never repeats anyone,
    // saw the people marked as shown before, and could not answer "any repeats?".
    const text = await roundRepeats(
      rounds([
        { round: 1, candidateKeys: ["r1"] },
        { round: 2, candidateKeys: ["a", "b"] },
      ]),
      { roleId: "role", round: 3, candidates: ["a", "b", "c"].map(person) },
    );
    expect(text).toContain("A, B (round 2)");
    expect(text).toContain("C");
    expect(text).toContain("nobody from round 1");
  });

  it("says nobody repeats when no earlier round holds them", async () => {
    const text = await roundRepeats(rounds([{ round: 1, candidateKeys: ["r1"] }]), {
      roleId: "role",
      round: 2,
      candidates: ["a"].map(person),
    });
    expect(text).toMatch(/^none/);
  });
});

describe("searchRowForAgent", () => {
  it("gives the judge's verdicts as the one account of a judged person", () => {
    const row = {
      candidateKey: "linkedin:/in/a",
      name: "A",
      grade: "Strong",
      reason: "All requirements shown",
      snippet: "x".repeat(300),
      rowIndex: 3,
      email: null,
      locationTag: "there now",
      requirements_assessment: "Met - Shanghai\nPartial - Mandarin and working English",
    };
    expect(searchRowForAgent(row)).toEqual({
      candidateKey: "linkedin:/in/a",
      name: "A",
      grade: "Strong",
      requirements_assessment: row.requirements_assessment,
    });
    // Nobody has judged them yet: the search's own words are all there is.
    const { requirements_assessment: _judged, ...unjudged } = row;
    expect(searchRowForAgent(unjudged)).toEqual({
      candidateKey: "linkedin:/in/a",
      name: "A",
      grade: "Strong",
      reason: "All requirements shown",
      snippet: "x".repeat(160),
    });
  });
});

describe("inGroupOrder", () => {
  it("puts a group's people together, groups in the order they first appear", () => {
    // Recorded as a, b, c with c in a's group: printed and recorded as a, c, b.
    expect(inGroupOrder(["a", "b", "c"], { a: "Met", b: "To check", c: " Met " })).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(inGroupOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
});
