import { expect, it, vi } from "vitest";
import { readResearchViewPages } from "./recruiting-read-view";

const input = { threadId: "thread", roleId: "role", roleRevisionId: "revision" };
const workspace = { role: { id: "role" }, revision: { id: "revision" } };
const page = (offset: number) => ({
  kind: "research" as const,
  workspace,
  data: {
    tasks: [],
    actions: Array.from({ length: offset === 0 ? 200 : 5 }, (_, i) => ({ id: `${offset + i}` })),
    observations: [],
  },
});
type Read = Parameters<typeof readResearchViewPages>[1];

it("collects independent research pages through distinct offsets", async () => {
  const read = vi.fn(async ({ offset = 0 }) => page(offset));
  const result = await readResearchViewPages(input, read as unknown as Read);
  expect(result.data?.actions.map((action) => action.id)).toEqual(
    Array.from({ length: 205 }, (_, i) => `${i}`),
  );
  expect(read.mock.calls.map(([arg]) => arg.offset)).toEqual([0, 200]);
});
it.each(["role", "revision"])("discards prior pages on a later %s change", async (field) => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(0))
    .mockResolvedValueOnce({
      ...page(200),
      workspace: { ...workspace, [field]: { id: "changed" } },
    });
  expect((await readResearchViewPages(input, read)).data).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
it("does not expose accumulated results when the later page loses its session", async () => {
  const denied = new Error("Unauthorized");
  const read = vi.fn().mockResolvedValueOnce(page(0)).mockRejectedValueOnce(denied);
  await expect(readResearchViewPages(input, read)).rejects.toBe(denied);
});
it("stops further reads when the navigation is cancelled", async () => {
  const abort = new AbortController();
  const read = vi.fn(async () => {
    abort.abort();
    return page(0);
  });
  await expect(
    readResearchViewPages(input, read as unknown as Read, abort.signal),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(read).toHaveBeenCalledOnce();
});
