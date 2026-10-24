import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type * as DbExports from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const methods = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DbExports>()),
  listRecruitingProfileActivity: methods.list,
  recordRecruitingProfileView: methods.record,
}));
const prisma = {} as PrismaClient;
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const target = { roleId: "role", candidateKey: "autumn:person" };
const input = { ...target, viewId: "00000000-0000-4000-8000-000000000001" };
const event = {
  roleTitle: "Synthetic role",
  id: "event",
  at: "2026-10-23T12:00:00.000Z",
  actorName: "Recruiter",
};
const router = createRouter({ prisma, env: { deploymentModelConfigured: false } } as RouterDeps);
const client = (identity: Actor | null) =>
  createRouterClient(router, { context: { actor: identity } });
beforeEach(() => {
  vi.resetAllMocks();
  methods.list.mockResolvedValue({ items: [event], hasMore: false });
  methods.record.mockResolvedValue(event);
});

it("requires authentication for both view reads and writes", async () => {
  await expect(client(null).recruiting.profileActivity.list(target)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(client(null).recruiting.profileActivity.recordView(input)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(methods.list).not.toHaveBeenCalled();
  expect(methods.record).not.toHaveBeenCalled();
});
it("uses the authenticated actor and one domain implementation", async () => {
  expect(await client(actor).recruiting.profileActivity.recordView(input)).toEqual(event);
  expect(methods.record).toHaveBeenCalledExactlyOnceWith(prisma, actor, input);
  expect(await client(actor).recruiting.profileActivity.list(target)).toEqual({
    items: [event],
    hasMore: false,
  });
  expect(methods.list).toHaveBeenCalledExactlyOnceWith(prisma, actor, target);
});
it("does not allow the caller to submit an actor or event timestamp", async () => {
  await expect(
    client(actor).recruiting.profileActivity.recordView({
      ...input,
      actorName: "Impostor",
      at: event.at,
    } as typeof input),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(methods.record).not.toHaveBeenCalled();
});
it("maps owner/candidate isolation failures to an opaque not-found response", async () => {
  methods.record.mockRejectedValue(new IsolationError("Private candidate"));
  methods.list.mockRejectedValue(new IsolationError("Private candidate"));
  await expect(client(actor).recruiting.profileActivity.recordView(input)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Resource not found",
  });
  await expect(client(actor).recruiting.profileActivity.list(target)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Resource not found",
  });
});
