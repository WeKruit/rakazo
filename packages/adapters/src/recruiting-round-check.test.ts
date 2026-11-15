import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  checkRound,
  listedBeforeRound,
  roundCriteria,
  roundListedNotRecorded,
  roundPeopleNamed,
  roundRepeats,
} from "./recruiting-round-check.js";

describe("checkRound", () => {
  // From a staging feedback round: Seattle and Spark/Kafka from the JD, then "no production
  // Spark/Kafka shown" saved from the recruiter's turn-down after round one.
  const criteria = [
    { id: "seattle", statement: "Seattle area, hybrid 3 days", added: false },
    { id: "years", statement: "6+ years", added: false },
    { id: "prod-stack", statement: "shows production Spark and Kafka work", added: true },
  ];
  const base = { criteria, asked: new Set<string>(), shortOfTen: "record fewer" };
  const all = (verdict: "shown" | "unknown" | "fails") => ({
    seattle: "shown" as const,
    years: verdict,
    "prod-stack": verdict,
  });

  it("refuses a pick without a verdict on every hard criterion, naming them", () => {
    const result = checkRound({ ...base, keys: ["a", "b"], checks: { a: all("shown") } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing for b");
    if (!result.ok) expect(result.error).toContain("prod-stack = shows production Spark");
  });

  it("refuses a failed criterion every time and an unknown new one once per person", () => {
    const checks = { a: all("shown"), b: all("fails"), c: all("unknown") };
    const first = checkRound({ ...base, keys: ["a", "b", "c"], checks });
    expect(first).toMatchObject({ ok: false, asked: ["c"] });
    const again = checkRound({ ...base, keys: ["a", "c"], checks, asked: new Set(["c"]) });
    expect(again).toEqual({
      ok: true,
      unverified: { c: "6+ years; shows production Spark and Kafka work" },
    });
  });

  it("lets an unknown on a criterion the recruiter has not raised since the last round through", () => {
    const result = checkRound({
      ...base,
      keys: ["a", "b"],
      checks: { a: { seattle: "shown", years: "unknown", "prod-stack": "shown" }, b: all("shown") },
    });
    expect(result).toEqual({ ok: true, unverified: { a: "6+ years" } });
  });

  it("lets an unknown on a newly raised criterion through once a top-up came back short", () => {
    const result = checkRound({
      ...base,
      keys: ["c"],
      checks: { c: all("unknown") },
      relaxed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("keeps what no pick's row shows off each person's note", () => {
    const shown = { seattle: "shown", "prod-stack": "shown" } as const;
    const result = checkRound({
      ...base,
      keys: ["a", "b"],
      checks: { a: { ...shown, years: "unknown" }, b: { ...shown, years: "unknown" } },
    });
    expect(result).toEqual({ ok: true, unverified: {} });
  });
});

describe("roundCriteria", () => {
  // Staging 11-15: the brief was saved seconds after round one was recorded, so every brief field
  // looked raised since that round and "unknown" was refused for every person, base pay included,
  // leaving round two short. New means the recruiter said it after the last round.
  const field = (key: string, value: string, message: string, origin = "user_instruction") => ({
    key,
    value,
    origin,
    state: "known",
    sourceRefIds: [`human-message:${message}`],
  });
  const roundAt = new Date("2026-11-15T00:18:00Z");
  const prisma = {
    recruitingRole: {
      findUnique: async () => ({
        currentRevision: {
          criteria: [
            {
              id: "titles",
              priority: "hard",
              expression: { kind: "atom", statement: "data engineer titles only" },
              sourceRefs: [{ id: "x", anchor: { kind: "message", messageId: "m-after" } }],
            },
          ],
          brief: {
            fields: [
              field("production technologies", "Spark and Kafka in production", "m-jd"),
              field("location", "Seattle metro, hybrid", "m-after"),
              field("language", "none", "m-jd", "inferred"),
              field("Should I cap experience at 10 years?", "Target 6–10 years", "m-jd"),
            ],
          },
        },
      }),
    },
    recruitingCalibrationRound: { findFirst: async () => ({ createdAt: roundAt }) },
    message: {
      findMany: async ({ where }: { where: { createdAt: { gt: Date } } }) =>
        [
          { id: "m-jd", createdAt: new Date("2026-11-15T00:17:00Z") },
          { id: "m-after", createdAt: new Date("2026-11-15T00:19:00Z") },
        ].filter((message) => message.createdAt > where.createdAt.gt),
    },
    externalEffect: {
      findMany: async () => [
        {
          id: "fb-1",
          createdAt: new Date("2026-11-15T00:19:30Z"),
          request: { summary: "William Z. is a generic software engineer, not hands-on data eng" },
        },
      ],
    },
  } as unknown as PrismaClient;

  it("marks only what the recruiter said after the last round as new", async () => {
    expect(await roundCriteria(prisma, { roleId: "r", spaceId: "s" })).toEqual([
      {
        id: "brief:production technologies",
        statement: "production technologies: Spark and Kafka in production",
        added: false,
      },
      { id: "brief:location", statement: "location: Seattle metro, hybrid", added: true },
      {
        id: "brief:Should I cap experience at 10 years?",
        statement: "Target 6–10 years",
        added: false,
      },
      { id: "titles", statement: "data engineer titles only", added: true },
      {
        id: "turned-down:fb-1",
        statement:
          "not what the recruiter turned down: William Z. is a generic software engineer, not hands-on data eng",
        added: true,
      },
    ]);
  });
});

describe("listedBeforeRound", () => {
  // Staging 11-15: Kruit listed saved, unreviewed people mid-round; the round then picked four of
  // them, and asked about repeats Kruit called them repeats of round 1 and had them removed.
  it("names round people this chat listed before the round, outside any round list", async () => {
    const findMany = vi.fn(async () => [
      {
        blocks: [
          {
            kind: "text",
            text: "Data Eng · 1–8 / 141:\n1. **[Aditi](https://www.linkedin.com/in/aditi-g)**",
          },
        ],
      },
      {
        blocks: [
          {
            kind: "text",
            text: "10 people this round:\n1. **[Bo](https://www.linkedin.com/in/bo)**",
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
});

describe("roundListedNotRecorded", () => {
  // Staging 11-15: the role's chat showed the new ten at 04:51:03 but the round was recorded at
  // 04:51:26; in between Kruit read round 1, reposted it and said the new round was not ready.
  it("counts the people of a round list the role's chat posted after the latest recorded round", async () => {
    const findMany = vi.fn(async () => [
      { blocks: [{ kind: "text", text: "Here's what changed." }] },
      { blocks: [{ kind: "text", text: "10 people this round:\n\n1. **[A](x)**\n2. **[B](y)**" }] },
    ]);
    const prisma = {
      recruitingRole: { findFirst: vi.fn(async () => ({ sourceThreadId: "thread-role" })) },
      message: { findMany },
    } as unknown as PrismaClient;
    await expect(
      roundListedNotRecorded(prisma, { roleId: "role-1", after: "2026-11-15T04:48:02Z" }),
    ).resolves.toEqual({ people: 10 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-role",
          role: "bot",
          createdAt: { gt: new Date("2026-11-15T04:48:02Z") },
        }),
      }),
    );
    findMany.mockResolvedValueOnce([]);
    await expect(
      roundListedNotRecorded(prisma, { roleId: "role-1", after: "2026-11-15T04:48:02Z" }),
    ).resolves.toBeNull();
  });
});

describe("roundPeopleNamed", () => {
  const prismaFor = (text: string, approvedAt: Date | null = null) =>
    ({
      thread: { findUnique: vi.fn(async () => ({ activeRecruitingRoleId: "role-1" })) },
      message: { findUnique: vi.fn(async () => ({ blocks: [{ kind: "text", text }] })) },
      recruitingCalibrationRound: {
        findFirst: vi.fn(async () => ({ round: 1, candidateKeys: ["a", "b", "c"], approvedAt })),
      },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          { candidateKey: "a", name: "Ryan Braley" },
          { candidateKey: "b", name: "Parthasarathi Samantaray" },
          { candidateKey: "c", name: "Mohamed Hassan" },
        ]),
      },
    }) as unknown as PrismaClient;
  const input = { threadId: "thread", messageId: "message" };

  // Staging play, 11-15: this message was recorded as accepting the round.
  it("finds the people a mixed message turns down, by number or name", async () => {
    await expect(
      roundPeopleNamed(
        prismaFor("#3 is off. parthasarathi is a technical architect. find me more like the rest"),
        input,
      ),
    ).resolves.toEqual({ round: 1, named: ["Parthasarathi Samantaray", "Mohamed Hassan"] });
  });

  it("finds nobody in a plain request for more, or once the round is approved", async () => {
    await expect(
      roundPeopleNamed(prismaFor("these look right, find 20 more"), input),
    ).resolves.toBeNull();
    await expect(
      roundPeopleNamed(prismaFor("ryan is off, find more", new Date()), input),
    ).resolves.toBeNull();
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
