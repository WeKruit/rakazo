import { describe, expect, it } from "vitest";
import { parseReplacementPlan } from "./replace-slot.js";

const plan = {
  target: {
    slot: "worker-a",
    appId: "ap-a",
    appName: "a",
    entry: "slots.py::worker_a_app",
    environment: "synthetic",
  },
  peer: {
    slot: "worker-b",
    appId: "ap-b",
    appName: "b",
    entry: "slots.py::worker_b_app",
    environment: "synthetic",
  },
  expectedGeneration: "a".repeat(40),
  generation: "b".repeat(40),
  timeoutMs: 5000,
};
describe("explicit slot replacement plan", () => {
  it("requires independently named worker targets and concrete image generations", () => {
    expect(parseReplacementPlan(plan)).toEqual(plan);
  });
  it("rejects API, unscoped environment, missing App variable and unbounded deadline", () => {
    for (const override of [
      { target: { ...plan.target, slot: "api" } },
      { target: { ...plan.target, environment: "" } },
      { target: { ...plan.target, entry: "slots.py" } },
      { generation: "latest" },
      { timeoutMs: Infinity },
    ])
      expect(() => parseReplacementPlan({ ...plan, ...override })).toThrow();
  });
});
