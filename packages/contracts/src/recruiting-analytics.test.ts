import { expect, it } from "vitest";
import {
  RecruitingAnalyticsInputSchema,
  RecruitingAnalyticsOutputSchema,
} from "./recruiting-analytics.js";

it("requires an ordered explicit date window", () => {
  expect(
    RecruitingAnalyticsInputSchema.safeParse({
      since: "2026-11-01T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
    }).success,
  ).toBe(false);
  expect(
    RecruitingAnalyticsInputSchema.safeParse({
      since: "2026-10-01T00:00:00Z",
      until: "2026-11-01T00:00:00Z",
    }).success,
  ).toBe(true);
});
it("does not accept a fabricated rate or claim complete history", () => {
  const partial = {
    roles: [],
    trend: [],
    groups: [],
    observedShortlistedPeople: 0,
    shortlistDateUnknownPeople: 0,
    observedContactedPeople: null,
    observedRepliedPeople: null,
    firstContactedPeople: null,
    replyRate: null,
    coverage: "partial",
    sources: {
      storedCrmMessages: "unavailable",
      nativeCorrespondence: "not_included",
      importedCorrespondence: "not_included",
      firstSendHistory: "unknown",
      replyClassification: "unknown",
      identityResolution: "partial",
      shortlistHistory: "unknown",
    },
  };
  expect(RecruitingAnalyticsOutputSchema.safeParse(partial).success).toBe(true);
  expect(RecruitingAnalyticsOutputSchema.safeParse({ ...partial, replyRate: 0 }).success).toBe(
    false,
  );
  expect(
    RecruitingAnalyticsOutputSchema.safeParse({
      ...partial,
      coverage: "complete",
    }).success,
  ).toBe(false);
});
