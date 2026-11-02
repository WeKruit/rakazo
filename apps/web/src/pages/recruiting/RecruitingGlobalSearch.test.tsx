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
  const options = { signal: expect.any(AbortSignal) };
  expect(calls.contacts).toHaveBeenCalledWith(
    {
      filters: { query: "Engineer" },
      sort: "name",
      limit: 8,
    },
    options,
  );
  expect(calls.mail).toHaveBeenCalledWith(
    { spaceId: "space-1", query: "Engineer", limit: 8 },
    options,
  );
  expect(calls.targets).toHaveBeenCalledWith({ q: "Engineer" }, options);
  expect(container.textContent).toContain("Avery");
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Engineer")!
      .click(),
  );
  expect(navigate).toHaveBeenCalledWith("/app/g/group-1?view=conversation");
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
  expect(container.textContent).not.toContain("Searching…");
  expect(container.textContent).not.toContain("No results");
  expect(
    recruitingTargetHref({ ...role, kind: "sequence", campaignId: "c&1", serverId: "source-1" }),
  ).toBe("/app/g/group-1?view=sequence&campaign=c%261&campaignServer=source-1");
  expect(recruitingTargetHref({ ...role, kind: "sequence", campaignId: "mirror-1" })).toBe(
    "/app/g/group-1?view=sequence&campaign=mirror-1",
  );
  const params = new URL(recruitingContactHref(person, "A&B"), "https://example.test").searchParams;
  expect(params.get("detail")).toBe("contact.person-1");
  expect(params.get("query")).toBe("A&B");
});

it("shows completed contacts while targets and mail remain pending and discards obsolete results", async () => {
  let targets!: (value: unknown) => void;
  let mail!: (value: unknown) => void;
  calls.targets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        targets = resolve;
      }),
  );
  calls.mail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        mail = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <RecruitingGlobalSearch open onOpenChange={vi.fn()} spaceId="space-1" onNavigate={vi.fn()} />,
    ),
  );
  await type("old");
  expect(container.textContent).toContain("Avery");
  expect(container.textContent).toContain("Searching…");
  expect(container.textContent).not.toContain("No results");
  const oldSignal = calls.targets.mock.calls[0]![1].signal as AbortSignal;
  calls.targets.mockResolvedValueOnce({ items: [] });
  calls.contacts.mockResolvedValueOnce({ items: [], nextCursor: null });
  calls.mail.mockResolvedValueOnce({ items: [], nextCursor: null });
  await type("new");
  expect(oldSignal.aborted).toBe(true);
  expect(container.textContent).toContain("No results");
  await act(async () => {
    targets({ items: [{ ...role, title: "Stale role" }] });
    mail({ items: [{ key: "stale", roleId: "role-1", email: { subject: "Stale mail" } }] });
  });
  expect(container.textContent).not.toContain("Stale");
  expect(container.textContent).toContain("No results");
});

it("waits for every scope before displaying an empty result and cancels on space changes", async () => {
  let targets!: (value: unknown) => void;
  calls.contacts.mockResolvedValueOnce({ items: [], nextCursor: null });
  calls.targets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        targets = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <RecruitingGlobalSearch open onOpenChange={vi.fn()} spaceId="space-1" onNavigate={vi.fn()} />,
    ),
  );
  await type("test");
  expect(container.textContent).toContain("Searching…");
  expect(container.textContent).not.toContain("No results");
  const oldSignal = calls.targets.mock.calls[0]![1].signal as AbortSignal;
  await act(async () =>
    root.render(
      <RecruitingGlobalSearch open onOpenChange={vi.fn()} spaceId="space-2" onNavigate={vi.fn()} />,
    ),
  );
  expect(oldSignal.aborted).toBe(true);
  await act(async () => targets({ items: [{ ...role, title: "Other space" }] }));
  expect(container.textContent).not.toContain("Other space");
  expect(container.textContent).not.toContain("Avery");
});
