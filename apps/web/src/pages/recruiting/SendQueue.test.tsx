import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SendQueue } from "./SendQueue";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

const lead = (name: string, contactedAt: string | null, status = 1) => ({
  candidateKey: null,
  email: `${name.toLowerCase()}@x.test`,
  status,
  interestStatus: null,
  name,
  contactedAt,
});
const read = (status: number, extra: Partial<RecruitingRoleCampaign> = {}) =>
  ({
    status: "ready",
    serverId: "s1",
    campaign: { id: "c1", name: "Role", eaccount: null, status, stopOnReply: true },
    leads: [
      lead("Nicholas", null),
      lead("Weijie", null),
      lead("Ada", "2026-11-12T15:00:00.000Z"),
      lead("Bo", null, -1),
    ],
    ...extra,
  }) as RecruitingRoleCampaign;

it("shows who waits for their first email, when it goes out, and offers to send now", () => {
  const html = renderToStaticMarkup(
    <SendQueue
      campaign={read(1, { queuedFirstEmail: "Fri 09:00 America/Chicago" })}
      onAskChat={() => {}}
    />,
  );
  expect(html).toContain("2 waiting for their first email · goes out Fri 09:00 America/Chicago");
  expect(html).toContain("Nicholas, Weijie · 1 emailed · 1 bounced");
  expect(html).toContain("Send now");
});

it("says a paused campaign holds people back and offers to resume", () => {
  const html = renderToStaticMarkup(<SendQueue campaign={read(2)} onAskChat={() => {}} />);
  expect(html).toContain("Sending is paused · 2 not emailed yet");
  expect(html).toContain("Resume sending");
});

it("offers to send now while people wait behind the gap between emails", () => {
  const html = renderToStaticMarkup(
    <SendQueue campaign={read(1, { queuedFirstEmail: "now" })} onAskChat={() => {}} />,
  );
  expect(html).toContain("2 waiting for their first email<");
  expect(html).toContain("Send now");
});

it("stays out of the way when nothing waits or contact times are unknown", () => {
  const done = read(1);
  done.leads = done.leads.filter((entry) => entry.contactedAt);
  expect(renderToStaticMarkup(<SendQueue campaign={done} />)).toBe("");
  const unknown = read(1);
  unknown.leads = unknown.leads.map(({ contactedAt: _, ...rest }) => rest);
  expect(renderToStaticMarkup(<SendQueue campaign={unknown} />)).toBe("");
});
