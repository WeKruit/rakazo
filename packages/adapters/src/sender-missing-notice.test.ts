import { Prisma } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { needsSenderNotice, notifyMissingSender } from "./sender-missing-notice.js";

const run = { id: "run", userId: "user", spaceId: "space" };
function fixture(supportEmail: string | null = "support@example.test") {
  const keys = new Set<string>();
  const send = vi.fn(async () => undefined);
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ supportEmail })) },
    user: { findUnique: vi.fn(async () => ({ email: "recruiter@agency.test" })) },
    externalEffect: {
      create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => {
        if (keys.has(data.idempotencyKey))
          throw new Prisma.PrismaClientKnownRequestError("duplicate", {
            code: "P2002",
            clientVersion: "test",
          });
        keys.add(data.idempotencyKey);
        return data;
      }),
    },
  };
  return { deps: { prisma: prisma as never, email: { send } as never }, send };
}

it("finds the notice flag in a wrapped sender read", () => {
  expect(needsSenderNotice({ content: [{ missingSender: true }] })).toBe(true);
  expect(needsSenderNotice({ senders: [] })).toBe(false);
});

it("emails support once per account when an account has no sending mailbox", async () => {
  const f = fixture();
  expect(await notifyMissingSender(f.deps, run)).toBe(true);
  expect(await notifyMissingSender(f.deps, run)).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "support@example.test",
      text: expect.stringContaining("recruiter@agency.test"),
    }),
  );
});

it("sends nothing without a support address", async () => {
  const f = fixture(null);
  expect(await notifyMissingSender(f.deps, run)).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
