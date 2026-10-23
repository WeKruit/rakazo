// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContactsTab } from "./ContactsTab";

const source = vi.hoisted(() => ({ more: true, props: null as unknown }));
vi.mock("./useRoleCandidates", () => ({
  useRoleCandidates: (props: unknown) => {
    source.props = props;
    return {
      rows: [
        {
          key: "matching",
          name: "Matching",
          autumn: {
            roleId: "role-a",
            candidateKey: "a",
            shortlisted: true,
            shortlistedAt: "2026-10-20T12:00:00Z",
          },
        },
        {
          key: "old",
          name: "Old",
          autumn: { roleId: "role-a", shortlisted: true, shortlistedAt: "2026-10-18T12:00:00Z" },
        },
        {
          key: "foreign",
          name: "Foreign",
          autumn: { roleId: "role-b", shortlisted: true, shortlistedAt: "2026-10-20T12:00:00Z" },
        },
        { key: "crm", name: "CRM only", autumn: null },
      ],
      total: 4,
      crm: { status: "unbound" },
      crmRead: { loading: false, failed: false },
      more: { hasMore: source.more, loadMore: vi.fn() },
    };
  },
}));
vi.mock("./CandidateDirectory", () => ({
  CandidateDirectory: ({ rows, toolbar }: { rows: { name: string }[]; toolbar: ReactNode }) => (
    <div>
      {toolbar}
      {rows.map((row) => (
        <p key={row.name}>{row.name}</p>
      ))}
    </div>
  ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { correspondence: async () => ({ roleId: "role-a", contacts: [] }) } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, _1, other }: { value: number; _1: string; other: string }) =>
    (value === 1 ? _1 : other).replace("#", String(value)),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((result, part, i) => result + part + (values[i] ?? ""), ""),
  }),
}));

it("shows only the exact Autumn role/date subset and withholds totals until remaining pages load", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const clear = vi.fn();
  const render = () =>
    root.render(
      <ContactsTab
        roleId="role-a"
        spaceId="space"
        shortlistWeekFilter={{
          kind: "shortlisted-week",
          roleId: "role-a",
          from: "2026-10-19T00:00:00Z",
          before: "2026-10-26T00:00:00Z",
          observedThrough: "2026-10-23T00:00:00Z",
        }}
        onClearShortlistWeekFilter={clear}
        autumn={{
          items: [],
          loading: false,
          failed: false,
          retry: vi.fn(),
          total: 4,
          hasMore: source.more,
          loadMore: vi.fn(),
          sortByScore: false,
          includeCrm: true,
          ready: false,
          shortlistFailedKey: null,
          setShortlist: vi.fn(),
          openEvidence: vi.fn(),
        }}
      />,
    );
  try {
    await act(render);
    expect(source.props).toMatchObject({ autumn: { includeCrm: false } });
    expect(container.textContent).toContain("Matching");
    for (const name of ["Old", "Foreign", "CRM only", "1 candidate"])
      expect(container.textContent).not.toContain(name);
    source.more = false;
    await act(render);
    expect(container.textContent).toContain("1 candidate");
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Clear date filter")!
        .click(),
    );
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
