import { RecruitingCampaignDetailsSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { campaignObservedDetails } from "./recruiting-campaign-details.js";

it("preserves all observed schedules, sequences, steps and variants without weekday guesses", () => {
  const schedule = {
    name: "Morning",
    timing: { from: "09:00", to: "11:00" },
    timezone: "America/Chicago",
    days: { "1": true, "2": false },
  };
  const step = {
    type: "email",
    delay: 2,
    delay_unit: "days",
    variants: [
      { subject: "Hello", body: "First body" },
      { subject: "Alternative", body: "Second body" },
    ],
  };
  const output = campaignObservedDetails({
    campaign_schedule: { schedules: [schedule, { ...schedule, name: "Evening" }] },
    sequences: [{ steps: [step, { ...step, delay: 4 }] }, { steps: [step] }],
  });
  expect(RecruitingCampaignDetailsSchema.parse(output)).toEqual(output);
  expect(output.schedules?.map((s) => s?.name)).toEqual(["Morning", "Evening"]);
  expect(output.schedules?.[0]?.days).toEqual({ "1": true, "2": false });
  expect(output.sequences?.map((s) => s?.steps?.length)).toEqual([2, 1]);
  expect(output.sequences?.[0]?.steps?.[0]?.variants?.map((v) => v?.body)).toEqual([
    "First body",
    "Second body",
  ]);
});

it("keeps malformed entries in place and valid neighboring fields without fabricated defaults", () => {
  const output = campaignObservedDetails({
    campaign_schedule: { schedules: [false, { name: "Known", timing: [], days: { "1": "true" } }] },
    sequences: [
      null,
      {
        steps: [
          {
            type: "email",
            delay: -1,
            delay_unit: 3,
            variants: [7, { subject: "Known", body: false }],
          },
        ],
      },
    ],
  });
  expect(output.schedules).toEqual([
    null,
    { name: "Known", from: null, to: null, timezone: null, days: null },
  ]);
  expect(output.sequences?.[0]).toBeNull();
  expect(output.sequences?.[1]?.steps?.[0]).toEqual({
    type: "email",
    delay: null,
    delayUnit: null,
    variants: [null, { subject: "Known", body: null }],
  });
  expect(campaignObservedDetails({})).toEqual({ schedules: null, sequences: null });
  expect(campaignObservedDetails({ campaign_schedule: { schedules: [] }, sequences: [] })).toEqual({
    schedules: [],
    sequences: [],
  });
});
