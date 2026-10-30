import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createToolFixMemory,
  describeFix,
  errorSignature,
  parseToolFixes,
  renderToolFixes,
  upsertToolFix,
  withKnownFix,
} from "./tool-fixes.js";

const context = {
  operationId: "op",
  traceId: "op",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function store(content = "", revision = 0) {
  const doc = { content, revision };
  return {
    doc,
    read: vi.fn(async () => ({
      documents: doc.revision ? [{ id: "d", path: "tool-fixes.md", ...doc }] : [],
    })),
    commit: vi.fn(async (request: { content: string; expectedRevision: number }) => {
      if (request.expectedRevision !== doc.revision)
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      doc.content = request.content;
      doc.revision += 1;
      return { path: "tool-fixes.md", revision: doc.revision };
    }),
  };
}

const memoryFor = (memory: ReturnType<typeof store>) =>
  createToolFixMemory({
    memory: memory as never,
    context,
    botId: "bot",
    runId: "run",
    threadId: "thread",
    now: () => new Date("2026-10-30T05:00:00Z"),
  });

describe("tool fixes", () => {
  it("matches the same error across ids, numbers, quotes and links", () => {
    expect(errorSignature('Cursor 3f9a1c2e88b4 for "USC" expired after 50 rows')).toBe(
      errorSignature("Cursor 77aa01bb33cc for 'Stanford' expired after 100 rows"),
    );
    expect(errorSignature("See https://x.example/a for a@b.example")).toBe(
      "see <link> for <email>",
    );
  });

  it("describes the change by argument name and repeats only plain values", () => {
    expect(
      describeFix(
        { cursor: "abc", filter: "usc", limit: 50 },
        { filter: "Jane Doe", limit: 25, from: "start" },
      ),
    ).toBe("removed `cursor`, changed `filter`, changed `limit` to `25`, added `from` to `start`");
    expect(describeFix({ q: "a" }, { q: "a" })).toBe("the same call, retried once");
  });

  it("round-trips the memory document and keeps one line per error, newest first", () => {
    const a = { tool: "t", error: "e one", fix: "removed `x`", at: "2026-10-29" };
    const b = { tool: "t", error: "e two", fix: "added `y`", at: "2026-10-29" };
    const text = renderToolFixes([a, b]);
    expect(parseToolFixes(text)).toEqual([a, b]);
    expect(upsertToolFix([a, b], a)).toBeUndefined();
    expect(upsertToolFix([a, b], { ...b, fix: "removed `z`", at: "2026-10-30" })).toEqual([
      { ...b, fix: "removed `z`", at: "2026-10-30" },
      a,
    ]);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...a, error: `e ${i}` }));
    expect(upsertToolFix(many, b)).toHaveLength(20);
  });

  it("adds the note where the model reads it", () => {
    expect(withKnownFix({ error: "x" }, "n")).toEqual({ error: "x", knownFix: "n" });
    expect(
      withKnownFix({ kind: "agent_tool_result", content: [{ type: "text", text: "x" }] }, "n"),
    ).toEqual({
      kind: "agent_tool_result",
      content: [
        { type: "text", text: "x" },
        { type: "text", text: "n" },
      ],
    });
  });

  it("learns a fix, reuses it in a later run, and never learns from questions", async () => {
    const memory = store();
    const run1 = memoryFor(memory);
    expect(
      await run1.failed("list_people", { cursor: "p2", filter: "usc" }, "Cursor 12 is stale"),
    ).toBe(undefined);
    await run1.succeeded("list_people", { filter: "usc" });
    expect(memory.doc.content).toContain("worked after: removed `cursor` (learned 2026-10-30)");

    const run2 = memoryFor(memory);
    expect(await run2.failed("list_people", { cursor: "p9" }, "Cursor 40 is stale")).toContain(
      "What worked then: removed `cursor`",
    );
    expect(await run2.failed("other_tool", {}, "Cursor 40 is stale")).toBeUndefined();

    await run2.failed("ask_user", {}, "options must have two entries");
    await run2.succeeded("ask_user", {});
    expect(memory.commit).toHaveBeenCalledTimes(1);
  });

  it("rereads and saves again when another run changed the document first", async () => {
    const memory = store();
    const run = memoryFor(memory);
    await run.failed("t", { a: 1 }, "boom");
    memory.doc.content = renderToolFixes([
      { tool: "u", error: "other", fix: "x", at: "2026-10-29" },
    ]);
    memory.doc.revision = 3;
    await run.succeeded("t", {});
    expect(parseToolFixes(memory.doc.content).map((fix) => fix.tool)).toEqual(["t", "u"]);
  });
});
