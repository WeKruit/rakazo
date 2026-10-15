// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ servers: vi.fn(), bots: vi.fn(), all: vi.fn(), replace: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    bots: { list: api.bots },
    mcp: { servers: { list: api.servers }, assignments: { all: api.all, replace: api.replace } },
  },
}));
vi.mock("../lib/mcp-connect", () => ({ MCP_OAUTH_CHANNEL: "mcp-test" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...Object.fromEntries(
      [
        "Badge",
        "Card",
        "CardContent",
        "CardHeader",
        "CardTitle",
        "Dialog",
        "DialogContent",
        "DialogHeader",
        "DialogTitle",
        "Field",
        "FieldGroup",
        "FieldTitle",
        "Tabs",
        "TabsList",
        "TabsTrigger",
      ].map((name) => [name, Box]),
    ),
    DialogClose: ({ render }: { render: ReactNode }) => render,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Checkbox: (props: ComponentProps<"input">) => <input type="checkbox" {...props} />,
    FieldLabel: ({ htmlFor, children }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
  };
});

import { McpServersOverlay } from "./McpServersOverlay";

afterEach(() => vi.unstubAllGlobals());

it("assigns exact tools without an all-tools grant and keeps other servers and failed edits intact", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      close() {}
    },
  );
  api.servers.mockResolvedValue([
    {
      id: "server-a",
      name: "Research",
      slug: "research",
      transport: "streamable_http",
      endpoint: "https://example.test/mcp",
      oauthStatus: "none",
    },
    {
      id: "server-b",
      name: "Notes",
      slug: "notes",
      transport: "stdio",
      command: "notes",
      oauthStatus: "none",
    },
  ]);
  api.bots.mockResolvedValue([{ id: "bot-a", name: "Main", archivedAt: null }]);
  let stored = [
    {
      id: "assignment-b",
      botId: "bot-a",
      serverId: "server-b",
      allowAllTools: false,
      allowedTools: ["read_notes"],
    },
  ];
  api.all.mockImplementation(async () => structuredClone(stored));
  api.replace.mockReset().mockImplementation(async ({ assignments }) => {
    stored = assignments.map((entry: (typeof stored)[number]) => ({
      ...entry,
      id: entry.id ?? `assignment-${entry.serverId}`,
      botId: "bot-a",
    }));
    return structuredClone(stored);
  });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const form = () => {
    const result = container.querySelector<HTMLFormElement>('form[aria-label="Research · Main"]');
    expect(result).not.toBeNull();
    if (!result) throw new Error("Missing native tool access form");
    return result;
  };
  const tools = () => form().querySelector<HTMLTextAreaElement>('textarea[name="allowedTools"]')!;
  const all = () => form().querySelector<HTMLInputElement>('input[name="allowAllTools"]')!;
  const fill = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        tools(),
        value,
      );
      tools().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const save = async () =>
    act(async () => {
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => undefined} />));
    expect(tools().value).toBe("");
    expect(all().checked).toBe(false);
    await fill("  get_task \r\nget_rows\nget_task\n\n");
    api.replace.mockRejectedValueOnce(new Error("Save unavailable"));
    await save();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Save unavailable");
    expect(stored.find((entry) => entry.serverId === "server-a")).toBeUndefined();
    expect(tools().value).toContain("get_rows");
    await save();
    expect(api.replace).toHaveBeenLastCalledWith({
      botId: "bot-a",
      assignments: [
        expect.objectContaining({
          serverId: "server-b",
          allowAllTools: false,
          allowedTools: ["read_notes"],
        }),
        expect.objectContaining({
          serverId: "server-a",
          allowAllTools: false,
          allowedTools: ["get_task", "get_rows"],
        }),
      ],
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<McpServersOverlay onClose={() => undefined} />));
    expect(tools().value).toBe("get_task\nget_rows");
    expect(all().checked).toBe(false);
    await fill("");
    await save();
    expect(stored.find((entry) => entry.serverId === "server-a")).toMatchObject({
      allowAllTools: false,
      allowedTools: [],
    });
    await act(async () => all().click());
    await save();
    expect(stored.find((entry) => entry.serverId === "server-a")).toMatchObject({
      allowAllTools: true,
      allowedTools: [],
    });
    expect(stored.find((entry) => entry.serverId === "server-b")).toMatchObject({
      allowAllTools: false,
      allowedTools: ["read_notes"],
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
