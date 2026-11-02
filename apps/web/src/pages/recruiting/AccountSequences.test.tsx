// @vitest-environment jsdom
import type { RecruitingAccountViewInput, RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createRecruitingReadCache, rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { AccountSequences, sequenceDestination } from "./AccountSequences";
import { RecruitingReadCacheContext } from "./shared";

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
it("renders one campaign page and its full saved totals before any later page is requested", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let release!: (page: RecruitingAccountViewOutput) => void;
  const later = new Promise<RecruitingAccountViewOutput>((resolve) => {
    release = resolve;
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      ...page("first", "25"),
      total: 61,
      sequenceSummary: {
        contacted: null,
        active: null,
        opened: 3,
        clicked: null,
        replied: 1,
        interested: null,
        sent: 4,
        partial: true,
      },
    })
    .mockReturnValueOnce(later);
  try {
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
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({
      view: "sequence",
      sequenceSummary: true,
      briefedOnly: true,
      limit: 25,
    });
    expect(host.textContent).toContain("Sequence first");
    expect(host.textContent).toContain("61 sequences");
    expect(host.textContent).not.toContain("Loading sequences");
    const opened = [...host.querySelectorAll("dt")].find((item) =>
      item.textContent?.startsWith("Opened"),
    );
    expect(opened?.nextElementSibling?.textContent).toContain("3");
    await act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Next")!.click(),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0]).toMatchObject({ limit: 25, cursor: "25" });
    expect(host.textContent).toContain("Loading sequences");
    release({ ...page("later", null), total: 61 });
    await act(async () => {});
    const second = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Sequence later",
    )!;
    expect(second.getAttribute("href")).toBe(
      "/app/g/group-later?view=sequence&campaign=campaign-later&campaignServer=source-later",
    );
    expect(host.textContent).not.toContain("Sequence first");
  } finally {
    await act(async () => root.unmount());
  }
});
it("renders one honest empty overview when there are no retained metrics", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const read = vi.fn().mockResolvedValue({ ...page("first", null), total: 1 });
  try {
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
    expect(host.textContent).toContain("No saved activity metrics are available");
    expect(host.querySelectorAll("dt")).toHaveLength(0);
    expect(host.textContent).not.toContain("Send timing");
    expect(host.textContent).toContain("Sequence first");
  } finally {
    await act(async () => root.unmount());
  }
});
it("sends role/status/sort and contact search to the server and resets the campaign page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const read = vi.fn().mockResolvedValue({ ...page("first", "25"), total: 61 });
  try {
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
    await act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Next")!.click(),
    );
    expect(read.mock.calls.at(-1)?.[0].cursor).toBe("25");
    const sort = host.querySelector<HTMLSelectElement>('select[aria-label="Sort sequences"]')!;
    await act(async () => {
      sort.value = "opened";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ sequenceSort: "opened" });
    expect(read.mock.calls.at(-1)?.[0]).not.toHaveProperty("cursor");
    const scope = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Sequence role filter"]',
    )!;
    await act(async () => {
      scope.value = "first";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ roleId: "first" });
  } finally {
    await act(async () => root.unmount());
  }
});
it("retains exact bot and group ownership in destinations", () => {
  expect(sequenceDestination({ ...role("a"), groupId: null, botId: "bot a" })).toBe(
    "/app/bot%20a?view=sequence",
  );
});

it.each(["current", "foreign-account", "stale-revision"])(
  "uses only a newer verified, exact-scope display observation: %s",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const cache = createRecruitingReadCache();
    const source = page("first", null);
    source.items[0]!.campaigns![0]!.sourceRevision = 1;
    source.items[0]!.campaigns![0]!.campaignObservedAt = "2030-01-01T00:00:00.000Z";
    source.sequencePendingObservations =
      mode === "current"
        ? [
            {
              roleId: "first",
              serverId: "source-first",
              campaignId: "campaign-first",
              sourceRevision: 1,
              observedAt: "2031-01-01T00:00:00.000Z",
            },
          ]
        : [];
    const scope = JSON.stringify([
      mode === "foreign-account" ? "other" : "owner",
      "space",
      "thread-first",
    ]);
    rememberRecruitingRead(
      cache,
      `${scope}:sequence-observation:${JSON.stringify(["first", "source-first", "campaign-first"])}`,
      {
        roleId: "first",
        sourceRevision: mode === "stale-revision" ? 2 : 1,
        observedAt: "2031-01-01T00:00:00.000Z",
        campaign: {
          ...source.items[0]!.campaigns![0]!.campaign!,
          name: "Verified paused name",
          status: 2,
        },
      },
    );
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <RecruitingReadCacheContext.Provider value={cache}>
              <AccountSequences
                accountKey={JSON.stringify(["owner", "space"])}
                refreshSignal={0}
                onOpenNavigation={() => {}}
                read={vi.fn().mockResolvedValue(source)}
              />
            </RecruitingReadCacheContext.Provider>
          </MemoryRouter>,
        ),
      );
      expect(host.textContent).toContain(
        mode === "current" ? "Verified paused name" : "Sequence first",
      );
      if (mode === "current")
        expect(host.querySelector("tbody tr")?.textContent).toContain("Paused");
      else expect(host.textContent).not.toContain("Verified paused name");
    } finally {
      await act(async () => root.unmount());
      cache.client.clear();
    }
  },
);

it.each(["active-filter", "renamed-search"])(
  "keeps verified changes without false filtered results while the saved read is pending: %s",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const host = document.createElement("div");
    const root = createRoot(host);
    const cache = createRecruitingReadCache();
    const marker = {
      roleId: "first",
      serverId: "source-first",
      campaignId: "campaign-first",
      sourceRevision: 1,
      observedAt: "2031-01-01T00:00:00.000Z",
    };
    rememberRecruitingRead(
      cache,
      `${JSON.stringify(["owner", "space", "thread-first"])}:sequence-observation:${JSON.stringify(["first", "source-first", "campaign-first"])}`,
      {
        roleId: "first",
        sourceRevision: 1,
        observedAt: marker.observedAt,
        campaign: {
          ...page("first", null).items[0]!.campaigns![0]!.campaign!,
          name: "Verified new name",
          status: 2,
        },
      },
    );
    let acknowledged = false;
    const read = vi.fn(async (input: RecruitingAccountViewInput) => {
      const response = page("first", null);
      const campaign = response.items[0]!.campaigns![0]!;
      campaign.sourceRevision = 1;
      campaign.campaignObservedAt = acknowledged ? marker.observedAt : "2030-01-01T00:00:00.000Z";
      campaign.campaign = {
        ...campaign.campaign!,
        name: acknowledged ? "Verified new name" : "Old name",
        status: acknowledged ? 2 : 1,
      };
      response.sequencePendingObservations = acknowledged ? [] : [marker];
      response.total = 1;
      if (
        (input.sequenceStatus !== undefined && campaign.campaign.status !== input.sequenceStatus) ||
        (input.sequenceQuery && !campaign.campaign.name.includes(input.sequenceQuery))
      ) {
        response.items = [];
        response.total = 0;
      }
      return response;
    });
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <RecruitingReadCacheContext.Provider value={cache}>
              <AccountSequences
                accountKey={JSON.stringify(["owner", "space"])}
                refreshSignal={0}
                onOpenNavigation={() => {}}
                read={read}
                initialQuery={mode === "renamed-search" ? "Verified new name" : ""}
              />
            </RecruitingReadCacheContext.Provider>
          </MemoryRouter>,
        ),
      );
      if (mode === "active-filter") {
        const status = host.querySelector<HTMLSelectElement>(
          'select[aria-label="Sequence status filter"]',
        )!;
        await act(async () => {
          status.value = "1";
          status.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
      } else expect(host.querySelector("tbody tr")?.textContent).toContain("Verified new name");
      expect(host.textContent).toContain("Updating saved sequence records…");
      expect(host.textContent).toContain("Verified new name");
      expect(host.textContent).not.toContain("No sequences match");
      expect(host.textContent).not.toContain("0 sequences");
      expect(host.textContent).not.toContain("1 sequences");
      expect(host.querySelectorAll("dt")).toHaveLength(0);
      acknowledged = true;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(host.textContent).not.toContain("Updating saved sequence records");
      expect(host.textContent).toContain(
        mode === "active-filter" ? "No sequences match" : "1 sequences",
      );
    } finally {
      await act(async () => root.unmount());
      cache.client.clear();
      vi.useRealTimers();
    }
  },
);
