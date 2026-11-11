import { describe, expect, it, vi } from "vitest";
import { awayRecapNote } from "./away-recap.js";

const now = new Date("2026-11-11T08:00:00Z");
const prismaWith = (lastWrote: Date | null, updates: number) => ({
  message: {
    findFirst: vi.fn(async () => (lastWrote ? { createdAt: lastWrote } : null)),
    count: vi.fn(async () => updates),
  },
});

describe("awayRecapNote", () => {
  it("asks for a recap when the person was away a day and updates came in", async () => {
    const note = await awayRecapNote(prismaWith(new Date("2026-11-09T20:00:00Z"), 3) as never, {
      threadId: "t",
      messageId: "m",
      now,
    });
    expect(note).toContain("2026-11-09");
    expect(note).toContain("while you were away");
  });

  it("stays out when the person wrote within a day", async () => {
    expect(
      await awayRecapNote(prismaWith(new Date("2026-11-10T12:00:00Z"), 3) as never, {
        threadId: "t",
        messageId: "m",
        now,
      }),
    ).toBeUndefined();
  });

  it("stays out when nothing came in, or on a first message", async () => {
    expect(
      await awayRecapNote(prismaWith(new Date("2026-11-01T12:00:00Z"), 0) as never, {
        threadId: "t",
        messageId: "m",
        now,
      }),
    ).toBeUndefined();
    expect(
      await awayRecapNote(prismaWith(null, 5) as never, { threadId: "t", messageId: "m", now }),
    ).toBeUndefined();
  });
});
