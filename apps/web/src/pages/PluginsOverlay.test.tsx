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
  setup: vi.fn(),
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
  IntegrationSetup: (props: {
    productView?: boolean;
    botId?: string;
    onServerConnected?: (id: string) => void | Promise<void>;
  }) => {
    api.setup(props);
    return (
      <div
        data-testid="app-search"
        data-product-view={props.productView}
        data-bot-id={props.botId}
      />
    );
  },
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
async function open(
  activeBotId: string | undefined = "main",
  developerView = false,
  extra: Partial<ComponentProps<typeof PluginsOverlay>> = {},
) {
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
          {...extra}
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
        {...extra}
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
    server("Disabled", { enabled: false }),
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
  expect(host.querySelector('[data-service-id="Unassigned"]')?.textContent).toContain(
    "Not available to this assistant",
  );
  expect(host.querySelector('[data-service-id="Unassigned"] button')).toBeNull();
  expect(host.querySelector('[data-service-id="No access"] button')).toBeNull();
  expect(host.querySelector('[data-service-id="Disabled"] button')).toBeNull();
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

it("shows and explicitly connects an existing unassigned personal service without a public catalog entry", async () => {
  let authorized = false;
  let granted = false;
  api.servers.mockImplementation(async () => [
    server("Mailbox", {
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
      oauthStatus: authorized ? "connected" : "none",
      hasSecret: authorized,
    }),
  ]);
  api.assignments.mockImplementation(async () =>
    granted ? [assignment("Mailbox", "main", ["get_thread"])] : [],
  );
  api.connect.mockImplementation(async () => {
    authorized = true;
    return "connected";
  });
  api.approve.mockImplementation(async (input) => {
    granted = true;
    return { ...input, allowAllTools: false };
  });
  const host = await open("main", false, { coordinatorBotId: "main" });
  const tile = host.querySelector('[data-service-id="Mailbox"]');
  expect(tile).not.toBeNull();
  expect(tile?.textContent).toContain("Needs connection");
  await act(async () => button(host, "Connect").click());
  expect(api.connect).toHaveBeenCalledExactlyOnceWith("Mailbox");
  expect(api.approve).toHaveBeenCalledExactlyOnceWith({
    botId: "main",
    serverId: "Mailbox",
    allowedTools: ["get_message", "get_thread", "search_threads"],
  });
  expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).toContain("Configured");
  expect(api.search).not.toHaveBeenCalled();
});

it.each(["platform", "static"])(
  "connects an unassigned service using its existing %s credential without claiming OAuth completed",
  async (kind) => {
    let granted = false;
    api.servers.mockResolvedValue([
      server("App", {
        platformCredentialConfigured: kind === "platform",
        hasSecret: kind === "static",
      }),
    ]);
    api.assignments.mockImplementation(async () => (granted ? [assignment("App")] : []));
    api.connect.mockResolvedValue("authorization_not_requested");
    api.approve.mockImplementation(async (input) => {
      granted = true;
      return { ...input, allowAllTools: true, allowedTools: [] };
    });
    const host = await open("main", false, { coordinatorBotId: "main" });
    expect(host.querySelector('[data-service-id="App"]')?.textContent).toContain(
      "Needs connection",
    );
    await act(async () => button(host, "Connect").click());
    expect(api.approve).toHaveBeenCalledExactlyOnceWith({ botId: "main", serverId: "App" });
    expect(host.querySelector('[data-service-id="App"]')?.textContent).toContain("Configured");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

it("does not report a service connected when its assignment was revoked before the final read", async () => {
  let revoked = false;
  api.servers.mockResolvedValue([server("App", { oauthStatus: "connected" })]);
  api.assignments.mockImplementation(async () => (revoked ? [assignment("App", "main", [])] : []));
  api.connect.mockResolvedValue("already_connected");
  api.approve.mockImplementation(async (input) => {
    revoked = true;
    return { ...input, allowAllTools: true, allowedTools: [] };
  });
  const host = await open("main", false, { coordinatorBotId: "main" });
  await act(async () => button(host, "Connect").click());
  expect(api.approve).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-service-id="App"]')?.textContent).toContain(
    "Not available to this assistant",
  );
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
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
  expect(api.approve).not.toHaveBeenCalled();
});

it("keeps an unassigned service unconfigured when its account authorization fails", async () => {
  api.servers.mockResolvedValue([
    server("Mailbox", { endpoint: "https://gmailmcp.googleapis.com/mcp/v1" }),
  ]);
  api.connect.mockRejectedValue(new Error("Missing client configuration"));
  const host = await open("main", false, { coordinatorBotId: "main" });
  await act(async () => button(host, "Connect").click());
  expect(api.approve).not.toHaveBeenCalled();
  expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).toContain(
    "Needs connection",
  );
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it.each(["revoked", "other-assistant", "narrow"])(
  "does not grant over a %s assignment that appeared during account authorization",
  async (state) => {
    let authorized = false;
    api.servers.mockImplementation(async () => [
      server("Mailbox", { oauthStatus: authorized ? "connected" : "none" }),
    ]);
    api.assignments.mockImplementation(async () =>
      authorized
        ? [
            assignment(
              "Mailbox",
              state === "other-assistant" ? "other" : "main",
              state === "revoked" ? [] : ["get_thread"],
            ),
          ]
        : [],
    );
    api.connect.mockImplementation(async () => {
      authorized = true;
      return "connected";
    });
    const host = await open("main", false, { coordinatorBotId: "main" });
    await act(async () => button(host, "Connect").click());
    expect(api.approve).not.toHaveBeenCalled();
    if (state === "narrow") {
      expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).toContain(
        "Configured",
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } else {
      expect(host.querySelector('[data-service-id="Mailbox"]')?.textContent).not.toContain(
        "Configured",
      );
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    }
  },
);

it.each(["close", "switch"])(
  "does not assign an unassigned service after its authorization finishes following %s",
  async (change) => {
    api.servers.mockResolvedValue([server("Mailbox")]);
    let finish!: (result: string) => void;
    api.connect.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const host = await open("main", false, { coordinatorBotId: "main" });
    await act(async () => button(host, "Connect").click());
    if (change === "close") {
      await close?.();
      close = undefined;
    } else await rerender?.("other");
    await act(async () => finish("connected"));
    expect(api.approve).not.toHaveBeenCalled();
  },
);

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

it("does not show Added before the native connection assignment completes", async () => {
  const { IntegrationSetup } = await vi.importActual<
    typeof import("../components/integrations/IntegrationSetup")
  >("../components/integrations/IntegrationSetup");
  const endpoint = "https://mailbox.example.test/mcp";
  api.servers.mockResolvedValue([server("Mailbox", { endpoint, oauthStatus: "connected" })]);
  api.search.mockResolvedValue({
    enabled: true,
    results: [{ name: "Mailbox", surfaces: [{ kind: "mcp", source: endpoint }] }],
  });
  api.connect.mockResolvedValue("connected");
  let finish!: () => void;
  const assigned = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<IntegrationSetup productView onServerConnected={assigned} />),
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
    await act(async () => button(host, "Connect").click());
    expect(assigned).toHaveBeenCalledWith("Mailbox");
    expect(host.textContent).not.toContain("Added");
    await act(async () => finish());
    expect(host.textContent).toContain("Added");
  } finally {
    await act(async () => root.unmount());
  }
});

it("gives a personal Gmail connection narrow native access to the current coordinator and managed specialists only", async () => {
  api.servers.mockResolvedValue([
    server("Mailbox", {
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
      oauthStatus: "connected",
      hasSecret: true,
    }),
  ]);
  api.approve.mockImplementation(async (input) => ({ ...input, allowAllTools: false }));
  const host = await open(undefined, false, {
    coordinatorBotId: "legacy-main",
    recruitingBotIds: { outreach: "managed-outreach", scheduling: "managed-scheduling" },
  });
  await act(async () => button(host, "Connect an app").click());
  const setup = api.setup.mock.calls.at(-1)![0];
  expect(setup.onServerConnected).toBeTypeOf("function");
  await act(async () => setup.onServerConnected("Mailbox"));
  expect(api.approve.mock.calls.map(([input]) => [input.botId, input.allowedTools])).toEqual([
    ["legacy-main", ["get_message", "get_thread", "search_threads"]],
    [
      "managed-outreach",
      ["get_message", "get_thread", "search_threads", "list_drafts", "get_draft", "create_draft"],
    ],
    [
      "managed-scheduling",
      ["get_message", "get_thread", "search_threads", "list_drafts", "get_draft", "create_draft"],
    ],
  ]);
});

it.each([
  "https://calendarmcp.googleapis.com/mcp/v1",
  "https://mcp.cal.com/mcp?toolsets=bookings,availability",
])("keeps personal calendar %s writes on managed Scheduling only", async (endpoint) => {
  api.servers.mockResolvedValue([
    server("Calendar", { endpoint, oauthStatus: "connected", hasSecret: true }),
  ]);
  api.approve.mockImplementation(async (input) => ({ ...input, allowAllTools: false }));
  const host = await open(undefined, false, {
    coordinatorBotId: "main",
    recruitingBotIds: { outreach: "outreach", scheduling: "scheduling" },
  });
  await act(async () => button(host, "Connect an app").click());
  await act(async () => api.setup.mock.calls.at(-1)![0].onServerConnected("Calendar"));
  expect(api.approve.mock.calls.map(([input]) => input.botId)).toEqual(["main", "scheduling"]);
  const main = api.approve.mock.calls[0]![0].allowedTools as string[];
  const scheduling = api.approve.mock.calls[1]![0].allowedTools as string[];
  const write = endpoint.includes("calendarmcp") ? "create_event" : "create_booking";
  expect(main).not.toContain(write);
  expect(scheduling).toContain(write);
  expect(main).not.toContain("call_api_operation");
  expect(scheduling).not.toContain("call_api_operation");
});

it("reuses an explicit generic app Connect on the actual coordinator only", async () => {
  api.servers.mockResolvedValue([server("App", { endpoint: "https://generic.example.test/mcp" })]);
  api.approve.mockImplementation(async (input) => ({
    ...input,
    allowAllTools: true,
    allowedTools: [],
  }));
  const host = await open(undefined, false, {
    coordinatorBotId: "native-first",
    recruitingBotIds: { outreach: "outreach", scheduling: "scheduling" },
  });
  await act(async () => button(host, "Connect an app").click());
  await act(async () => api.setup.mock.calls.at(-1)![0].onServerConnected("App"));
  expect(api.approve).toHaveBeenCalledExactlyOnceWith({ botId: "native-first", serverId: "App" });
});

it.each(["disabled", "revoked", "unconfirmed", "no-coordinator"])(
  "does not report a product assignment for %s access",
  async (state) => {
    api.servers.mockResolvedValue([
      server("Mailbox", {
        endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
        enabled: state !== "disabled",
        oauthStatus: state === "unconfirmed" ? "reconnect" : "connected",
        hasSecret: true,
      }),
    ]);
    api.approve.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
    const host = await open(undefined, false, {
      coordinatorBotId: state === "no-coordinator" ? undefined : "main",
    });
    await act(async () => button(host, "Connect an app").click());
    await expect(api.setup.mock.calls.at(-1)![0].onServerConnected("Mailbox")).rejects.toThrow();
    expect(api.approve).toHaveBeenCalledTimes(state === "revoked" ? 1 : 0);
  },
);

it("does not assign an old scope when its server read completes after the conversation changes", async () => {
  api.servers.mockResolvedValue([server("App")]);
  const host = await open("main", false, { coordinatorBotId: "main" });
  await act(async () => button(host, "Connect an app").click());
  const connected = api.setup.mock.calls.at(-1)![0].onServerConnected;
  let finish!: (rows: unknown[]) => void;
  api.servers.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = connected("App");
  await rerender?.("other");
  await act(async () => finish([server("App")]));
  await pending;
  expect(api.approve).not.toHaveBeenCalled();
});

it("stops assigning specialists when the conversation changes during the coordinator grant", async () => {
  api.servers.mockResolvedValue([
    server("Mailbox", {
      endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
      oauthStatus: "connected",
      hasSecret: true,
    }),
  ]);
  let finish!: (grant: unknown) => void;
  api.approve.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const host = await open("main", false, {
    coordinatorBotId: "main",
    recruitingBotIds: { outreach: "outreach", scheduling: "scheduling" },
  });
  await act(async () => button(host, "Connect an app").click());
  const connected = api.setup.mock.calls.at(-1)![0].onServerConnected;
  let pending!: Promise<void>;
  await act(async () => {
    pending = connected("Mailbox");
  });
  expect(api.approve).toHaveBeenCalledTimes(1);
  await rerender?.("other");
  await act(async () => finish({ allowAllTools: false, allowedTools: ["get_thread"] }));
  await pending;
  expect(api.approve).toHaveBeenCalledTimes(1);
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
