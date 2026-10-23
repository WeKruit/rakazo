import { describe, expect, it } from "vitest";
import {
  CreateRecruitingReminderInput,
  ListRecruitingRemindersInput,
  RecruitingRemindersToolInputSchema,
  UpdateRecruitingReminderInput,
} from "./recruiting.js";

const dueAt = "2026-10-30T09:00:00.000Z";
describe("recruiting reminder contracts", () => {
  it("parses create/list/update inputs", () => {
    expect(
      CreateRecruitingReminderInput.parse({ title: "Call", dueAt, candidateKey: "autumn:k1" }),
    ).toBeTruthy();
    expect(ListRecruitingRemindersInput.parse({ status: "open", dueBefore: dueAt })).toBeTruthy();
    expect(
      UpdateRecruitingReminderInput.parse({ id: "r1", status: "done", note: null }),
    ).toBeTruthy();
  });
  it("rejects bad shapes", () => {
    expect(() => CreateRecruitingReminderInput.parse({ title: "x".repeat(201), dueAt })).toThrow();
    expect(() => CreateRecruitingReminderInput.parse({ title: "x", dueAt: "tomorrow" })).toThrow();
    expect(() =>
      CreateRecruitingReminderInput.parse({ title: "x", dueAt, candidateKey: "bad" }),
    ).toThrow();
    expect(() =>
      CreateRecruitingReminderInput.parse({ title: "x", dueAt, note: "n".repeat(4001) }),
    ).toThrow();
    expect(() => UpdateRecruitingReminderInput.parse({ id: "r1", status: "nope" })).toThrow();
  });
  it("discriminates tool operations", () => {
    expect(
      RecruitingRemindersToolInputSchema.parse({ operation: "delete", id: "r1" }),
    ).toBeTruthy();
    expect(() =>
      RecruitingRemindersToolInputSchema.parse({ operation: "archive", id: "r1" }),
    ).toThrow();
  });
});
