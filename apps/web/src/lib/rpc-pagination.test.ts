import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ bots: vi.fn(), groups: vi.fn(), get: vi.fn() }));
vi.mock("@orpc/client", () => ({
  createORPCClient: () => ({
    bots: { page: calls.bots, get: calls.get },
    groups: { page: calls.groups },
  }),
}));

import { rpc } from "./rpc.js";

beforeEach(() => vi.clearAllMocks());
describe("existing web list callers", () => {
  it("collects all pages instead of silently dropping bots after 200", async () => {
    calls.bots
      .mockResolvedValueOnce({ items: [{ id: "first" }], nextOffset: 200 })
      .mockResolvedValueOnce({ items: [{ id: "last" }], nextOffset: null });
    expect(await rpc.bots.list()).toEqual([{ id: "first" }, { id: "last" }]);
    expect(calls.bots.mock.calls.map(([input]) => input)).toEqual([
      { offset: 0, archived: false },
      { offset: 200, archived: false },
    ]);
  });
  it("preserves archive filter, cancellation and explicit Space across sparse group pages", async () => {
    calls.groups
      .mockResolvedValueOnce({ items: [], nextOffset: 200 })
      .mockResolvedValueOnce({ items: [{ id: "last" }], nextOffset: null });
    const signal = new AbortController().signal;
    expect(
      await rpc.groups.listArchived(undefined, { signal, context: { spaceId: "test-space" } }),
    ).toEqual([{ id: "last" }]);
    expect(calls.groups).toHaveBeenLastCalledWith(
      { offset: 200, archived: true },
      { signal, context: { spaceId: "test-space" } },
    );
  });
  it("leaves non-list procedures unchanged", async () => {
    calls.get.mockResolvedValue({ id: "one" });
    await rpc.bots.get({ botId: "one" });
    expect(calls.get).toHaveBeenCalledWith({ botId: "one" });
  });
});
