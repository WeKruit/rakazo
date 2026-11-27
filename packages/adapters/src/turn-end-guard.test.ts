import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  recruitingRoundListText,
  roundPassage,
} from "./turn-end-guard.js";

describe("recruitingRoundListText", () => {
  it("lists the ten with each search's own reason for the person", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `person-${i}`);
    const searches = vi.fn(async () => [
      {
        result: {
          candidateRows: [
            { candidateKey: "person-0", name: "Person 0", reason: "Built warehouse ops" },
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

  it("describes a judged person by the verdicts, never by the profile's opening words", async () => {
    const prisma = {
      externalEffect: {
        findMany: vi.fn(async () => [
          {
            request: { operation: "save_search" },
            result: {
              candidateRows: [
                {
                  candidateKey: "linkedin:/in/zy",
                  snippet: "Aug 2021 - Present (4 years and 11 months) in Shanghai",
                  reason: "Data engineer in Shanghai",
                },
              ],
            },
          },
        ]),
      },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [
          {
            candidateKey: "linkedin:/in/zy",
            name: "ZY",
            matchFields: {
              criteria: [
                { statement: "5+ years of pipelines", level: "strong" },
                { statement: "Spark or Flink", level: "medium" },
                { statement: "Mandarin", level: "silent" },
                { statement: "too managerial", level: "silent", avoid: true },
              ],
            },
          },
        ]),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      candidateKeys: ["linkedin:/in/zy"],
    });
    expect(text).toContain("> partly: Spark or Flink; not stated: Mandarin");
    expect(text).not.toContain("Meets");
    expect(text).not.toContain("4 years and 11 months");
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

  it("prints the agent's own group headings where they change, numbering straight through", async () => {
    const prisma = {
      externalEffect: { findMany: vi.fn(async () => []) },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () =>
          ["a", "b", "c"].map((key) => ({ candidateKey: key, name: key.toUpperCase() })),
        ),
      },
    } as never;
    const text = await recruitingRoundListText(prisma, {
      threadId: "thread-1",
      spaceId: "space-1",
      roleId: "role-1",
      // The group's people are not next to each other: its heading is still printed once.
      candidateKeys: ["a", "c", "b"],
      groupOf: { a: "Meet everything asked", b: "Meet everything asked", c: "Years not stated" },
    });
    expect(text).toBe(
      "3 people this round:\n\nMeet everything asked\n1. **A**\n2. **B**\n\nYears not stated\n3. **C**",
    );
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
      chinese: true,
    });
    expect(text).toBe("本轮 1 人：\n\n1. **Person 1**");
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

  // 2026-10-26 02:18 live ending: a blocked turn promised work for "after recovery" and stopped.
  const promised: MessageBlock[] = [
    { kind: "text", text: "恢复后我会先提交完整简报供确认，再立即搜索并列出10位候选人。" },
  ];
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

