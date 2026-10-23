// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const begin = vi.hoisted(() => vi.fn());
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({
  rpc: { mcp: { oauth: { begin } } },
  selectedSpaceId: () => null,
}));
vi.mock("../lib/auth", () => ({
  authClient: {
    $store: {
      atoms: {
        session: { get: () => ({ data: { user: { id: "user-a" }, session: { id: "s-a" } } }) },
      },
    },
  },
}));

import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channels: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
const popup = { closed: false, close: vi.fn() };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const block: AskBlock = {
  kind: "ask",
  text: "Connect Gmail",
  status: "pending",
  connection: { serverId: "server-gmail", name: "Gmail", reason: "To send the approved email." },
};

beforeEach(() => {
  channels.length = 0;
  popup.closed = false;
  begin.mockReset();
  vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      close = vi.fn();
      constructor() {
        channels.push(this);
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(next: AskBlock, onAnswer = vi.fn().mockResolvedValue(undefined)) {
  act(() => root.render(<AskCard block={next} canAnswer onAnswer={onAnswer} />));
  return onAnswer;
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

it("renders the connect card from a connection ask with a fallback icon and the reason", () => {
  render(block);
  const card = container.querySelector('[data-testid="connection-ask-card"]')!;
  expect(card.getAttribute("aria-label")).toBe("Connect Gmail");
  expect(card.textContent).toContain("Connect Gmail");
  expect(card.textContent).toContain("To send the approved email.");
  expect(card.querySelector("img")).toBeNull();
  expect(card.querySelector("svg")).not.toBeNull();
  expect(button("Connect")).toBeDefined();
  expect(button("Not now")).toBeDefined();
  expect(container.querySelector("textarea")).toBeNull();
});

it("shows the provided icon", () => {
  render({ ...block, connection: { ...block.connection!, iconUrl: "https://example.test/g.png" } });
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/g.png");
});

it("answers connected straight away when the server is already connected", async () => {
  begin.mockResolvedValue({ status: "already_connected" });
  const onAnswer = render(block);
  act(() => button("Connect").click());
  await flush();
  expect(begin).toHaveBeenCalledWith(expect.objectContaining({ serverId: "server-gmail" }));
  expect(window.open).not.toHaveBeenCalled();
  expect(onAnswer).toHaveBeenCalledWith("connected");
  expect(container.textContent).toContain("Connected");
});

it("answers connected once the OAuth popup completes", async () => {
  begin.mockResolvedValue({
    status: "authorization_required",
    sessionId: "oauth-1",
    authorizationUrl: "https://provider.example.test/authorize",
  });
  const onAnswer = render(block);
  act(() => button("Connect").click());
  await flush();
  expect(window.open).toHaveBeenCalledWith(
    "https://provider.example.test/authorize",
    expect.any(String),
    expect.any(String),
  );
  expect(button("Connecting…").disabled).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  act(() => channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } }));
  await flush();
  expect(onAnswer).toHaveBeenCalledWith("connected");
});

it("shows a retryable failure when OAuth does not finish", async () => {
  begin.mockRejectedValue(new Error("boom"));
  const onAnswer = render(block);
  act(() => button("Connect").click());
  await flush();
  expect(container.textContent).toContain("Could not connect. Try again.");
  expect(button("Connect").disabled).toBe(false);
  expect(onAnswer).not.toHaveBeenCalled();
});

it("answers not connected from Not now", async () => {
  const onAnswer = render(block);
  act(() => button("Not now").click());
  await flush();
  expect(begin).not.toHaveBeenCalled();
  expect(onAnswer).toHaveBeenCalledWith("not_connected");
});

it("keeps the answered state after a remount", () => {
  render({ ...block, status: "answered", answer: "connected" });
  expect(container.textContent).toContain("Connected");
  expect(button("Connect")).toBeUndefined();
  render({ ...block, status: "answered", answer: "not_connected" });
  expect(container.textContent).toContain("Not now");
  expect(button("Not now")).toBeUndefined();
});
