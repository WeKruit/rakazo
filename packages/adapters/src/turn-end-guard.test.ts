import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  answeredAsk,
  answerSearchFilters,
  intakeAnswers,
  recruitingRoundListText,
  roundPassage,
} from "./turn-end-guard.js";

describe("recruitingRoundListText", () => {
  it("lists the ten with the profile passage each saved search returned", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `person-${i}`);
    const searches = vi.fn(async () => [
      {
        result: {
          candidateRows: [
            { candidateKey: "person-0", name: "Person 0", snippet: "Built warehouse ops" },
          ],
        },
      },
    ]);
    const text = await recruitingRoundListText(
      {
        externalEffect: { findMany: searches },
        recruitingCandidateOccurrence: {
          findMany: vi.fn(async () =>
            keys.map((candidateKey, i) => ({
              candidateKey,
              name: `Person ${i}`,
              title: "Warehouse Manager",
              company: "Example Co",
              location: "Atlanta",
            })),
          ),
        },
      } as never,
      { threadId: "thread-1", spaceId: "space-1", roleId: "role-1", candidateKeys: keys },
    );
    expect(searches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ run: { threadId: "thread-1" } }),
      }),
    );
    expect(text).toContain(
      "1. **Person 0** · Warehouse Manager · Example Co · Atlanta\n   > Built warehouse ops",
    );
    expect(text).toContain("10. **Person 9** · Warehouse Manager · Example Co · Atlanta");
  });

  it("shows the check's reason for a person in place of the search's passage", async () => {
    // Branch fr 11-21: a checked person's line quoted his team's name from the search, not the
    // Spark and Kafka work the check had read, and the recruiter took him for a backend engineer.
    const prisma = {
      externalEffect: {
        findMany: vi.fn(async () => [
          {
            request: { operation: "save_search" },
            result: {
              candidateRows: [
                { candidateKey: "linkedin:/in/kt", name: "KT", snippet: "Joined the ECS team" },
                { candidateKey: "linkedin:/in/ana", name: "Ana", snippet: "Built warehouse ops" },
              ],
            },
          },
          {
            request: {
              operation: "save_grades",
              rows: [
                {
                  linkedin_url: "https://www.linkedin.com/in/kt/",
                  fit_reasons: "Runs Spark streaming pipelines on Kafka topics in production.",
                },
              ],
            },
            result: {},
          },
        ]),
      },
      recruitingCandidateOccurrence: { findMany: vi.fn(async () => []) },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["linkedin:/in/kt", "linkedin:/in/ana"],
    });
    expect(text).toContain("> Runs Spark streaming pipelines on Kafka topics in production.");
    expect(text).not.toContain("ECS team");
    expect(text).toContain("> Built warehouse ops");
  });

  it("links each name to the LinkedIn profile its key names", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          { candidateKey: "linkedin:/in/runqi-guo", name: "Runqi Guo", company: "Pattern" },
        ]),
      },
    } as never;
    expect(
      await recruitingRoundListText(prisma, {
        threadId: "thread-1",
        spaceId: "space-1",
        roleId: "role-1",
        candidateKeys: ["linkedin:/in/runqi-guo"],
      }),
    ).toContain("1. **[Runqi Guo](https://www.linkedin.com/in/runqi-guo)** · Pattern");
  });

  it("lists only the saved people of a list still being written", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [{ candidateKey: "person-1", name: "Person 1" }]),
      },
    } as never;
    const input = { threadId: "thread-1", spaceId: "space-1", roleId: "role-1" };
    expect(
      await recruitingRoundListText(prisma, {
        ...input,
        candidateKeys: ["person-x", "person-1"],
        knownOnly: true,
      }),
    ).toContain("1. **Person 1**");
    expect(
      await recruitingRoundListText(prisma, {
        ...input,
        candidateKeys: ["person-x"],
        knownOnly: true,
      }),
    ).toBe("");
  });

  it("shows the last person of a list being written once the key is whole, counting who is shown", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          { candidateKey: "linkedin:/in/ana", name: "Ana" },
          { candidateKey: "linkedin:/in/bo", name: "Bo" },
          { candidateKey: "linkedin:/in/bo-lee", name: "Bo Lee" },
        ]),
      },
    } as never;
    const input = { threadId: "thread-1", spaceId: "space-1", roleId: "role-1", knownOnly: true };
    const whole = await recruitingRoundListText(prisma, {
      ...input,
      candidateKeys: ["linkedin:/in/bo-lee", "linkedin:/in/ana"],
      lastMayBeCut: true,
    });
    expect(whole).toContain("2 people this round");
    expect(whole).toContain("2. **[Ana](https://www.linkedin.com/in/ana)**");
    // "bo" may still become "bo-lee": not shown yet.
    const cut = await recruitingRoundListText(prisma, {
      ...input,
      candidateKeys: ["linkedin:/in/ana", "linkedin:/in/bo"],
      lastMayBeCut: true,
    });
    expect(cut).toContain("1 person this round");
    expect(cut).not.toContain("Bo");
  });

  it("names the must-haves a person's row does not show", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [{ candidateKey: "person-1", name: "Person 1" }]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["person-1"],
      unverified: { "person-1": "初创公司经历" },
    });
    expect(text).toContain("1. **Person 1**\n   Not verified: 初创公司经历");
  });

  it("writes its own words in Chinese for a recruiter writing Chinese", async () => {
    // Staging eval 11-11: "10 people this round:" headed the list in a Chinese chat.
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [{ candidateKey: "person-1", name: "Person 1" }]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["person-1"],
      unverified: { "person-1": "中文能力" },
      chinese: true,
    });
    expect(text).toBe("本轮 1 人：\n\n1. **Person 1**\n   未核实：中文能力");
  });

  it("lists a role's people under a given heading with the same lines as a round", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          { candidateKey: "linkedin:/in/person-1", name: "Person 1", title: "Lead", company: "Co" },
        ]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "role-thread",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["linkedin:/in/person-1"],
      heading: "Warehouse manager:",
    });
    expect(text).toBe(
      "Warehouse manager:\n\n1. **[Person 1](https://www.linkedin.com/in/person-1)** · Lead · Co",
    );
  });

  it("numbers a later page from its place in the whole list", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [{ candidateKey: "person-11", name: "Person 11" }]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "role-thread",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["person-11"],
      heading: "Warehouse manager · 11–11 / 81:",
      firstNumber: 11,
    });
    expect(text).toContain("\n\n11. **Person 11**");
  });

  it("says must-haves no one's row shows once, not under every person", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          { candidateKey: "person-1", name: "Person 1" },
          { candidateKey: "person-2", name: "Person 2" },
        ]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["person-1", "person-2"],
      unverified: { "person-1": "US work authorization", "person-2": "US work authorization" },
    });
    expect(text).toContain("this round:\nNot verified for anyone yet: US work authorization");
    expect(text).not.toContain("   Not verified:");
  });

  // 2026-10-26 02:18 live ending: a blocked turn promised work for "after recovery" and stopped.
  const promised: MessageBlock[] = [
    { kind: "text", text: "恢复后我会先提交完整简报供确认，再立即搜索并列出10位候选人。" },
  ];
});

describe("intakeAnswers", () => {
  const ask = (text: string) => ({ role: "bot", blocks: [{ kind: "ask", text }] });
  const say = (role: string, text: string) => ({ role, blocks: [{ kind: "text", text }] });

  it("pairs each question card with the recruiter's answer and skips the JD itself", () => {
    expect(
      intakeAnswers([
        say("user", "Research Scientist, Simulation — full JD"),
        ask("语言要求？"),
        say("user", "英语必需"),
        say("bot", "本轮 10 位人选"),
        say("user", "找 100 个"),
        ask("地点？"),
        say("user", "Redwood City 现场"),
        ask("语言要求？"),
        say("user", " 英语必需，中文不要求 "),
      ]),
    ).toEqual([
      { key: "地点？", value: "Redwood City 现场" },
      { key: "语言要求？", value: "英语必需，中文不要求" },
    ]);
  });
});

describe("answeredAsk", () => {
  const answers = [
    {
      key: "这个岗位的语言要求如何设定？建议以英语为必需。",
      value: "英语工作沟通必需，中文不要求",
    },
    { key: "Where must candidates be based?", value: "Redwood City, on site" },
  ];

  it("finds a question asked again with or without its suggestion", () => {
    expect(answeredAsk("这个岗位的语言要求如何设定？", answers)?.value).toBe(
      "英语工作沟通必需，中文不要求",
    );
    expect(answeredAsk("where must candidates be based? Options below.", answers)?.value).toBe(
      "Redwood City, on site",
    );
  });

  it("leaves a different question alone", () => {
    expect(answeredAsk("这个岗位的地点要求如何设定？", answers)).toBeUndefined();
    expect(answeredAsk("这个岗位的语言要求怎么定？", answers)).toBeUndefined();
    expect(answeredAsk("Why?", answers)).toBeUndefined();
  });
});

describe("roundPassage", () => {
  it("drops search scaffolding and cuts at a word", () => {
    expect(
      roundPassage(
        "Design Engineer at Peterbilt Motors Company Dallas-Fort Worth Metroplex (US) ... Mar 2024 - Present Level: Mid",
      ),
    ).toBe(
      "Design Engineer at Peterbilt Motors Company Dallas-Fort Worth Metroplex Mar 2024 - Present",
    );
    expect(
      roundPassage("Department: Engineering and Technical • Level: Specialist"),
    ).toBeUndefined();
    const long = `${"word ".repeat(60)}responsibilities continue`;
    const cut = roundPassage(long)!;
    expect(cut.endsWith("word…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(221);
  });
});

describe("answerSearchFilters", () => {
  it("turns a stated must-have into a filter every search applies", () => {
    expect(
      answerSearchFilters([
        {
          key: "Should Mandarin and English both be required?",
          value: "Require Mandarin and English",
        },
        { key: "Where?", value: "On-site within 30 miles of 07036" },
      ]),
    ).toEqual([
      {
        id: "recruiter-answer-1",
        mode: "include",
        origin: "user_instruction",
        statement: "Require Mandarin and English",
      },
      {
        id: "recruiter-answer-2",
        mode: "include",
        origin: "user_instruction",
        statement: "On-site within 30 miles of 07036",
      },
    ]);
  });

  it.each(["Prefer bilingual; consider either-language candidates", "不限地点", "No requirement"])(
    "leaves a preference or a lifted limit out (%s)",
    (value) => {
      expect(answerSearchFilters([{ key: "q", value }])).toEqual([]);
    },
  );
});
