import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "./mcp-connect";

const begin = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { mcp: { oauth: { begin } } } }));

describe("MCP OAuth popup lifetime", () => {
  const popup = { closed: false, close: vi.fn() };
  const channels: {
    name: string;
    onmessage: ((event: { data: unknown }) => void) | null;
    close: ReturnType<typeof vi.fn>;
  }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    popup.closed = false;
    popup.close.mockReset().mockImplementation(() => {
      popup.closed = true;
    });
    channels.length = 0;
    begin.mockReset().mockResolvedValue({
      status: "authorization_required",
      sessionId: "oauth-session",
      authorizationUrl: "https://provider.example.test/authorize",
    });
    vi.stubGlobal("window", {
      location: { origin: "https://example.test" },
      open: vi.fn(() => popup),
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        close = vi.fn();
        constructor(public name: string) {
          channels.push(this);
        }
      },
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays open beyond two minutes and expires at the backend's ten-minute lifetime", async () => {
    const settled = vi.fn();
    const flow = connectMcpOauth("server-a");
    void flow.then(settled);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    expect(popup.close).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8 * 60_000 - 2);
    expect(popup.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(flow).resolves.toBe("cancelled");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels when the user closes the popup and clears both timers", async () => {
    const flow = connectMcpOauth("server-a");
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    await expect(flow).resolves.toBe("cancelled");
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("accepts BroadcastChannel completion and clears both timers", async () => {
    const flow = connectMcpOauth("server-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(channels[0]?.name).toBe(MCP_OAUTH_CHANNEL);
    channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } });
    await expect(flow).resolves.toBe("connected");
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(popup.close).not.toHaveBeenCalled();
  });
});
