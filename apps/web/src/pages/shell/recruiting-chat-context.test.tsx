import { expect, it } from "vitest";
import { recruitingChatContext } from "./recruiting-chat-context";

it("carries the selected plan as typed context without adding it to visible text", () => {
  expect(
    recruitingChatContext("Engineering", { name: "Candidate Example" }, "internal-plan"),
  ).toEqual({
    roleTitle: "Engineering",
    contact: { name: "Candidate Example" },
    schedulingPlanId: "internal-plan",
  });
  expect(recruitingChatContext(undefined, undefined)).toBeUndefined();
  expect(recruitingChatContext(undefined, undefined, "internal-plan")).toEqual({
    schedulingPlanId: "internal-plan",
  });
});
