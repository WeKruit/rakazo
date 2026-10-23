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
    expect(initialBootstrapTarget("/app/g/group%201", false)).toEqual({ groupId: "group 1" });
    expect(initialBootstrapTarget("/app/g/%E0%A4%A", false)).toEqual({ botId: undefined });
  });

  it("does not prime unrelated routes", () => {
    expect(initialBootstrapTarget("/sign-in", true)).toBeNull();
    expect(initialBootstrapTarget("/onboarding", false)).toBeNull();
  });

  it("reuses the selected group's identity-verified preload", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/g/group-1" } });
    const current = {
      me: { userId: "user", spaceId: "space" },
      thread: { groupId: "group-1", threadId: "thread-1" },
    };
    bootstrapRpc.mockResolvedValue(current);
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    expect(await bootstrap.takeInitialBootstrap(undefined, "group-1")).toBe(current);
    expect(bootstrapRpc).toHaveBeenCalledExactlyOnceWith({ groupId: "group-1" });
  });

  it("does not consume another group's in-flight preload after navigation", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/g/old-group" } });
    let finish!: (value: unknown) => void;
    const current = { me: { userId: "user", spaceId: "space" }, thread: { groupId: "new-group" } };
    bootstrapRpc
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(current);
    const bootstrap = await import("./bootstrap");
    const response = bootstrap.takeInitialBootstrap(undefined, "new-group");
    finish({ me: { userId: "user", spaceId: "space" }, thread: { groupId: "old-group" } });
    expect(await response).toBe(current);
    expect(bootstrapRpc).toHaveBeenNthCalledWith(2, { groupId: "new-group" });
  });

  it("rejects a retained group response after its authenticated identity is invalidated", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/g/group-1" } });
    let finish!: (value: unknown) => void;
    bootstrapRpc.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    const response = bootstrap.takeInitialBootstrap(undefined, "group-1");
    bootstrap.invalidateInitialBootstrap();
    finish({ me: { userId: "user", spaceId: "space" }, thread: { groupId: "group-1" } });
    await expect(response).rejects.toThrow("Bootstrap identity changed");
    expect(bootstrapRpc).toHaveBeenCalledExactlyOnceWith({ groupId: "group-1" });
  });

  it.each([
    { userId: "other-user", spaceId: "space" },
    { userId: "user", spaceId: "other-space" },
  ])("replaces a group preload belonging to another identity: %j", async (me) => {
    vi.stubGlobal("window", { location: { pathname: "/app/g/group-1" } });
    const current = { me: { userId: "user", spaceId: "space" }, thread: { groupId: "group-1" } };
    bootstrapRpc.mockResolvedValueOnce({ me }).mockResolvedValueOnce(current);
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    expect(await bootstrap.takeInitialBootstrap(undefined, "group-1")).toBe(current);
    expect(bootstrapRpc).toHaveBeenNthCalledWith(2, { groupId: "group-1" });
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

  it.each([
    { userId: "user", spaceId: "space" },
    { userId: "other-user", spaceId: "space" },
    { userId: "user", spaceId: "other-space" },
  ])("validates exactly one current fetch after a failed preload: %j", async (me) => {
    vi.stubGlobal("window", { location: { pathname: "/app/bot" } });
    const current = { me };
    bootstrapRpc
      .mockRejectedValueOnce(new Error("Preload unavailable"))
      .mockResolvedValueOnce(current);
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    const response = bootstrap.takeInitialBootstrap("bot");
    if (me.userId === "user" && me.spaceId === "space") {
      expect(await response).toBe(current);
    } else {
      await expect(response).rejects.toThrow("Bootstrap identity changed");
    }
    expect(bootstrapRpc).toHaveBeenCalledTimes(2);
  });

  it("does not fetch again when an invalidated preload fails", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app/bot" } });
    let reject!: (error: Error) => void;
    bootstrapRpc.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const bootstrap = await import("./bootstrap");
    bootstrap.retainInitialBootstrapForIdentity("user", "space");
    const response = bootstrap.takeInitialBootstrap("bot");
    bootstrap.invalidateInitialBootstrap();
    reject(new Error("Preload unavailable"));
    await expect(response).rejects.toThrow("Bootstrap identity changed");
    expect(bootstrapRpc).toHaveBeenCalledOnce();
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
