import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { bindRecruitingRole, createRecruitingRole } from "./recruiting.js";
import { recruitingGlobalGroupId } from "./recruiting-bootstrap.js";

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const create = vi.fn();
  const update = vi.fn();
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const tx = {
    thread: {
      findFirst: vi.fn(async () => ({
        id: "global-thread",
        ...scope,
        botId: null,
        groupId: recruitingGlobalGroupId(actor),
        activeRecruitingRoleId: null,
      })),
      update,
    },
    chatGroup: { findFirst: vi.fn(async () => scope) },
    recruitingRole: { create },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, create, update };
}

describe("global recruiting conversation", () => {
  it("refuses role creation before any role or thread write", async () => {
    const f = fixture();
    await expect(
      createRecruitingRole(f.prisma, actor, {
        sourceThreadId: "global-thread",
        title: "Engineer",
        expectedRevision: 0,
        sourceRefs: [
          {
            id: "jd",
            kind: "original_material",
            anchor: { kind: "message", messageId: "message", locator: "text:0" },
            readState: "read",
            readAt: "2026-10-30T00:00:00.000Z",
          },
        ],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
      }),
    ).rejects.toThrow("Main stays across all roles");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("refuses selecting a role while allowing an already unbound global thread", async () => {
    const f = fixture();
    await expect(
      bindRecruitingRole(f.prisma, actor, { threadId: "global-thread", roleId: "role" }),
    ).rejects.toThrow("Main stays across all roles");
    await expect(
      bindRecruitingRole(f.prisma, actor, { threadId: "global-thread", roleId: null }),
    ).resolves.toBeNull();
    expect(f.update).not.toHaveBeenCalled();
  });
});
