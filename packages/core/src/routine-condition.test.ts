import { describe, expect, it } from "vitest";
import {
  evaluateRoutineCondition,
  routineConditionError,
  scheduleConditionVariables,
} from "./routine-condition.js";

const event = {
  action: "opened",
  role: { title: "Senior Recruiter", openings: 3, tags: ["remote", "sales"] },
  "x-kind": "lead",
};

function check(condition: string, variables: Record<string, unknown> = { event }) {
  const result = evaluateRoutineCondition(condition, variables);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("evaluateRoutineCondition", () => {
  it("compares paths, lists and strings", () => {
    expect(check('event.action == "opened"')).toBe(true);
    expect(check('event.action != "opened"')).toBe(false);
    expect(check("event.role.openings >= 2 && event.role.openings < 10")).toBe(true);
    expect(check('event.action in ["closed", "opened"]')).toBe(true);
    expect(check('event.role.tags contains "remote"')).toBe(true);
    expect(check('event.role.title contains "recruiter"')).toBe(true);
    expect(check('event.role.title startsWith "Senior" || false')).toBe(true);
    expect(check('event.role.title matches "^senior\\\\s"')).toBe(true);
    expect(check('event["x-kind"] == "lead"')).toBe(true);
    expect(check('!(event.action == "opened")')).toBe(false);
  });

  it("treats missing fields as null instead of failing", () => {
    expect(check("event.missing.deep == null")).toBe(true);
    expect(check("event.missing")).toBe(false);
    expect(check("unknownVariable")).toBe(false);
  });

  it("reports syntax errors", () => {
    expect(routineConditionError('event.action == "opened')).toBe("Unclosed string");
    expect(routineConditionError("event.action ==")).toBe("Condition ends too early");
    expect(routineConditionError("event.action == 1 2")).toBe(
      "Unexpected text after the condition",
    );
    expect(routineConditionError('event.action == "opened"')).toBeUndefined();
  });

  it("gives schedules the local hour, weekday and date", () => {
    const variables = scheduleConditionVariables(
      new Date("2026-11-02T15:30:00.000Z"),
      "America/New_York",
    );
    expect(variables).toEqual({
      source: "schedule",
      now: { hour: 10, weekday: 1, date: "2026-11-02" },
    });
    expect(check("now.weekday >= 1 && now.weekday <= 5 && now.hour < 18", variables)).toBe(true);
  });
});
