import { describe, expect, it } from "vitest";
import {
  CreateRecruitingCandidateNoteInput,
  ListRecruitingCandidateNotesInput,
  RecruitingNotesToolInputSchema,
  UpdateRecruitingCandidateNoteInput,
} from "./recruiting.js";

describe("recruiting candidate note contracts", () => {
  it("parses list/create/update inputs", () => {
    expect(
      ListRecruitingCandidateNotesInput.parse({ candidateKeys: ["autumn:k1", "crm:42"] }),
    ).toBeTruthy();
    expect(
      CreateRecruitingCandidateNoteInput.parse({ candidateKey: "crm:42", body: "Prefers remote" }),
    ).toBeTruthy();
    expect(UpdateRecruitingCandidateNoteInput.parse({ id: "n1", body: "y" })).toBeTruthy();
  });
  it("rejects bad shapes", () => {
    expect(() => ListRecruitingCandidateNotesInput.parse({ candidateKeys: [] })).toThrow();
    expect(() =>
      ListRecruitingCandidateNotesInput.parse({
        candidateKeys: Array.from({ length: 11 }, (_, i) => `crm:${i}`),
      }),
    ).toThrow();
    expect(() =>
      CreateRecruitingCandidateNoteInput.parse({ candidateKey: "bad", body: "x" }),
    ).toThrow();
    expect(() =>
      CreateRecruitingCandidateNoteInput.parse({ candidateKey: "crm:1", body: "   " }),
    ).toThrow();
    expect(() =>
      CreateRecruitingCandidateNoteInput.parse({ candidateKey: "crm:1", body: "n".repeat(8001) }),
    ).toThrow();
  });
  it("discriminates tool operations", () => {
    expect(RecruitingNotesToolInputSchema.parse({ operation: "delete", id: "n1" })).toBeTruthy();
    expect(() =>
      RecruitingNotesToolInputSchema.parse({ operation: "archive", id: "n1" }),
    ).toThrow();
  });
});
