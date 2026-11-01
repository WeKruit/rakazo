// @vitest-environment jsdom

import type { RecruitingContact, RecruitingSearchTarget } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((value, part, index) => `${value}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
const calls = vi.hoisted(() => ({ contacts: vi.fn(), targets: vi.fn(), mail: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: { contacts: { list: calls.contacts }, globalInbox: calls.mail },
    search: { recruitingTargets: calls.targets },
  },
}));
vi.mock("@rakazo/ui-web", () => ({
  CommandDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({ onValueChange, ...props }: { onValueChange: (value: string) => void }) => (
    <input {...props} onChange={(event) => onValueChange(event.target.value)} />
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: { children: ReactNode; heading: string }) => (
    <section aria-label={heading}>{children}</section>
  ),
  CommandItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import {
  RecruitingGlobalSearch,
  recruitingContactHref,
  recruitingTargetHref,
} from "./RecruitingGlobalSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const role: RecruitingSearchTarget = {
  kind: "role",
  title: "Engineer",
  roleTitle: "Engineer",
  roleId: "role-1",
  groupId: "group-1",
  botId: null,
  campaignId: null,
  serverId: null,
};
const person = {
  personKey: "person-1",
  name: "Avery",
  noteKey: "crm:person-1",
  roles: [],
  profileImageUrl: null,
} as unknown as RecruitingContact;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  calls.targets.mockResolvedValue({ items: [role] });
  calls.contacts.mockResolvedValue({ items: [person], nextCursor: null });
  calls.mail.mockResolvedValue({ items: [], nextCursor: null });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
async function type(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
  });
}
it("does not read until scoped, debounces all sources, and opens exact owned targets", async () => {
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <RecruitingGlobalSearch
        open
        onOpenChange={vi.fn()}
        spaceId="space-1"
        onNavigate={navigate}
      />,
    ),
  );
  expect(calls.contacts).not.toHaveBeenCalled();
  await type(" Engineer ");
  expect(calls.contacts).toHaveBeenCalledWith({
    filters: { query: "Engineer" },
    sort: "name",
    limit: 8,
  });
  expect(calls.mail).toHaveBeenCalledWith({ spaceId: "space-1", query: "Engineer", limit: 8 });
  expect(calls.targets).toHaveBeenCalledWith({ q: "Engineer" });
  expect(container.textContent).toContain("Avery");
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Engineer")!
      .click(),
  );
  expect(navigate).toHaveBeenCalledWith("/app/g/group-1?view=conversation&role=role-1");
});
it("ignores a previous search completing after the newer query and exposes partial failure", async () => {
  let finish!: (value: unknown) => void;
  calls.contacts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <RecruitingGlobalSearch open onOpenChange={vi.fn()} spaceId="space-1" onNavigate={vi.fn()} />,
    ),
  );
  await type("old");
  calls.mail.mockRejectedValueOnce(new Error("unavailable"));
  await type("new");
  expect(container.textContent).toContain("Some results could not be loaded.");
  expect(container.textContent).toContain("Avery");
  await act(async () => finish({ items: [{ ...person, name: "Stale" }], nextCursor: null }));
  expect(container.textContent).not.toContain("Stale");
});
it("has no unscoped requests and preserves campaign/source and contact keys in links", async () => {
  await act(async () =>
    root.render(<RecruitingGlobalSearch open onOpenChange={vi.fn()} onNavigate={vi.fn()} />),
  );
  await type("test");
  expect(calls.targets).not.toHaveBeenCalled();
  expect(
    recruitingTargetHref({ ...role, kind: "sequence", campaignId: "c&1", serverId: "source-1" }),
  ).toBe("/app/g/group-1?view=sequence&role=role-1&campaign=c%261&campaignServer=source-1");
  expect(recruitingTargetHref({ ...role, kind: "sequence", campaignId: "mirror-1" })).toBe(
    "/app/g/group-1?view=sequence&role=role-1&campaign=mirror-1",
  );
  const params = new URL(recruitingContactHref(person, "A&B"), "https://example.test").searchParams;
  expect(params.get("detail")).toBe("contact.person-1");
  expect(params.get("query")).toBe("A&B");
});
