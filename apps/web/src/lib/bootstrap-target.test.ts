import { afterEach, describe, expect, it, vi } from "vitest";
import { initialBootstrapTarget } from "./bootstrap-target";

const bootstrapRpc = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { bootstrap: bootstrapRpc } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  bootstrapRpc.mockReset();
});

describe("initial bootstrap target", () => {
  it("primes the Electron root before its client-side redirect", () => {
    expect(initialBootstrapTarget("/", true)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/", false)).toBeNull();
  });

  it("primes browser app routes and decodes their selected bot", () => {
    expect(initialBootstrapTarget("/app/board", false)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app", false)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app/research%20bot", false)).toEqual({
      botId: "research bot",
    });
    expect(initialBootstrapTarget("/app/g/group-1", false)).toEqual({ botId: undefined });
  });

  it("does not prime unrelated routes", () => {
    expect(initialBootstrapTarget("/sign-in", true)).toBeNull();
    expect(initialBootstrapTarget("/onboarding", false)).toBeNull();
  });

  it.each([
    { userId: "other-user", spaceId: "space" },
    { userId: "user", spaceId: "other-space" },
  ])("replaces a preload for a different authenticated identity: %j", async (me) => {
    vi.stubGlobal("window", { location: { pathname: "/app/bot" } });
    const current = { me: { userId: "user", spaceId: "space" } };
    bootstrapRpc.mockResolvedValueOnce({ me }).mockResolvedValueOnce(current);
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    expect(await bootstrap.takeInitialBootstrap("bot")).toBe(current);
    expect(bootstrapRpc).toHaveBeenCalledTimes(2);
  });

  it("never returns a response for another account when the current fetch also mismatches", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/bot" } });
    bootstrapRpc.mockResolvedValue({ me: { userId: "other-user", spaceId: "space" } });
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    await expect(bootstrap.takeInitialBootstrap("bot")).rejects.toThrow(
      "Bootstrap identity changed",
    );
    expect(bootstrapRpc).toHaveBeenCalledTimes(2);
  });

  it("rejects a retained response after logout or a real identity change", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/bot" } });
    let resolve!: (value: unknown) => void;
    bootstrapRpc.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    const response = bootstrap.takeInitialBootstrap("bot");
    bootstrap.invalidateInitialBootstrap();
    resolve({ me: { userId: "user", spaceId: "space" } });
    await expect(response).rejects.toThrow("Bootstrap identity changed");
    expect(bootstrapRpc).toHaveBeenCalledOnce();
  });
});
