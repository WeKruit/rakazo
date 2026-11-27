import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  listedBeforeRound,
  requestTarget,
  roundCountLine,
  roundCriteria,
  roundListedNotRecorded,
  roundRepeats,
  roundStillMissing,
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
  const db = (asked: Date | null, sinceRounds: string[][]) => {
    const findMany = vi.fn(async () => sinceRounds.map((candidateKeys) => ({ candidateKeys })));
    return {
      prisma: {
        message: { findFirst: async () => (asked ? { createdAt: asked } : null) },
        recruitingCalibrationRound: { findMany },
      } as unknown as PrismaClient,
      findMany,
    };
  };

  it("starts a request where the count stood when the recruiter asked", async () => {
    const at = new Date("2026-11-27T05:58:00Z");
    marks.mockResolvedValue([]);
    // Nine counted, "3 more", first round of the request: met at twelve.
    const first = db(at, []);
    await expect(requestTarget(first.prisma, role, "t", 3, 9)).resolves.toBe(12);
    expect(first.findMany.mock.calls[0]![0]).toMatchObject({
      where: { roleId: "role", status: "shown", createdAt: { gt: at } },
    });
    // A later round of the same request: the one already delivered is not counted twice.
    await expect(requestTarget(db(at, [["a"]]).prisma, role, "t", 3, 10)).resolves.toBe(12);
    // Someone delivered in this request and turned down since no longer counts either way.
    marks.mockResolvedValue([{ candidateKey: "a", mark: "not a fit" }]);
    await expect(requestTarget(db(at, [["a", "b"]]).prisma, role, "t", 3, 10)).resolves.toBe(12);
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
