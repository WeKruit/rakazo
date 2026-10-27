import { describe, expect, it } from "vitest";
import * as computer from "./computer-commands.js";
import * as events from "./events.js";
import * as publicApi from "./index.js";
import * as recruiting from "./recruiting.js";
import * as filters from "./recruiting-candidate-filters.js";
import * as identifiers from "./recruiting-identifiers.js";

describe("frontend contract leaf exports", () => {
  it("preserves the canonical computer schema and helpers through existing exports", () => {
    expect(events.ComputerCommandSchema).toBe(computer.ComputerCommandSchema);
    expect(publicApi.ComputerCommandSchema).toBe(computer.ComputerCommandSchema);
    expect(events.ComputerCommandKind).toBe(computer.ComputerCommandKind);
    expect(publicApi.ComputerCommandKind).toBe(computer.ComputerCommandKind);
    expect(events.foldComputerCommands).toBe(computer.foldComputerCommands);
    expect(publicApi.foldComputerCommands).toBe(computer.foldComputerCommands);
    expect(publicApi.COMPUTER_COMMAND_OUTPUT_MAX_CHARS).toBe(
      computer.COMPUTER_COMMAND_OUTPUT_MAX_CHARS,
    );
  });

  it("preserves canonical recruiting schemas through existing exports", () => {
    expect(recruiting.ListRecruitingCandidatesInput).toBe(filters.ListRecruitingCandidatesInput);
    expect(publicApi.ListRecruitingCandidatesInput).toBe(filters.ListRecruitingCandidatesInput);
    expect(recruiting.RecruitingId).toBe(identifiers.RecruitingId);
    expect(recruiting.VerdictSchema).toBe(identifiers.VerdictSchema);
  });

  it("retains strict persisted-filter validation and cursor normalization", () => {
    const schema = filters.ListRecruitingCandidatesInput;
    expect(schema.parse({ roleId: "role", cursor: " cursor " })).toEqual({
      roleId: "role",
      cursor: "cursor",
    });
    for (const input of [
      { roleId: " " },
      { roleId: "role", cursor: " " },
      { roleId: "role", limit: 201 },
      { roleId: "role", query: "x".repeat(241) },
      { roleId: "role", verdict: "invented" },
      { roleId: "role", unexpected: true },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
});
