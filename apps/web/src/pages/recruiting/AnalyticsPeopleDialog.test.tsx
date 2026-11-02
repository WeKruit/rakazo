// @vitest-environment jsdom
import type { RecruitingAnalyticsPeopleOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { AnalyticsPeopleDialog } from "./AnalyticsPeopleDialog";

const person = (key: string, name: string) => ({
  key,
  name,
  email: null,
  linkedinUrl: null,
  contactedAt: "2026-10-31T10:00:00.000Z",
  repliedAt: null,
  shortlistedAt: null,
  roles: [{ id: "role-a", title: "Engineer" }],
});
const page = (
  items: RecruitingAnalyticsPeopleOutput["items"],
  nextCursor: string | null = null,
): RecruitingAnalyticsPeopleOutput => ({ items, nextCursor, total: 2, coverage: "partial" });
const input = {
  since: "2026-10-01T00:00:00.000Z",
  until: "2026-11-01T00:00:00.000Z",
  metric: "contacted" as const,
  roleId: "role-a",
};

it("appends bounded cohort pages once and drops a late response after changing role", async () => {
  let resolveOld!: (value: RecruitingAnalyticsPeopleOutput) => void;
  const load = vi
    .fn()
    .mockResolvedValueOnce(page([person("a", "Alice")], "next"))
    .mockResolvedValueOnce(page([person("a", "Alice"), person("b", "Bob")]))
    .mockImplementationOnce(
      () =>
        new Promise<RecruitingAnalyticsPeopleOutput>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(page([person("c", "Carol")]));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<AnalyticsPeopleDialog input={input} load={load} onClose={() => {}} />),
    );
    expect(document.body.textContent).toContain("Alice");
    const more = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more",
    )!;
    await act(async () => more.click());
    expect(load.mock.calls[1]?.[0]).toMatchObject({ roleId: "role-a", cursor: "next", limit: 50 });
    expect(
      [...document.querySelectorAll("strong")].filter((item) => item.textContent === "Alice"),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain("Bob");
    await act(async () =>
      root.render(
        <AnalyticsPeopleDialog
          input={{ ...input, roleId: "old-role" }}
          load={load}
          onClose={() => {}}
        />,
      ),
    );
    expect(document.body.textContent).not.toContain("Alice");
    await act(async () =>
      root.render(
        <AnalyticsPeopleDialog
          input={{ ...input, roleId: "new-role" }}
          load={load}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => resolveOld(page([person("private", "Old private result")])));
    expect(document.body.textContent).toContain("Carol");
    expect(document.body.textContent).not.toContain("Old private result");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
