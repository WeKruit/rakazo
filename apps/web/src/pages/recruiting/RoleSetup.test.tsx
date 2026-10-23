// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { RoleSetupStatus } from "./RoleSetup";
import { RoleSetup } from "./RoleSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

async function mount(status: RoleSetupStatus | undefined, handlers = {}) {
  const props = { onAsk: vi.fn(), onConnect: vi.fn(), onBind: vi.fn(async () => {}), ...handlers };
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RoleSetup status={status} {...props} />));
  return props;
}
const button = (label: string) =>
  [...container!.querySelectorAll("button")].find((item) => item.textContent === label)!;

it("shows nothing for a ready role", async () => {
  await mount({ ready: true, items: [{ key: "campaign", state: "ready" }] });
  expect(container!.textContent).toBe("");
});

it("offers each missing step's own fix", async () => {
  const props = await mount({
    ready: false,
    items: [
      {
        key: "campaign",
        state: "missing",
        action: { kind: "ask_agent", prompt: "为这个岗位准备 outreach campaign" },
      },
      { key: "sender", state: "ready", label: "recruiter@example.com" },
      {
        key: "crm",
        state: "missing",
        action: { kind: "bind", options: [{ orgId: "org-1", roleLabel: "Data Infra" }] },
      },
      { key: "leads", state: "unavailable", action: { kind: "connect", serverId: "instantly" } },
    ],
  });
  expect(container!.textContent).toContain("recruiter@example.com");
  await act(async () => button("Set up").click());
  expect(props.onAsk).toHaveBeenCalledWith("为这个岗位准备 outreach campaign");
  await act(async () => button("Link Data Infra").click());
  expect(props.onBind).toHaveBeenCalledWith({ orgId: "org-1", roleLabel: "Data Infra" });
  await act(async () => button("Connect").click());
  expect(props.onConnect).toHaveBeenCalledWith("instantly");
});
