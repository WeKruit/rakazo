// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  connections: vi.fn(),
  capabilities: vi.fn(),
  search: vi.fn(),
  servers: vi.fn(),
  assignments: vi.fn(),
  connect: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    connections: { catalog: api.catalog, list: api.connections },
    capabilities: { list: api.capabilities, catalogSearch: api.search },
    mcp: {
      servers: { list: api.servers },
      assignments: { all: api.assignments, approve: api.approve },
    },
  },
}));
vi.mock("../lib/mcp-connect", () => ({ connectMcpOauth: api.connect }));
vi.mock("../components/integrations/IntegrationSetup", () => ({
  IntegrationSetup: ({ productView, botId }: { productView?: boolean; botId?: string }) => (
    <div data-testid="app-search" data-product-view={productView} data-bot-id={botId} />
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: () => null,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...Object.fromEntries(
      [
        "Card",
        "CardContent",
        "CardHeader",
        "CardTitle",
        "Dialog",
        "DialogContent",
        "DialogHeader",
        "DialogTitle",
      ].map((name) => [name, Box]),
    ),
    DialogClose: ({ render }: { render: ReactNode }) => render,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { PluginsOverlay } from "./PluginsOverlay";

const server = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  enabled: true,
  hasSecret: false,
  platformCredentialConfigured: false,
  oauthStatus: "none",
  endpoint: "https://private-service.example.test/mcp",
  ...extra,
});
const assignment = (serverId: string, botId = "main", allowedTools = ["read_saved"]) => ({
  serverId,
  botId,
  allowAllTools: false,
  allowedTools,
});
let close: (() => Promise<void>) | undefined;
let rerender: ((botId?: string) => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.catalog.mockResolvedValue([]);
  api.connections.mockResolvedValue([]);
  api.capabilities.mockResolvedValue([]);
  api.search.mockResolvedValue({ enabled: false, results: [] });
  api.servers.mockResolvedValue([]);
  api.assignments.mockResolvedValue([]);
});
afterEach(async () => {
  await close?.();
  close = undefined;
  rerender = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function open(activeBotId: string | undefined = "main", developerView = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  close = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  rerender = async (botId) => {
    await act(async () =>
      root.render(
        <PluginsOverlay
          activeBotId={botId}
          developerView={developerView}
          onClose={() => undefined}
        />,
      ),
    );
  };
  await act(async () =>
    root.render(
      <PluginsOverlay
        activeBotId={activeBotId}
        developerView={developerView}
        onClose={() => undefined}
      />,
    ),
  );
  return host;
}
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
}

it("shows assigned native services without a managed catalog or internal configuration", async () => {
  api.servers.mockResolvedValue([
    server("Research", { platformCredentialConfigured: true }),
    server("Calendar", { oauthStatus: "connected", hasSecret: true }),
    server("No access", { platformCredentialConfigured: true }),
    server("Other specialist", { platformCredentialConfigured: true }),
    server("Unassigned", { platformCredentialConfigured: true }),
  ]);
  api.assignments.mockResolvedValue([
    assignment("Research"),
    assignment("Calendar"),
    assignment("No access", "main", []),
    assignment("Other specialist", "sourcer"),
  ]);
  const host = await open();
  expect(host.textContent).toContain("Research");
  expect(host.textContent).toContain("Calendar");
  expect(host.querySelector('[data-service-id="Research"]')?.textContent).toContain("Configured");
  expect(host.querySelector('[data-service-id="No access"]')?.textContent).not.toContain(
    "Configured",
  );
  expect(host.textContent).not.toContain("Other specialist");
  expect(host.textContent).not.toContain("Unassigned");
  expect(host.textContent).not.toMatch(
    /plugin catalog|MCP|private-service|read_saved|Tool sources/,
  );
  expect(api.capabilities).not.toHaveBeenCalled();
  await act(async () => button(host, "Connect an app").click());
  expect(host.querySelector('[data-testid="app-search"]')?.getAttribute("data-product-view")).toBe(
    "true",
  );
  expect(host.querySelector('[data-testid="app-search"]')?.hasAttribute("data-bot-id")).toBe(false);
});

it("checks fresh native state after OAuth rather than treating its completion signal as success", async () => {
  api.servers.mockResolvedValue([server("Mailbox", { oauthStatus: "reconnect", hasSecret: true })]);
  api.assignments.mockResolvedValue([assignment("Mailbox")]);
  api.connect.mockResolvedValue("connected");
  const host = await open();
  await act(async () => button(host, "Reconnect").click());
  expect(api.connect).toHaveBeenCalledWith("Mailbox");
  expect(api.servers).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).toContain(
    "Needs connection",
  );
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  api.servers.mockResolvedValue([server("Mailbox", { oauthStatus: "connected", hasSecret: true })]);
  await act(async () => button(host, "Reconnect").click());
  expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).toContain("Configured");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps failed loads retryable and ignores a native OAuth completion after closing", async () => {
  api.servers.mockRejectedValueOnce(new Error("Services unavailable"));
  const host = await open();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Services unavailable");
  api.servers.mockResolvedValue([server("Mailbox")]);
  api.assignments.mockResolvedValue([assignment("Mailbox")]);
  await act(async () => button(host, "Retry").click());
  let finish!: (result: string) => void;
  api.connect.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button(host, "Connect").click());
  const reads = api.servers.mock.calls.length;
  await close?.();
  close = undefined;
  await act(async () => finish("connected"));
  expect(api.servers).toHaveBeenCalledTimes(reads);
});

it.each(["resolve", "reject"])(
  "ignores an earlier bot's retry %s while the new scope is still loading",
  async (outcome) => {
    api.servers.mockRejectedValueOnce(new Error("Initial failure"));
    const host = await open();
    let finishOld!: (rows: unknown[]) => void;
    let failOld!: (error: Error) => void;
    api.servers.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finishOld = resolve;
        failOld = reject;
      }),
    );
    await act(async () => button(host, "Retry").click());
    let finishCurrent!: (rows: unknown[]) => void;
    api.servers.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCurrent = resolve;
      }),
    );
    api.assignments.mockResolvedValue([assignment("Current research", "sourcer")]);
    await rerender?.("sourcer");
    await act(async () =>
      outcome === "resolve"
        ? finishOld([server("Old mailbox")])
        : failOld(new Error("Old retry failure")),
    );
    expect(host.textContent).toContain("Loading integrations…");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("Old mailbox");
    await act(async () =>
      finishCurrent([server("Current research", { platformCredentialConfigured: true })]),
    );
    expect(host.textContent).not.toContain("Loading integrations…");
    expect(host.querySelector('[data-service-id="Current research"]')?.textContent).toContain(
      "Configured",
    );
  },
);

it("shows all assigned services without a selected bot and discards OAuth from a prior bot scope", async () => {
  api.servers.mockResolvedValue([
    server("Mailbox"),
    server("Research", { platformCredentialConfigured: true }),
  ]);
  api.assignments.mockResolvedValue([assignment("Mailbox"), assignment("Research", "sourcer")]);
  const host = await open();
  let finish!: (result: string) => void;
  api.connect.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button(host, "Connect").click());
  await rerender?.("sourcer");
  expect(host.textContent).toContain("Research");
  expect(host.textContent).not.toContain("Mailbox");
  const reads = api.servers.mock.calls.length;
  await act(async () => finish("connected"));
  expect(api.servers).toHaveBeenCalledTimes(reads);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await rerender?.(undefined);
  expect(host.textContent).toContain("Research");
  expect(host.textContent).toContain("Mailbox");
  expect(button(host, "Connect").disabled).toBe(false);
});

it("retains native management only in developer view", async () => {
  const host = await open("main", true);
  expect(host.querySelector('[data-testid="integrations-advanced"]')).not.toBeNull();
  expect(host.textContent).toContain("Browse MCP servers");
  expect(api.capabilities).toHaveBeenCalledTimes(1);
});

it("reuses the public app search without presenting server configuration to ordinary users", async () => {
  const { IntegrationSetup } = await vi.importActual<
    typeof import("../components/integrations/IntegrationSetup")
  >("../components/integrations/IntegrationSetup");
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<IntegrationSetup productView />));
    expect(host.querySelector('input[aria-label="Search apps"]')).not.toBeNull();
    expect(button(host, "Search")).toBeDefined();
    expect(host.querySelector('input[aria-label="Server URL"]')).toBeNull();
    expect(host.textContent).not.toMatch(/MCP|integrations\.sh|Client ID|API key/);
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.search).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not grant access or notify a closed parent after public app OAuth finishes late", async () => {
  const { IntegrationSetup } = await vi.importActual<
    typeof import("../components/integrations/IntegrationSetup")
  >("../components/integrations/IntegrationSetup");
  const endpoint = "https://mailbox.example.test/mcp";
  api.servers.mockResolvedValue([server("Mailbox", { endpoint })]);
  api.search.mockResolvedValue({
    enabled: true,
    results: [{ name: "Mailbox", surfaces: [{ kind: "mcp", source: endpoint }] }],
  });
  let finish!: (result: string) => void;
  api.connect.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const connected = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  let closed = false;
  try {
    await act(async () =>
      root.render(<IntegrationSetup botId="main" onServerConnected={connected} />),
    );
    await act(async () => {
      const input = host.querySelector('input[aria-label="Search apps"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Mailbox",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.search).toHaveBeenCalledWith({ query: "Mailbox", usePublicCatalog: true });
    await act(async () => button(host, "Connect").click());
    expect(api.connect).toHaveBeenCalledWith("Mailbox");
    await act(async () => root.unmount());
    closed = true;
    await act(async () => finish("connected"));
    expect(api.approve).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  } finally {
    if (!closed) await act(async () => root.unmount());
  }
});
