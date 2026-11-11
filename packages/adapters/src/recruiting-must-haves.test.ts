import { RecruitingCriterionSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { statedMustHaveCriteria, statedMustHaves } from "./recruiting-must-haves.js";

describe("statedMustHaves", () => {
  it("keeps each must-have a Chinese JD states, in its own words", () => {
    expect(
      statedMustHaves(
        "新岗位：华东区销售总监，常驻上海，医疗器械行业，10年以上销售经验，带过20人以上团队。必须会说普通话和英语，必须有三甲医院渠道资源。",
      ),
    ).toEqual(["必须会说普通话和英语", "必须有三甲医院渠道资源"]);
  });

  it("reads English must-haves and skips what is optional", () => {
    expect(
      statedMustHaves(
        "Senior PM in Austin. Must have 5+ years in fintech. Mandarin is nice to have. Python not required.",
      ),
    ).toEqual(["Must have 5+ years in fintech"]);
  });

  it("finds nothing in a message with no must-haves", () => {
    expect(statedMustHaves("帮我开个新岗位：高级产品经理，会说中文更好，不强求。")).toEqual([]);
  });

  it("saves them as hard criteria that cite the recruiter's message", () => {
    const quote = "新岗位：华东区销售总监，常驻上海。必须会说普通话和英语。";
    const criteria = statedMustHaveCriteria({
      id: "current-message-source",
      kind: "original_material",
      anchor: { kind: "message", messageId: "message-1", locator: "blocks[0].text" },
      readState: "read",
      readAt: "2026-11-11T03:18:29.374Z",
      quote,
    });
    expect(criteria.map((criterion) => RecruitingCriterionSchema.parse(criterion))).toMatchObject([
      { priority: "hard", expression: { statement: "必须会说普通话和英语" } },
    ]);
    expect(statedMustHaveCriteria(undefined)).toEqual([]);
  });
});
