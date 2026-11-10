import { describe, expect, it, vi } from "vitest";
import { FEEDBACK_SAVING, saveInBackground, savesFeedbackInBackground } from "./background-save.js";

const failed = (result: unknown) => Boolean((result as { error?: unknown } | null)?.error);
const inputError = (result: unknown) => (result as { code?: unknown } | null)?.code === "INPUT";
const instant = () => Promise.resolve();

describe("savesFeedbackInBackground", () => {
  it.each([
    [{ target: "candidate", operation: "review", fit: "not_fit" }, true],
    [{ target: "round", operation: "scope" }, true],
    [{ target: "round", operation: "approve" }, false],
    [{ target: "candidate", operation: "pass" }, false],
    [{ target: "preference", operation: "add" }, false],
  ])("%o → %s", (args, expected) => {
    expect(savesFeedbackInBackground("recruiting_feedback", args)).toBe(expected);
  });

  it("leaves other tools alone", () => {
    expect(savesFeedbackInBackground("recruiting_role", { target: "round" })).toBe(false);
  });
});

describe("saveInBackground", () => {
  it("returns the saved result when the save is quick", async () => {
    const save = saveInBackground({
      first: Promise.resolve({ status: "recorded" }),
      retry: vi.fn(),
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
      waitMs: 1_000,
    });
    await expect(save.reply).resolves.toEqual({ status: "recorded" });
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
  });

  it("never hands the agent a refused save: it carries on while the save retries", async () => {
    const retry = vi.fn(async () => ({ status: "recorded" }));
    const onGiveUp = vi.fn();
    const save = saveInBackground({
      first: Promise.resolve({ error: "Not recorded: nothing was saved" }),
      retry,
      failed,
      inputError,
      onGiveUp,
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("does not wait for a slow save", async () => {
    let finish!: (value: unknown) => void;
    const save = saveInBackground({
      first: new Promise((resolve) => {
        finish = resolve;
      }),
      retry: vi.fn(),
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    finish({ status: "recorded" });
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
  });

  it("logs a save that still fails after its retries, without telling the agent", async () => {
    const onGiveUp = vi.fn();
    const retry = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const save = saveInBackground({
      first: Promise.resolve({ error: "refused" }),
      retry,
      failed,
      inputError,
      onGiveUp,
      sleep: instant,
      retryDelaysMs: [1, 1],
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    await save.settled;
    expect(retry).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledWith({ error: "database unavailable" });
  });

  it("passes on people the agent named wrongly, so it can fix them", async () => {
    const wrong = { error: "No saved person on this role matches", code: "INPUT" };
    const retry = vi.fn();
    const save = saveInBackground({
      first: Promise.resolve(wrong),
      retry,
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(wrong);
    await save.settled;
    expect(retry).not.toHaveBeenCalled();
  });
});
