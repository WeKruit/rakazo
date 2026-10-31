import type { SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { applyComputerNetworkPolicy, egressHost, egressPolicy } from "./computer-network.js";
import { e2bNetworkUpdate } from "./e2b-sandbox.js";

const credentials = [{ host: "api.example.com", headers: { Authorization: "Bearer k" } }];
const context = { signal: new AbortController().signal } as never;

describe("computer network policy", () => {
  it("normalizes the sites an owner types", () => {
    expect(egressHost("https://API.Example.com/path?q=1")).toBe("api.example.com");
    expect(egressHost("pypi.org")).toBe("pypi.org");
    expect(egressHost("*")).toBe("*");
    expect(egressHost("not a host")).toBeUndefined();
    expect(egressHost("localhost")).toBeUndefined();
  });

  it("stays open with no lock and carries no credentials", () => {
    const policy = egressPolicy([{ effect: "always_allow", matchValue: "pypi.org" }], credentials);
    expect(policy).toEqual({ denyHosts: [], credentials: [] });
  });

  it("locks to allowed sites and adds credentials at the edge", () => {
    const policy = egressPolicy(
      [
        { effect: "block", matchValue: "*" },
        { effect: "always_allow", matchValue: "pypi.org" },
        { effect: "block", matchValue: "evil.example" },
      ],
      credentials,
    );
    expect(policy).toEqual({
      allowHosts: ["pypi.org"],
      denyHosts: ["evil.example"],
      credentials,
    });
    expect(e2bNetworkUpdate(policy)).toEqual({
      allowOut: ["pypi.org", "api.example.com"],
      denyOut: ["0.0.0.0/0", "evil.example"],
      rules: { "api.example.com": [{ transform: { headers: { Authorization: "Bearer k" } } }] },
    });
  });

  it("applies only changes, and fails closed only for a lock", async () => {
    const setNetworkPolicy = vi.fn().mockResolvedValue(undefined);
    const sandbox = { setNetworkPolicy } as unknown as SandboxProvider;
    const computer = { id: "c1", providerRef: "sbx-1", kind: "e2b", botId: "b" } as never;
    const open = { denyHosts: [], credentials: [] };
    await applyComputerNetworkPolicy(sandbox, computer, open, context);
    expect(setNetworkPolicy).not.toHaveBeenCalled();
    const locked = { allowHosts: [], denyHosts: [], credentials: [] };
    await applyComputerNetworkPolicy(sandbox, computer, locked, context);
    await applyComputerNetworkPolicy(sandbox, computer, locked, context);
    expect(setNetworkPolicy).toHaveBeenCalledTimes(1);
    await applyComputerNetworkPolicy(sandbox, computer, open, context);
    expect(setNetworkPolicy).toHaveBeenCalledTimes(2);

    const failing = {
      setNetworkPolicy: vi.fn().mockRejectedValue(new Error("down")),
    } as unknown as SandboxProvider;
    const other = { id: "c2", providerRef: "sbx-2", kind: "e2b", botId: "b" } as never;
    await expect(applyComputerNetworkPolicy(failing, other, locked, context)).rejects.toThrow(
      "down",
    );
    const noSupport = {} as SandboxProvider;
    await expect(applyComputerNetworkPolicy(noSupport, other, locked, context)).rejects.toThrow();
    await applyComputerNetworkPolicy(noSupport, other, open, context);
  });
});
