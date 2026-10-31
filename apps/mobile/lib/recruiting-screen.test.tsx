// @vitest-environment jsdom
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { view: "sequence", role: "all" },
  push: vi.fn(),
  setParams: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push, setParams: mocks.setParams }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (create: () => unknown) => create() }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ActivityIndicator: () => createElement("span", { role: "status" }, "Loading"),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));

import RecruitingScreen from "../app/recruiting";

const roles = [
  { id: "role-id", title: "Role", groupId: "group", threadId: "thread", stage: "outreach" },
];
const correspondence = {
  roleId: "role-id",
  status: "ready" as const,
  checkedAt: null,
  connectionChanged: false,
  connections: [{ name: "Calendar", status: "configured" as const, checkIssue: null }],
  emails: [],
  events: [],
  contacts: [],
  partial: false,
  nextCursor: null,
};
afterEach(() => vi.clearAllMocks());
async function screen(data: RecruitingAccountViewOutput, view = "sequence") {
  mocks.params = { view, role: "all" };
  mocks.rpc.mockResolvedValue(data);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<RecruitingScreen />));
  return { host, close: () => act(async () => root.unmount()) };
}
it("uses the account read and shows campaign counts, enrolled people and saved contact emails", async () => {
  const { host, close } = await screen({
    roles,
    nextCursor: null,
    items: [
      {
        roleId: "role-id",
        campaigns: [
          {
            status: "ready",
            serverId: "mail",
            campaign: {
              id: "campaign",
              name: "Role sequence",
              eaccount: null,
              status: 1,
              stopOnReply: true,
            },
            stats: { sent: 4, opened: 3, replied: 2 },
            leads: [
              {
                email: "enrolled@example.test",
                candidateKey: null,
                status: 1,
                interestStatus: null,
              },
            ],
          },
        ],
        correspondence: {
          ...correspondence,
          contacts: [
            {
              candidateKey: "contact",
              linkedinUrl: "https://example.test/profile",
              source: "Saved contact",
              checkedAt: "2026-10-30T12:00:00Z",
              emails: [{ address: "saved@example.test", status: null }],
              phones: [],
            },
          ],
        },
      },
    ],
  });
  try {
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("recruiting/accountView", {
      view: "sequence",
      cursor: undefined,
      limit: 20,
    });
    for (const text of [
      "Role sequence",
      "Sent 4",
      "Opened 3",
      "Replied 2",
      "enrolled@example.test",
      "saved@example.test",
    ])
      expect(host.textContent).toContain(text);
  } finally {
    await close();
  }
});
it("does not label an unavailable campaign as empty", async () => {
  const { host, close } = await screen({
    roles,
    nextCursor: null,
    items: [
      {
        roleId: "role-id",
        campaign: { status: "unavailable", serverId: "mail", campaign: null, leads: [] },
        campaigns: [],
      },
    ],
  });
  try {
    expect(host.textContent).toContain("Could not read this campaign.");
    expect(host.textContent).not.toContain("No campaign yet.");
  } finally {
    await close();
  }
});
it.each(["failed", "unsupported", "not_checked"] as const)(
  "keeps calendar %s distinct from no interviews or a missing connection",
  async (status) => {
    const { host, close } = await screen(
      {
        roles,
        nextCursor: null,
        items: [{ roleId: "role-id", correspondence: { ...correspondence, status } }],
      },
      "interview",
    );
    try {
      expect(host.textContent).toContain("Could not load calendar records.");
      expect(host.textContent).not.toContain("No interviews yet.");
      expect(host.textContent).not.toContain("Connect calendar");
    } finally {
      await close();
    }
  },
);
it("opens native integrations when no calendar is connected", async () => {
  const { host, close } = await screen(
    {
      roles,
      nextCursor: null,
      items: [
        {
          roleId: "role-id",
          correspondence: {
            ...correspondence,
            connections: [{ name: "Calendar", status: "needs_connection", checkIssue: null }],
          },
        },
      ],
    },
    "interview",
  );
  try {
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Connect calendar")!
        .click(),
    );
    expect(mocks.push).toHaveBeenCalledWith("/integrations");
    expect(host.textContent).not.toContain("No interviews yet.");
  } finally {
    await close();
  }
});

it("continues the native interview agenda through the shared cursor without losing prior events", async () => {
  const event = {
    id: "first",
    kind: "event" as const,
    title: "First interview",
    start: "2026-10-30T14:00:00Z",
    end: "2026-10-30T15:00:00Z",
    timeZone: "UTC",
    attendees: [],
    status: "confirmed",
    location: null,
    url: null,
  };
  const { host, close } = await screen(
    {
      roles,
      nextCursor: null,
      items: [
        {
          roleId: "role-id",
          correspondence: {
            ...correspondence,
            events: [event],
            partial: true,
            nextCursor: "calendar-next",
          },
        },
      ],
    },
    "interview",
  );
  try {
    mocks.rpc.mockResolvedValueOnce({
      roles,
      nextCursor: null,
      items: [
        {
          roleId: "role-id",
          correspondence: {
            ...correspondence,
            events: [event, { ...event, id: "second", title: "Second interview" }],
          },
        },
      ],
    });
    expect(host.textContent).not.toContain("Could not load calendar records.");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith("recruiting/accountView", {
      view: "interview",
      roleId: "role-id",
      itemCursor: "calendar-next",
      limit: 20,
    });
    expect(host.textContent?.match(/First interview/g)).toHaveLength(1);
    expect(host.textContent).toContain("Second interview");
    expect(host.textContent).not.toContain("Load more");
  } finally {
    await close();
  }
});
