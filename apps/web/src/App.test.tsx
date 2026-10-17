// @vitest-environment jsdom
import type { AppBootstrap } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type * as BootstrapApi from "./lib/bootstrap";
import type * as RpcApi from "./lib/rpc";

const capability = vi.hoisted(() => ({
  enabled: false,
  boardLoaded: vi.fn(),
  userId: "user-1",
  resetBootstrap: vi.fn(),
  bootstrap: vi.fn(),
  shellOwners: [] as Array<{ current: string; owner: string }>,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof BootstrapApi>();
  return {
    ...actual,
    getTicketBoardEnabled: () => capability.enabled,
    subscribeTicketBoardEnabled: () => () => {},
    invalidateInitialBootstrap: () => {
      capability.resetBootstrap();
      actual.invalidateInitialBootstrap();
    },
  };
});
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({
      isPending: false,
      data: { user: { id: capability.userId } },
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("./lib/remote-images-preference", () => ({
  getRemoteImagesEnabled: () => false,
  subscribeRemoteImages: () => () => {},
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof RpcApi>()),
  rpc: { bootstrap: capability.bootstrap },
}));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({
  ShellPage: () => {
    const current = `${capability.userId}:${window.localStorage.getItem("rakazo:space-id") ?? "primary"}`;
    const [owner] = useState(current);
    capability.shellOwners.push({ current, owner });
    return <div data-owner={owner}>Shell</div>;
  },
}));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});

it("recreates authenticated state during render when the account or selected space changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capability.enabled = false;
  capability.userId = "user-a";
  capability.shellOwners = [];
  capability.resetBootstrap.mockClear();
  window.localStorage.setItem("rakazo:space-id", "space-a");
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <MemoryRouter initialEntries={["/app/g/group-a"]}>
      <App />
    </MemoryRouter>
  );
  let resolveStale!: (bootstrap: AppBootstrap) => void;
  const staleResponse = new Promise<AppBootstrap>((resolve) => {
    resolveStale = resolve;
  });
  const oldBootstrap = { me: { ticketBoardEnabled: true } } as AppBootstrap;
  capability.bootstrap.mockImplementation(() => staleResponse);
  const actualBootstrap = await vi.importActual<typeof BootstrapApi>("./lib/bootstrap");
  let staleRequest: Promise<AppBootstrap> | undefined;
  try {
    await act(async () => root.render(render()));
    expect(
      container.firstElementChild?.querySelector("[data-owner]")?.getAttribute("data-owner"),
    ).toBe("user-a:space-a");
    staleRequest = actualBootstrap.takeInitialBootstrap();
    capability.userId = "user-b";
    await act(async () => root.render(render()));
    expect(container.querySelector("[data-owner]")?.getAttribute("data-owner")).toBe(
      "user-b:space-a",
    );
    resolveStale(oldBootstrap);
    await staleRequest;
    expect(actualBootstrap.getTicketBoardEnabled()).toBe(false);
    await act(async () => {
      window.localStorage.setItem("rakazo:space-id", "space-b");
      window.dispatchEvent(new StorageEvent("storage", { key: "rakazo:space-id" }));
    });
    expect(container.querySelector("[data-owner]")?.getAttribute("data-owner")).toBe(
      "user-b:space-b",
    );
    await act(async () => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(container.querySelector("[data-owner]")?.getAttribute("data-owner")).toBe(
      "user-b:primary",
    );
    expect(capability.shellOwners.every(({ current, owner }) => current === owner)).toBe(true);
    expect(capability.resetBootstrap).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    resolveStale(oldBootstrap);
    await staleRequest;
    window.localStorage.clear();
    capability.userId = "user-1";
    vi.unstubAllGlobals();
  }
});
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

it("loads the board chunk only after bootstrap enables the route", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <MemoryRouter initialEntries={["/app/board"]}>
      <App />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(render()));
    expect(container.textContent).toBe("Shell");
    expect(capability.boardLoaded).not.toHaveBeenCalled();
    capability.enabled = true;
    await act(async () => {
      root.render(render());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capability.boardLoaded).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Board page");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
