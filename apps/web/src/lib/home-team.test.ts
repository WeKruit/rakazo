import { expect, it } from "vitest";
import { isEmptyHomeTeam } from "./home-team";

it("hides only the new account's empty home team, never a role or a used team", () => {
  expect(isEmptyHomeTeam({ id: "recruiting-0a1b2c", preview: "" })).toBe(true);
  expect(isEmptyHomeTeam({ id: "recruiting-0a1b2c", preview: "Find me a CFO" })).toBe(false);
  expect(isEmptyHomeTeam({ id: "recruiting-global-0a1b2c", preview: "" })).toBe(false);
  expect(isEmptyHomeTeam({ id: "role-0a1b2c", preview: "" })).toBe(false);
});
