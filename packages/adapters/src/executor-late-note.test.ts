import { describe, expect, it } from "vitest";
import { lateNote } from "./executor.js";

describe("lateNote", () => {
  it("joins the opening context only when already back", async () => {
    const note = lateNote(Promise.resolve("save it"));
    await Promise.resolve();
    expect(note.takeReady()).toBe("save it");
    expect(await note.withNotice(Promise.resolve("memory changed"))).toBe("memory changed");
  });

  it("hands a late note to the next model step once, beside other notices", async () => {
    let resolve!: (value: string) => void;
    const note = lateNote(new Promise<string>((done) => (resolve = done)));
    expect(note.takeReady()).toBeUndefined();
    resolve("save it");
    await Promise.resolve();
    expect(await note.withNotice(Promise.resolve("memory changed"))).toBe(
      "memory changed\n\nsave it",
    );
    expect(await note.withNotice(undefined)).toBeUndefined();
  });

  it("ignores a failed judge", async () => {
    const note = lateNote(Promise.reject(new Error("down")));
    await Promise.resolve();
    expect(await note.withNotice(undefined)).toBeUndefined();
  });
});
