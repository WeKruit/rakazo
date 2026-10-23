import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CampaignObservedDetails } from "./CampaignObservedDetails";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

it("renders every observed entry, escapes provider HTML, and does not invent weekday names", () => {
  const html = renderToStaticMarkup(
    <CampaignObservedDetails
      details={{
        schedules: [
          {
            name: "Morning",
            from: "09:00",
            to: "11:00",
            timezone: "America/Chicago",
            days: { "1": true },
          },
          { name: "Evening", from: "17:00", to: "19:00", timezone: "Europe/London", days: null },
          null,
        ],
        sequences: [
          {
            steps: [
              {
                type: "email",
                delay: 2,
                delayUnit: "days",
                variants: [
                  { subject: "First", body: "<script>bad()</script>" },
                  { subject: "Alternate", body: "Second variant" },
                ],
              },
              null,
            ],
          },
          {
            steps: [
              {
                type: "email",
                delay: null,
                delayUnit: null,
                variants: [{ subject: "Third", body: "Another sequence" }],
              },
            ],
          },
        ],
      }}
    />,
  );
  for (const text of [
    "Morning",
    "Evening",
    "America/Chicago",
    "Europe/London",
    "First",
    "Alternate",
    "Third",
    "Second variant",
    "Another sequence",
    "Days unavailable",
    "Schedule unavailable",
    "Email step unavailable",
    "Delay unavailable",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("Monday");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

it("distinguishes missing observations from empty arrays", () => {
  expect(renderToStaticMarkup(<CampaignObservedDetails />)).toContain("Schedule unavailable");
  const empty = renderToStaticMarkup(
    <CampaignObservedDetails details={{ schedules: [], sequences: [] }} />,
  );
  expect(empty).toContain("No schedules returned");
  expect(empty).toContain("No sequences returned");
});
