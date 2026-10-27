// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createRecruitingReadCache } from "../../lib/recruiting-read-cache";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
    i18n: { locale: "en" },
  }),
}));

const crmData = vi.fn();
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { crmData: (input: unknown) => crmData(input) } },
}));

import { RecruitingNavigation } from "./RecruitingNavigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("distinguishes duplicate role titles by creation time without showing internal identifiers", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const group = (id: string, name: string, createdAt: string): Group => ({
    id,
    name,
    createdAt,
    updatedAt: createdAt,
    spaceId: "space-test",
    threadId: `thread-${id}`,
    members: [],
    pinned: false,
    sectionId: null,
    archivedAt: null,
    preview: "",
    unread: false,
  });
  const groups = [
    group("one", "Engineer", "2026-01-01T10:00:00Z"),
    group("two", "Engineer", "2026-01-02T10:00:00Z"),
    group("three", "Designer", "2026-01-03T10:00:00Z"),
  ];
  try {
    act(() =>
      root.render(
        <RecruitingNavigation
          groups={groups}
          archivedGroups={[]}
          archivedOpen={false}
          query=""
          canOpenDashboard
          canCreateRole
          onQueryChange={vi.fn()}
          view="results"
          onView={vi.fn()}
          onCollapse={vi.fn()}
          onOpenRole={vi.fn()}
          onNewRole={vi.fn()}
          canCreateRoleFrom={() => true}
          onNewRoleFrom={vi.fn()}
          onRoleMenu={vi.fn()}
          onToggleArchived={vi.fn()}
          onRestoreRole={vi.fn()}
        />,
      ),
    );
    const times = [...container.querySelectorAll("time")];
    expect(times.map((item) => item.dateTime)).toEqual(
      groups.slice(0, 2).map((item) => item.createdAt),
    );
    expect(container.textContent).not.toContain("thread-one");
    expect(container.textContent).not.toContain("space-test");
  } finally {
    act(() => root.unmount());
  }
});

it("lists saved sequences without a role, in business wording, and hides them when the read fails", async () => {
  const source = { serverId: "server-1", serverRevision: 1, name: "CRM" };
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const checkedAt = "2026-10-24T00:00:00.000Z";
  crmData.mockImplementation(async (input: { operation: string }) => {
    if (input.operation === "memberships")
      return {
        operation: "memberships",
        checkedAt,
        sources: [
          {
            ...source,
            status: "ready",
            memberships: [{ organizationId, name: "Org", role: "owner" }],
          },
        ],
      };
    if (input.operation === "roles")
      return { operation: "roles", source: { ...source, organizationId }, checkedAt, items: [] };
    if (input.operation === "unassignedSequences")
      return {
        operation: "unassignedSequences",
        source: { ...source, organizationId },
        checkedAt,
        items: [
          {
            id: "sequence-1",
            name: "Spring outreach",
            status: "paused",
            people: 12,
            opened: 7,
            replied: 3,
            lastContactAt: checkedAt,
            syncedAt: checkedAt,
          },
        ],
      };
    throw new Error(`unexpected ${input.operation}`);
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <RecruitingNavigation
        crmContext={{
          target: { groupId: "group-1" } as never,
          scope: "scope",
          cache: createRecruitingReadCache(),
        }}
        groups={[]}
        archivedGroups={[]}
        archivedOpen={false}
        query=""
        canOpenDashboard
        canCreateRole
        onQueryChange={vi.fn()}
        view="results"
        onView={vi.fn()}
        onCollapse={vi.fn()}
        onOpenRole={vi.fn()}
        onNewRole={vi.fn()}
        canCreateRoleFrom={() => true}
        onNewRoleFrom={vi.fn()}
        onRoleMenu={vi.fn()}
        onToggleArchived={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );
  try {
    await act(async () => render());
    await act(async () => {});
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Sequences without a role"),
    );
    expect(toggle?.textContent).toBe("Sequences without a role1");
    await act(async () => toggle!.click());
    expect(container.textContent).toContain("Spring outreach");
    expect(container.textContent).toContain("Paused · 12 people · Replied 3");
    expect(container.textContent).not.toContain("sequence-1");
  } finally {
    act(() => root.unmount());
  }
});
