// @vitest-environment jsdom
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSequences, sequenceDestination } from "./AccountSequences";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { accountView: vi.fn() } } }));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const role = (id: string) => ({
  id,
  title: `Role ${id}`,
  threadId: `thread-${id}`,
  groupId: `group-${id}`,
  stage: "outreach",
});
const page = (id: string, nextCursor: string | null): RecruitingAccountViewOutput => ({
  roles: [role(id)],
  items: [
    {
      roleId: id,
      campaigns: [
        {
          status: "ready",
          serverId: `source-${id}`,
          leadsComplete: false,
          leads: [
            { candidateKey: null, email: "person@example.test", status: 1, interestStatus: null },
          ],
          stats: { sent: 8, opened: id === "later" ? 7 : 3, replied: 1 },
          campaign: {
            id: `campaign-${id}`,
            name: `Sequence ${id}`,
            eaccount: null,
            status: 0,
            stopOnReply: true,
          },
        },
      ],
    },
  ],
  nextCursor,
});
it("renders the global overview, exhausts server role cursors, and routes exact later-page sequence identity", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const read = vi
    .fn()
    .mockResolvedValueOnce(page("first", "next-role"))
    .mockResolvedValueOnce(page("later", null));
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AccountSequences
          accountKey="account"
          refreshSignal={0}
          onOpenNavigation={() => {}}
          read={read}
        />
      </MemoryRouter>,
    ),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![0]).toMatchObject({
    view: "sequence",
    briefedOnly: true,
    cursor: "next-role",
  });
  expect(
    [...host.querySelectorAll("dt")].map((item) => item.textContent?.replace("—", "").trim()),
  ).toEqual(["Contacted", "Active", "Opened", "Clicked", "Replied", "Interested"]);
  const second = [...host.querySelectorAll("a")].find(
    (link) => link.textContent === "Sequence later",
  )!;
  expect(second.getAttribute("href")).toBe(
    "/app/g/group-later?view=sequence&campaign=campaign-later&campaignServer=source-later",
  );
  const active = [...host.querySelectorAll("dt")].find((item) =>
    item.textContent?.startsWith("Active"),
  );
  expect(active?.nextElementSibling?.textContent).toContain("—");
  const sort = host.querySelector<HTMLSelectElement>('select[aria-label="Sort sequences"]')!;
  await act(async () => {
    sort.value = "opened";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector("tbody tr")?.textContent).toContain("Sequence later");
  const range = host.querySelector<HTMLSelectElement>('select[aria-label="Sequence date range"]')!;
  await act(async () => {
    range.value = "30";
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const opened = [...host.querySelectorAll("dt")].find((item) =>
    item.textContent?.startsWith("Opened"),
  );
  expect(opened?.nextElementSibling?.textContent).toContain("—");
  expect(host.textContent).toContain("Date-filtered sequence metrics are not available");
  expect(host.textContent).toContain("2 sequences");
  expect(host.textContent).not.toContain("Loading all sequence pages");
  await act(async () => root.unmount());
});
it("does not publish complete totals after a later server page fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const read = vi
    .fn()
    .mockResolvedValueOnce(page("first", "next-role"))
    .mockRejectedValueOnce(new Error("Offline"));
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AccountSequences
          accountKey="account"
          refreshSignal={0}
          onOpenNavigation={() => {}}
          read={read}
        />
      </MemoryRouter>,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Results are incomplete");
  expect(host.textContent).toContain("1 sequences loaded");
  const opened = [...host.querySelectorAll("dt")].find((item) =>
    item.textContent?.startsWith("Opened"),
  );
  expect(opened?.nextElementSibling?.textContent).toContain("—");
  await act(async () => root.unmount());
});
it("retains exact bot and group ownership in destinations", () => {
  expect(sequenceDestination({ ...role("a"), groupId: null, botId: "bot a" })).toBe(
    "/app/bot%20a?view=sequence",
  );
});
