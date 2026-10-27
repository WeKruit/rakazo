import { describe, expect, it } from "vitest";
import {
  collectContactPages,
  collectListPages,
  collectNavigationPages,
  collectOffsetListPages,
} from "./list-pages.js";

describe("bounded list continuation", () => {
  it("collects all 1000 entries in five requests of at most 200 rows", async () => {
    const rows = Array.from({ length: 1000 }, (_, id) => ({ id }));
    const lengths: number[] = [];
    const all = await collectListPages(async (offset) => {
      const items = rows.slice(offset, offset + 200);
      lengths.push(items.length);
      return { items, nextOffset: offset + 200 < rows.length ? offset + 200 : null };
    });
    expect(all).toEqual(rows);
    expect(lengths).toEqual([200, 200, 200, 200, 200]);
  });
  it("continues after an empty filtered group page", async () => {
    expect(
      await collectListPages(async (offset) =>
        offset === 0 ? { items: [], nextOffset: 200 } : { items: ["last"], nextOffset: null },
      ),
    ).toEqual(["last"]);
  });
  it("rejects a stuck cursor instead of an infinite duplicate fetch", async () => {
    await expect(collectListPages(async () => ({ items: [], nextOffset: 0 }))).rejects.toThrow(
      "Invalid list page cursor",
    );
  });
});

describe("aggregate page continuation", () => {
  const navigation = (id: string, ids: string[], nextOffset: number | null) => ({
    current: {
      id,
      name: "Synthetic",
      bots: ids.map((bot) => ({ id: bot })) as never[],
      groups: [],
      botSections: [],
      externalConversations: [],
    },
    spaces: [],
    nextOffset,
  });
  it("merges all navigation records while keeping the current Space", async () => {
    const result = await collectNavigationPages(async (offset) =>
      navigation("space", [String(offset)], offset === 0 ? 200 : null),
    );
    expect(result.current.bots).toEqual([{ id: "0" }, { id: "200" }]);
    expect(result.nextOffset).toBeNull();
  });
  it("rejects a Space change between pages", async () => {
    await expect(
      collectNavigationPages(async (offset) =>
        navigation(String(offset), [], offset === 0 ? 200 : null),
      ),
    ).rejects.toThrow("Navigation context changed");
  });
  it("combines contact pages without losing the last page metadata", async () => {
    const result = await collectContactPages(
      async (cursor) =>
        ({
          contacts: [{ candidateKey: cursor }],
          nextCursor: cursor === "0" ? "200" : null,
          partial: cursor === "0",
        }) as never,
    );
    expect(result.contacts).toEqual([{ candidateKey: "0" }, { candidateKey: "200" }]);
    expect(result.partial).toBe(false);
  });
});

it("drains differently sized structured lists without duplicate or dropped rows", async () => {
  const tasks = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const actions = tasks.slice(0, 250);
  const result = await collectOffsetListPages("recruiting/listResearch", async (offset) => ({
    tasks: tasks.slice(offset, offset + 200),
    actions: actions.slice(offset, offset + 200),
    observations: [],
  }));
  expect(result).toEqual({ tasks, actions, observations: [] });
});
