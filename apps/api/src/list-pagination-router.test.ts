import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

it("applies the 200-row cap after authorization and preserves explicit continuation", async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({
    id: `section-${id}`,
    name: `Section ${id}`,
    position: id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const findMany = vi.fn(async ({ take, skip }) => {
    expect(take).toBe(200);
    return rows.slice(skip, skip + take);
  });
  const deps = { env: {}, prisma: { botSection: { findMany } } } as unknown as RouterDeps;
  const actor: Actor = {
    spaceId: "test-space",
    userId: "test-user",
    email: "test@example.test",
    isDeploymentOwner: false,
  };
  const router = createRouter(deps);
  const client = createRouterClient(router, { context: { actor } });
  const ids: string[] = [];
  for (let offset = 0; offset <= 1000; offset += 200) {
    const page = await client.botSections.list({ offset });
    expect(page.length).toBe(offset < 1000 ? 200 : 0);
    ids.push(...page.map((row) => row.id));
  }
  expect(new Set(ids).size).toBe(1000);
  expect(await client.botSections.list()).toHaveLength(200);
  const denied = createRouterClient(router, { context: { actor: null } });
  await expect(denied.botSections.list({ offset: 200 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
