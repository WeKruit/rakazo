import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  bots: vi.fn(),
  groups: vi.fn(),
  get: vi.fn(),
  models: vi.fn(),
  assignments: vi.fn(),
}));
vi.mock("@orpc/client", () => ({
  createORPCClient: () => ({
    models: { list: calls.models },
    mcp: { assignments: { all: calls.assignments } },
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

it("collects nested and root settings pages without dropping records", async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({ id }));
  for (const mock of [calls.models, calls.assignments])
    mock.mockImplementation(async ({ offset }) => rows.slice(offset, offset + 200));
  expect(await rpc.models.list()).toEqual(rows);
  expect(await rpc.mcp.assignments.all()).toEqual(rows);
  expect(calls.models.mock.calls.map(([input]) => input.offset)).toEqual([
    0, 200, 400, 600, 800, 1000,
  ]);
  expect(calls.assignments).toHaveBeenCalledTimes(6);
});
it("honors explicit settings page requests", async () => {
  calls.models.mockResolvedValue([]);
  await rpc.models.list({ offset: 400 });
  expect(calls.models).toHaveBeenCalledExactlyOnceWith({ offset: 400 }, undefined);
});
