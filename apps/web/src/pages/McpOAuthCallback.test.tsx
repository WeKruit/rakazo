// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { McpOAuthCallbackPage } from "./McpOAuthCallback";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));

it("returns to WeKruit Headhunter after a cancelled authorization", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/oauth/callback?error_description=denied"]}>
        <McpOAuthCallbackPage />
      </MemoryRouter>,
    );
  });
  expect(host.querySelector("button")?.textContent).toBe("Return to WeKruit Headhunter");
  expect(host.textContent).not.toContain("Rakazo");
  await act(async () => root.unmount());
});
