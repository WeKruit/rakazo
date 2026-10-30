import { describe, expect, it } from "vitest";
import { readOffsetPages } from "./recruiting.js";

function source(total: number, pageCap: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  const offsets: number[] = [];
  const read = async (offset: number) => {
    offsets.push(offset);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const items = Array.from(
      { length: Math.max(0, Math.min(pageCap, total - offset)) },
      (_, i) => offset + i,
    );
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    };
  };
  return { read, offsets, maxInFlight: () => maxInFlight };
}

describe("readOffsetPages", () => {
  it("reads every full page, a few at a time, in order", async () => {
    const s = source(420, 50);
    const pages = await readOffsetPages(s.read, 50, 4);
    expect(pages.flatMap((page) => page.items)).toEqual(Array.from({ length: 420 }, (_, i) => i));
    expect(s.offsets.sort((a, b) => a - b)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400]);
    expect(s.maxInFlight()).toBe(4);
  });

  it("reads a single page once", async () => {
    const s = source(30, 50);
    expect((await readOffsetPages(s.read, 50, 4)).flatMap((page) => page.items)).toHaveLength(30);
    expect(s.offsets).toEqual([0]);
  });

  it("follows a source that returns short pages one page at a time", async () => {
    const s = source(70, 25);
    const pages = await readOffsetPages(s.read, 50, 4);
    expect(pages.flatMap((page) => page.items)).toEqual(Array.from({ length: 70 }, (_, i) => i));
    expect(s.offsets).toEqual([0, 25, 50]);
    expect(s.maxInFlight()).toBe(1);
  });
});
