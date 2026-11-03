import "../../lib/query.test-support";
// @vitest-environment jsdom
import type { RecruitingContact } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: { contacts: { list, facets: async () => ({ roles: [], statuses: [], tags: [] }) } },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { AllContacts } from "./AllContacts";

it("reveals secondary fields without refetching contacts and retains them when paging on the server", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const person: RecruitingContact = {
    personKey: "example",
    noteKey: "example",
    name: "Example Person",
    title: "Platform Engineer",
    company: null,
    location: "Example City",
    school: "Example University",
    savedProfile: null,
    profileImageUrl: null,
    companyLogoUrl: null,
    companyWebsiteUrl: null,
    schoolLogoUrl: null,
    schoolWebsiteUrl: null,
    linkedinUrl: null,
    email: null,
    status: "saved",
    roles: [],
    tags: [],
    addedAt: null,
    lastContactedAt: null,
    lastRepliedAt: null,
  };
  list.mockResolvedValue({ items: [person], total: 51, nextCursor: "50" });
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AllContacts accountKey="test" groups={[]} refreshSignal={0} />
        </MemoryRouter>,
      ),
    );
    await settle();
    const headers = () => [...view.querySelectorAll("thead th")].map((item) => item.textContent);
    expect(headers()).toEqual([
      "",
      "Name",
      "Profiles",
      "Roles",
      "Current role",
      "Company",
      "Status",
      "Last contacted",
    ]);
    const display = [...view.querySelectorAll("button")].find(
      (item) => item.textContent === "Display columns",
    )!;
    await act(async () => display.click());
    const location = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent === "Location",
    )!;
    expect(location).toBeDefined();
    await act(async () => location.click());
    expect(headers()).toContain("Location");
    expect(view.querySelector("tbody")?.textContent).toContain("Example City");
    expect(list).toHaveBeenCalledTimes(1);
    // Close the menu before following the normal page control.
    await act(async () => display.click());
    await act(async () =>
      view.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click(),
    );
    await settle();
    expect(list).toHaveBeenLastCalledWith({ filters: {}, limit: 50, cursor: "50" });
    expect(headers()).toContain("Location");
  } finally {
    await act(async () => root.unmount());
    view.remove();
    vi.unstubAllGlobals();
  }
});
