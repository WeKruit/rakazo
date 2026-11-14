import { describe, expect, it } from "vitest";
import { gapsRecruiterRaised } from "./recruiting-raised-gaps.js";

describe("gapsRecruiterRaised", () => {
  // From a staging feedback round: two people turned down for no Spark/Kafka in prod, one for
  // years, and the next round's own notes said the same was not shown for most picks.
  const recruiter =
    "2 and 3 are off, both say they're not sure about spark/kafka in prod and i need that. also the tiktok one (sashank) doesn't show 6+ yrs. find more like the rest";

  it("names the picks whose own note says what the recruiter turned people down for", () => {
    const raised = gapsRecruiterRaised(
      {
        a: "production Spark and Kafka experience",
        b: "6+ years of experience",
        c: "compensation and three-day hybrid willingness",
      },
      recruiter,
    );
    expect(raised.get("a")).toEqual(["spark", "kafka"]);
    expect(raised.get("b")).toEqual(["6+", "years"]);
    expect(raised.has("c")).toBe(false);
  });

  it("finds nothing in words every note and request share", () => {
    expect(
      gapsRecruiterRaised(
        { a: "specific production work not shown" },
        "rest look good, find more like them",
      ).size,
    ).toBe(0);
    expect(gapsRecruiterRaised(undefined, recruiter).size).toBe(0);
  });
});
