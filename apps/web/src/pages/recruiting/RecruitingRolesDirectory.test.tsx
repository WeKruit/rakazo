// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
const accountView = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { accountView } } }));

import { RecruitingRolesDirectory } from "./RecruitingRolesDirectory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const role = (index: number) => ({
  id: `role-${index}`,
  title: `Role ${String(index).padStart(3, "0")}`,
  groupId: `group-${index}`,
  threadId: `thread-${index}`,
  stage: "intake",
});
const roles = Array.from({ length: 101 }, (_, index) => role(index));
const output = {
  roles,
  items: [],
  nextCursor: "a-paged-data-cursor-not-the-catalog",
} satisfies RecruitingAccountViewOutput;
beforeEach(() => {
  vi.clearAllMocks();
  accountView.mockResolvedValue(output);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
}
async function type(query: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("paginates the complete catalog and searches roles beyond both API item and local page boundaries", async () => {
  await act(async () =>
    root.render(<RecruitingRolesDirectory spaceId="space" onNavigate={vi.fn()} />),
  );
  await settle();
  expect(accountView).toHaveBeenCalledTimes(1);
  expect(accountView).toHaveBeenCalledWith({ view: "roles", limit: 1 });
  expect(container.querySelectorAll("li")).toHaveLength(50);
  expect(container.textContent).toContain("Role 000");
  expect(container.textContent).not.toContain("Role 100");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Next")!
      .click(),
  );
  expect(container.textContent).toContain("Role 050");
  await type("  ROLE 100  ");
  expect(container.querySelectorAll("li")).toHaveLength(1);
  expect(container.textContent).toContain("Role 100");
  expect(accountView).toHaveBeenCalledTimes(1);
  await type("not found");
  expect(container.textContent).toContain("No roles match your search.");
  await type("");
  expect(container.textContent).toContain("Role 000");
});
it("preserves browser modified-click behavior and opens exact group or bot conversations", async () => {
  accountView.mockResolvedValue({
    roles: [role(1), { ...role(2), groupId: null, botId: "bot-2" }],
    items: [],
    nextCursor: null,
  });
  const navigate = vi.fn();
  await act(async () =>
    root.render(<RecruitingRolesDirectory spaceId="space" onNavigate={navigate} />),
  );
  await settle();
  const links = container.querySelectorAll("a");
  expect(links[0]?.getAttribute("href")).toBe("/app/g/group-1?view=conversation");
  expect(links[1]?.getAttribute("href")).toBe("/app/bot-2?view=conversation");
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  act(() => links[0]!.dispatchEvent(modified));
  expect(modified.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  act(() => links[1]!.click());
  expect(navigate).toHaveBeenCalledWith("/app/bot-2?view=conversation");
});
it("does not issue an unscoped read, hides a failed catalog, and retries the owned read", async () => {
  await act(async () => root.render(<RecruitingRolesDirectory onNavigate={vi.fn()} />));
  await settle();
  expect(accountView).not.toHaveBeenCalled();
  accountView.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
  await act(async () =>
    root.render(<RecruitingRolesDirectory spaceId="space" onNavigate={vi.fn()} />),
  );
  await settle();
  expect(container.textContent).toContain("Could not load roles.");
  expect(container.querySelectorAll("li")).toHaveLength(0);
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry")!
      .click(),
  );
  await settle();
  expect(container.textContent).toContain("Role 000");
});
