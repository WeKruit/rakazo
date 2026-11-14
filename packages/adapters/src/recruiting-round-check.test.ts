import { describe, expect, it } from "vitest";
import { checkRound } from "./recruiting-round-check.js";

describe("checkRound", () => {
  // From a staging feedback round: Seattle and Spark/Kafka from the JD, then "no production
  // Spark/Kafka shown" saved from the recruiter's turn-down after round one.
  const criteria = [
    { id: "seattle", statement: "Seattle area, hybrid 3 days", added: false },
    { id: "years", statement: "6+ years", added: false },
    { id: "prod-stack", statement: "shows production Spark and Kafka work", added: true },
  ];
  const base = { criteria, asked: new Set<string>(), shortOfTen: "record fewer" };
  const all = (verdict: "shown" | "unknown" | "fails") => ({
    seattle: "shown" as const,
    years: verdict,
    "prod-stack": verdict,
  });

  it("refuses a pick without a verdict on every hard criterion, naming them", () => {
    const result = checkRound({ ...base, keys: ["a", "b"], checks: { a: all("shown") } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing for b");
    if (!result.ok) expect(result.error).toContain("prod-stack = shows production Spark");
  });

  it("refuses a failed criterion every time and an unknown new one once per person", () => {
    const checks = { a: all("shown"), b: all("fails"), c: all("unknown") };
    const first = checkRound({ ...base, keys: ["a", "b", "c"], checks });
    expect(first).toMatchObject({ ok: false, asked: ["c"] });
    const again = checkRound({ ...base, keys: ["a", "c"], checks, asked: new Set(["c"]) });
    expect(again).toEqual({
      ok: true,
      unverified: { c: "6+ years; shows production Spark and Kafka work" },
    });
  });

  it("lets an unknown on a criterion the recruiter has not raised since the last round through", () => {
    const result = checkRound({
      ...base,
      keys: ["a"],
      checks: { a: { seattle: "shown", years: "unknown", "prod-stack": "shown" } },
    });
    expect(result).toEqual({ ok: true, unverified: { a: "6+ years" } });
  });
});
