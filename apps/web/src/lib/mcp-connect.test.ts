import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "./mcp-connect";
import type { runSsoFlow } from "./sso-flow";

const begin = vi.hoisted(() => vi.fn());
const security = vi.hoisted(() => vi.fn());
const sso = vi.hoisted(() => vi.fn());
const link = vi.hoisted(() => vi.fn());
const signIn = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({
  userId: "user-a",
  sessionId: "session-a",
  spaceId: null as string | null,
}));
vi.mock("./rpc", () => ({
  rpc: { mcp: { oauth: { begin } } },
  selectedSpaceId: () => identity.spaceId,
}));
vi.mock("./auth", () => ({
  authClient: {
    $store: {
      atoms: {
        session: {
          get: () => ({
            data: { user: { id: identity.userId }, session: { id: identity.sessionId } },
          }),
        },
      },
    },
    linkSocial: link,
    signIn: { social: signIn },
  },
}));
vi.mock("./account-security", () => ({ fetchAccountSecurity: security }));
vi.mock("./sso-flow", () => ({ runSsoFlow: sso }));

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
    identity.userId = "user-a";
    identity.sessionId = "session-a";
    identity.spaceId = null;
    security.mockReset().mockResolvedValue({ sso: { name: "Work account" }, ssoLinked: false });
    sso
      .mockReset()
      .mockImplementation((callback: Parameters<typeof runSsoFlow>[0]) =>
        callback(false, (url) => url),
      );
    link
      .mockReset()
      .mockResolvedValue({ data: { url: "https://identity.example.test/authorize" }, error: null });
    signIn
      .mockReset()
      .mockResolvedValue({ data: { url: "https://identity.example.test/authorize" }, error: null });
    begin.mockReset().mockResolvedValue({
      status: "authorization_required",
      sessionId: "oauth-session",
      authorizationUrl: "https://provider.example.test/authorize",
    });
    vi.stubGlobal("window", {
      location: {
        origin: "https://example.test",
        href: "https://example.test/app/g/role-a?view=contacts",
      },
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

  it.each([false, true])(
    "uses native product identity linking or reauthentication with ssoLinked=%s",
    async (ssoLinked) => {
      begin.mockResolvedValue({ status: "product_sign_in_required" });
      security.mockResolvedValue({ sso: { name: "Work account" }, ssoLinked });
      await expect(connectMcpOauth("server-a")).resolves.toBe("cancelled");
      expect(sso).toHaveBeenCalledWith(expect.any(Function), [window.location.href]);
      expect(ssoLinked ? signIn : link).toHaveBeenCalledExactlyOnceWith({
        disableRedirect: false,
        provider: "oidc",
        callbackURL: window.location.href,
        errorCallbackURL: window.location.href,
        ...(ssoLinked ? { additionalData: { reauthenticate: true } } : {}),
      });
      expect(ssoLinked ? link : signIn).not.toHaveBeenCalled();
      expect(begin).toHaveBeenCalledOnce();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["begin", "userId"],
    ["begin", "sessionId"],
    ["begin", "spaceId"],
    ["security", "userId"],
    ["security", "sessionId"],
    ["security", "spaceId"],
  ] as const)(
    "cancels a late %s response after %s changes before product sign-in",
    async (stage, changed) => {
      let finish!: (value: unknown) => void;
      const waiting = new Promise((resolve) => {
        finish = resolve;
      });
      begin.mockResolvedValue({ status: "product_sign_in_required" });
      if (stage === "begin") begin.mockReturnValueOnce(waiting);
      else security.mockReturnValueOnce(waiting);
      const flow = connectMcpOauth("server-a");
      await vi.advanceTimersByTimeAsync(0);
      identity[changed] = "different-scope";
      finish(
        stage === "begin"
          ? { status: "product_sign_in_required" }
          : { sso: { name: "Work account" }, ssoLinked: false },
      );
      await expect(flow).resolves.toBe("cancelled");
      expect(link).not.toHaveBeenCalled();
      expect(signIn).not.toHaveBeenCalled();
      expect(sso).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it("does not treat a cancelled SSO request as a service connection", async () => {
    begin.mockResolvedValue({ status: "product_sign_in_required" });
    sso.mockResolvedValue({ data: null, error: null });
    await expect(connectMcpOauth("server-a")).resolves.toBe("cancelled");
    expect(begin).toHaveBeenCalledOnce();
  });

  it("reports SSO failure without claiming a connection or opening generic authorization", async () => {
    begin.mockResolvedValue({ status: "product_sign_in_required" });
    sso.mockResolvedValue({ data: null, error: { code: "SSO_UNAVAILABLE" } });
    await expect(connectMcpOauth("server-a")).rejects.toThrow();
    expect(begin).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does not fall back to generic authorization when product SSO is unavailable", async () => {
    begin.mockResolvedValue({ status: "product_sign_in_required" });
    security.mockResolvedValue({ sso: null, ssoLinked: false });
    await expect(connectMcpOauth("server-a")).rejects.toThrow();
    expect(sso).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(["already_connected", "authorization_not_requested"])(
    "preserves native %s without asking for product sign-in",
    async (status) => {
      begin.mockResolvedValue({ status });
      await expect(connectMcpOauth("server-a")).resolves.toBe(status);
      expect(security).not.toHaveBeenCalled();
      expect(sso).not.toHaveBeenCalled();
    },
  );

  it("does not report an old account's generic popup completion after the workspace changes", async () => {
    const flow = connectMcpOauth("server-a");
    await vi.advanceTimersByTimeAsync(0);
    identity.spaceId = "another-space";
    channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } });
    await expect(flow).resolves.toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});
