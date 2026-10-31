// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useShellNotifications } from "./useShellNotifications";

const api = vi.hoisted(() => ({
  activity: vi.fn().mockResolvedValue({ ok: true }),
  claim: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    notifications: { desktopActivity: api.activity, claimBrowser: api.claim },
    threads: { markRead: vi.fn(), markUnread: vi.fn() },
  },
}));

let controls: ReturnType<typeof useShellNotifications>;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const show = vi.fn();
let visible = true;
let focused = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Notification",
    Object.assign(
      function Notification(...args: unknown[]) {
        show(...args);
      },
      { permission: "granted" },
    ),
  );
  visible = true;
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Desktop browser");
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount() {
  function Harness() {
    controls = useShellNotifications({
      active: undefined,
      botsRef: { current: [{ id: "bot", name: "Assistant", notifyOnFinish: true } as Bot] },
      setBots: vi.fn(),
      manuallyUnread: { current: new Set() },
    });
    return null;
  }
  act(() => root.render(<Harness />));
}

it("heartbeats the focused desktop across conversations, and pauses when hidden or unfocused", async () => {
  mount();
  expect(api.activity).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(api.activity).toHaveBeenCalledTimes(2);
  focused = false;
  await act(async () => vi.advanceTimersByTime(45_000));
  visible = false;
  focused = true;
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(api.activity).toHaveBeenCalledTimes(2);
  visible = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(api.activity).toHaveBeenCalledTimes(3);
});

it("does not claim desktop activity from mobile web", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone Mobile");
  mount();
  await act(async () => vi.advanceTimersByTime(90_000));
  expect(api.activity).not.toHaveBeenCalled();
});

it("requires the shared server reservation before showing a browser notification", async () => {
  mount();
  visible = false;
  const event = {
    id: "event",
    type: "thread.message.created" as const,
    threadId: "thread",
    botId: "bot",
    seq: 2,
    payload: { role: "bot", blocks: [{ kind: "text", text: "Ready" }] },
  };
  api.claim.mockResolvedValueOnce({ allowed: false });
  await act(async () =>
    controls.notifyBrowserForEvent(event, "thread", 0, true, "Assistant", true, false),
  );
  expect(api.claim).toHaveBeenCalledWith({ threadId: "thread", eventId: "event" });
  expect(show).not.toHaveBeenCalled();
  await act(async () =>
    controls.notifyBrowserForEvent(
      { ...event, id: "next" },
      "thread",
      0,
      true,
      "Assistant",
      true,
      false,
    ),
  );
  expect(show).toHaveBeenCalledOnce();
});
