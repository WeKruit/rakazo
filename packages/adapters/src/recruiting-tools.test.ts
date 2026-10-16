import type { Actor } from "@rakazo/contracts";
import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { executeRecruitingRoleMutation, getRecruitingWorkspace, IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  executeRecruitingRoleMutation: vi.fn(),
  getRecruitingWorkspace: vi.fn(),
}));

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const context = { actor, runId: "run", sourceMessageId: "human-message" };
const workspace = { role: { id: "role" }, revision: { id: "revision" } };

describe("native recruiting_role", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the actual owned run's thread without requiring new human consent", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      ...actor,
      id: "run",
      threadId: "actual-thread",
      bot: actor,
      trigger: "bot_message",
    });
    vi.mocked(getRecruitingWorkspace).mockResolvedValue(workspace as never);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;
    expect(
      await executeRecruitingRoleTool(
        prisma,
        { ...context, sourceMessageId: null },
        { operation: "read" },
      ),
    ).toEqual({
      status: "current",
      workspace,
      source: null,
      changed: false,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run", spaceId: actor.spaceId, userId: actor.userId },
      }),
    );
    expect(getRecruitingWorkspace).toHaveBeenCalledWith(prisma, actor, {
      threadId: "actual-thread",
    });
    expect(executeRecruitingRoleMutation).not.toHaveBeenCalled();
  });

  it("does not disclose a workspace through a missing, foreign, or foreign-bot run", async () => {
    for (const run of [
      null,
      { ...actor, userId: "other", bot: actor },
      { ...actor, bot: { ...actor, userId: "other" } },
    ]) {
      const prisma = {
        run: { findFirst: vi.fn().mockResolvedValue(run) },
      } as unknown as PrismaClient;
      await expect(
        executeRecruitingRoleTool(prisma, context, { operation: "read" }),
      ).rejects.toThrow(IsolationError);
    }
    expect(getRecruitingWorkspace).not.toHaveBeenCalled();
  });

  it("routes mutations through the atomic DB provenance guard with trusted runtime identity", async () => {
    const prisma = {} as PrismaClient;
    const input = {
      operation: "bind",
      roleId: "role",
      intent: { basis: "direct", quote: "Use this role" },
    };
    const receipt = { status: "saved", changed: true, workspace, source: { id: "verified-human" } };
    vi.mocked(executeRecruitingRoleMutation).mockResolvedValue(receipt as never);
    expect(await executeRecruitingRoleTool(prisma, context, input)).toEqual(receipt);
    expect(executeRecruitingRoleMutation).toHaveBeenCalledWith(
      prisma,
      actor,
      { runId: "run", sourceMessageId: "human-message" },
      input,
    );
  });

  it("rejects model-selected identity before dispatch", async () => {
    await expect(
      executeRecruitingRoleTool({} as PrismaClient, context, {
        operation: "read",
        threadId: "other-thread",
      }),
    ).rejects.toThrow();
    expect(getRecruitingWorkspace).not.toHaveBeenCalled();
    expect(executeRecruitingRoleMutation).not.toHaveBeenCalled();
  });
});
