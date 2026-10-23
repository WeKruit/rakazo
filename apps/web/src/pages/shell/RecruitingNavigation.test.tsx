// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
    i18n: { locale: "en" },
  }),
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
