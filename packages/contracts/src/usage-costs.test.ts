import { describe, expect, it } from "vitest";
import { UsageCostsSchema } from "./domain.js";

describe("customer credit contract", () => {
  it("does not serialize token, vendor or dollar details", () => {
    const value = UsageCostsSchema.parse({
      total: { credits: 1.4, pending: false, tokens: 130, calls: 1, estimatedUsd: 0.007 },
      month: { credits: 1.4, pending: false, tokens: 130, calls: 1 },
      days: [],
      roles: [],
      canViewInternalCosts: false,
      services: [
        {
          service: "vendor/model",
          unit: "tokens",
          quantity: 130,
          estimatedUsd: 0.007,
          priced: true,
        },
      ],
      accounts: [],
    });
    expect(value).toEqual({
      total: { credits: 1.4, pending: false },
      month: { credits: 1.4, pending: false },
      days: [],
      roles: [],
      canViewInternalCosts: false,
    });
  });
});
