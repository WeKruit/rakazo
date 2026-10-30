import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("@rakazo/db", () => ({ listRecruitingCandidates: list }));

const { nextRoleContactBatch } = await import("./role-contact-batch.js");

const person = (index: number) => ({
  name: `Person ${index}`,
  company: "Acme",
  linkedinUrl: `https://www.linkedin.com/in/person-${index}`,
});

describe("nextRoleContactBatch", () => {
  beforeEach(() => {
    list.mockReset();
    // 120 people over two pages, read in Results order.
    list.mockImplementation(async (_prisma, _actor, input: { cursor?: string }) =>
      input.cursor
        ? { items: Array.from({ length: 20 }, (_, i) => person(100 + i)), nextCursor: null }
        : { items: Array.from({ length: 100 }, (_, i) => person(i)), nextCursor: "page-2" },
    );
  });

  it("pages the role itself and skips people a source already looked up", async () => {
    const saved = {
      emails: new Map([
        [
          "linkedin:/in/person-0",
          [{ address: "a@b.co", type: "work", status: null, provider: "fullenrich" }],
        ],
      ]),
      searched: new Map([["linkedin:/in/person-1", new Set(["fullenrich"])]]),
    } as never;
    const batch = await nextRoleContactBatch(
      {} as never,
      { spaceId: "s", userId: "u" },
      "role",
      110,
      saved,
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(batch.people).toHaveLength(50);
    expect(batch.people[0]!.name).toBe("Person 2");
    expect(batch.alreadyLookedUp).toBe(2);
    expect(batch.remaining).toBe(58);
  });

  it("reports nothing left once the first N are looked up", async () => {
    const searched = new Map(
      Array.from({ length: 10 }, (_, i) => [`linkedin:/in/person-${i}`, new Set(["fullenrich"])]),
    );
    const batch = await nextRoleContactBatch(
      {} as never,
      { spaceId: "s", userId: "u" },
      "role",
      10,
      {
        emails: new Map(),
        searched,
      } as never,
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(batch).toMatchObject({ people: [], remaining: 0, alreadyLookedUp: 10 });
  });
});
