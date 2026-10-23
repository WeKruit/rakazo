import { describe, expect, it } from "vitest";
import { RECRUITING_DEFAULT_BOTS, RECRUITING_DEFAULT_SKILLS } from "./recruiting-defaults.js";

describe("maintained recruiting defaults", () => {
  it.each(RECRUITING_DEFAULT_BOTS)(
    "$name asks only consequential questions and keeps preferences retractable",
    (bot) => {
      expect(bot.instructions).toContain("Never send a fixed questionnaire");
      expect(bot.instructions).toContain("Never ask a recruiter to confirm G0, G1 or G2");
      expect(bot.instructions).toContain("recalled preferences before asking");
      expect(bot.instructions).toContain(
        "withdraws or contradicts a preference, update or forget it",
      );
      expect(bot.instructions).toContain("only after the human confirms it");
    },
  );

  it.each(RECRUITING_DEFAULT_BOTS)("$name works ahead, reports once and offers routines", (bot) => {
    expect(bot.instructions).toContain(
      "Never make the recruiter wait or poll: start the work and answer with where it stands.",
    );
    expect(bot.instructions).toContain(
      "post one progress line in business language and nothing more until there is a result",
    );
    expect(bot.instructions).toContain("say what changed and stop; no filler");
    expect(bot.instructions).toContain(
      "If blocked, say exactly what is blocked and what would unblock it.",
    );
    expect(bot.instructions).toContain(
      "create it with schedule_create only after the recruiter says yes",
    );
    expect(bot.instructions).toContain(
      "keep IDs, tool names, gate codes, cursors and JSON internal",
    );
  });

  it("keeps feedback and recalibration on the same Autumn task", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain("Route candidate or search-direction feedback to Sourcer");
    const sourcing = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Recruitment sourcing continuation",
    )!;
    expect(sourcing.body).toContain("ask Autumn on the same task for fresh calibration");
  });

  it("gives Sourcer the find-people stage order and the no-polling continuation rule", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const order = [
      "saved JD",
      "decision-affecting gaps",
      "confirmed brief version",
      "Autumn research",
      "save every returned page",
      "ten-profile calibration",
      "feedback of any scope",
      "reply on the same Autumn task",
      "save the expanded pool",
    ].map((step) => sourcer.instructions.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sourcer.instructions).toContain("providerTaskId from saved candidate sources");
    expect(sourcer.instructions).toContain(
      "make one status read, then stop; results arrive in this conversation automatically",
    );
    expect(sourcer.instructions).toContain("Never loop on status");
    expect(sourcer.instructions).toContain("Missing resume is unknown, never a rejection");
  });
});
