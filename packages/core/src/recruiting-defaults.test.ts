import { describe, expect, it } from "vitest";
import {
  RECRUITER_LANGUAGE,
  RECRUITING_CALIBRATION_QUICK_SEARCH,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_PDF_RENDERING,
  RECRUITING_ROUND_NEXT_STEP,
  RECRUITING_SCALE_START,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
  RECRUITING_SEARCH_SAVED_NEXT_STEP,
  recruiterQuestionNotInEnglish,
  recruitingBriefConfirmedNextStep,
} from "./recruiting-defaults.js";

describe("calibration fast path", () => {
  it("hands the new revision on with the confirmed brief", () => {
    expect(recruitingBriefConfirmedNextStep(5)).toContain("expectedRoleRevision 5");
  });

  it("keeps the pick off files and shell", () => {
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("calibration_round");
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("no files, shell");
  });
});

// Behavior rules that fixed a real bug are pinned in recruiting-rules.test.ts.
describe("maintained recruiting defaults", () => {
  // Same budget Workloop uses: a longer prompt dilutes every rule in it. Shorten before adding.
  it.each(RECRUITING_DEFAULT_BOTS)("$name instructions stay within 12,000 characters", (bot) => {
    expect(bot.instructions.length).toBeLessThanOrEqual(12_000);
  });

  it.each(RECRUITING_DEFAULT_SKILLS)("$name skill stays within 8,000 characters", (skill) => {
    expect(skill.body.length).toBeLessThanOrEqual(8_000);
  });

  // Each shared rule has one source: the executor adds recruiter language to every recruiting
  // run and the role context carries the calibration, scale and PDF rules.
  it.each([
    RECRUITER_LANGUAGE,
    RECRUITING_CALIBRATION_QUICK_SEARCH,
    RECRUITING_ROUND_NEXT_STEP,
    RECRUITING_SCALE_START,
    RECRUITING_PDF_RENDERING,
  ])("keeps a shared rule out of bot instructions and skills (%#)", (rule) => {
    for (const bot of RECRUITING_DEFAULT_BOTS) expect(bot.instructions).not.toContain(rule);
    for (const skill of RECRUITING_DEFAULT_SKILLS) expect(skill.body).not.toContain(rule);
  });

  // Skills ship with the code, so accounts with customized bot text still get the template.
  it("carries the search brief template in the sourcing skill", () => {
    const sourcing = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Recruitment sourcing continuation",
    )!;
    expect(sourcing.body).toContain(RECRUITING_SEARCH_BRIEF_TEMPLATE);
  });

  it("keeps account reads with Main before specialist work", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "Answer read-only interviews, shortlist, replies, sequences and roles questions with recruiting_candidates yourself; do not hand off",
    );
    expect(main.instructions).toContain(
      "Without a linked role default to all active roles and name each role",
    );
    expect(main.instructions).toContain("For specialist work beyond those reads");
    expect(main.instructions.indexOf("do not hand off")).toBeLessThan(
      main.instructions.indexOf("call handoff_to_bot"),
    );
  });

  it("gives Sourcer the scale stage order", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const order = [
      "accepted round and every round's feedback",
      "confirmed brief version",
      "Autumn research",
      "save every returned page",
      "feedback of any scope",
      "reply on the same Autumn task",
      "save the expanded pool",
    ].map((step) => sourcer.instructions.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("recruiterQuestionNotInEnglish", () => {
  const jd = { role: "user", blocks: [{ kind: "text", text: "新岗位：仓库运营经理（亚特兰大）" }] };

  it("flags a Chinese question for a Chinese JD", () => {
    expect(
      recruiterQuestionNotInEnglish("仓库运营经理职位的中文要求应如何设定？我建议设为加分项。", [
        jd,
      ]),
    ).toBe(true);
  });

  it("passes an English question that quotes a Chinese phrase", () => {
    expect(
      recruiterQuestionNotInEnglish("Should Chinese (中文) be required, preferred or not needed?", [
        jd,
      ]),
    ).toBe(false);
  });

  it("passes Chinese once the recruiter asked for it", () => {
    expect(
      recruiterQuestionNotInEnglish("中文要求怎么定？", [
        jd,
        { role: "user", blocks: [{ kind: "text", text: "请用中文回复我" }] },
      ]),
    ).toBe(false);
  });
});
