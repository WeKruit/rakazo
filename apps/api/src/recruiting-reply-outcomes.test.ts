import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getRecruitingWorkspace } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRecruitingCorrespondence } from "./recruiting.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readRecruitingImportedCorrespondence: vi.fn(async () => null),
  getRecruitingWorkspace: vi.fn(),
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const target = {
  kind: "group" as const,
  groupId: "group",
  groupName: "Role",
  threadId: "thread",
  memberBotIds: ["main"],
  members: [],
};
function fixture() {
  const source = {
    id: "mail",
    name: "Existing mail",
    endpoint: "https://mcp.instantly.ai/mcp",
    transport: "streamable_http",
    enabled: true,
    revision: 4,
    secretId: "test-reference",
    assignments: [
      { botId: "main", allowAllTools: false, allowedTools: ["get_email", "list_emails"] },
    ],
  };
  const effect = {
    id: "reply-effect",
    spaceId: actor.spaceId,
    status: "completed",
    request: [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: source.id,
          resourceRevision: source.revision,
          toolName: "native_instantly_reply_to_email",
        },
        args: {
          reply_to_uuid: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
          body: { text: "Private message" },
          eaccount: "private@example.test",
        },
      },
    ],
    result: { error: "Private provider error" } as Record<string, unknown>,
    updatedAt: new Date("2026-10-23T12:00:00Z"),
    run: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId: "main",
      initialRecruitingRoleRevision: { roleId: "role" },
    },
  };
  const client = {
    mcpServer: { findMany: vi.fn(async () => [structuredClone(source)]) },
    externalEffect: { findMany: vi.fn(async () => [structuredClone(effect)]) },
  };
  return {
    source,
    effect,
    client,
    read: () =>
      getRecruitingCorrespondence(client as unknown as PrismaClient, actor, target, "interview"),
  };
}
beforeEach(() => {
  vi.mocked(getRecruitingWorkspace)
    .mockReset()
    .mockResolvedValue({ role: { id: "role" } } as never);
});

describe("separate saved reply outcomes", () => {
  it.each(["completed-error", "failed", "uncertain"])(
    "projects actual %s without message contents or an event association",
    async (kind) => {
      const f = fixture();
      if (kind !== "completed-error") f.effect.status = kind;
      const result = await f.read();
      expect(result.events).toEqual([]);
      expect(result.operations).toEqual([
        {
          id: f.effect.id,
          kind: "reply",
          outcome: kind === "uncertain" ? "uncertain" : "failed",
          checkedAt: f.effect.updatedAt.toISOString(),
          sourceName: f.source.name,
          sourceId: f.source.id,
          providerMessageId: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
        },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/Private|private@example|eventId|bookingId/);
      expect(f.client.externalEffect.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: actor.spaceId,
            run: expect.objectContaining({
              userId: actor.userId,
              spaceId: actor.spaceId,
              threadId: target.threadId,
              initialRecruitingRoleRevision: { roleId: "role" },
            }),
          }),
          take: 101,
        }),
      );
    },
  );
  it("does not label a completed send receipt failed or delivered", async () => {
    const f = fixture();
    f.effect.result = { id: "sent-id" };
    expect((await f.read()).operations).toEqual([]);
  });
  it.each(["role", "thread", "owner", "space", "source", "revision", "tool", "grant"])(
    "omits wrong %s receipts",
    async (boundary) => {
      const f = fixture();
      const call = f.effect.request[2] as {
        route: { resourceId: string; resourceRevision: number; toolName: string };
      };
      if (boundary === "role") f.effect.run.initialRecruitingRoleRevision.roleId = "other";
      if (boundary === "thread") f.effect.run.threadId = "other";
      if (boundary === "owner") f.effect.run.userId = "other";
      if (boundary === "space") f.effect.spaceId = "other";
      if (boundary === "source") call.route.resourceId = "other";
      if (boundary === "revision") call.route.resourceRevision++;
      if (boundary === "tool") call.route.toolName = "send_email";
      if (boundary === "grant") f.source.assignments[0]!.allowedTools = ["get_email"];
      expect((await f.read()).operations).toEqual([]);
    },
  );
  it.each(["grant", "revision", "disabled", "role", "membership"])(
    "rejects %s changes while reading outcomes",
    async (boundary) => {
      const f = fixture();
      const after = structuredClone(f.source);
      if (boundary === "grant") after.assignments = [];
      if (boundary === "revision") after.revision++;
      if (boundary === "disabled") after.enabled = false;
      f.client.mcpServer.findMany.mockResolvedValueOnce([f.source]).mockResolvedValue([after]);
      if (boundary === "role")
        vi.mocked(getRecruitingWorkspace)
          .mockResolvedValueOnce({ role: { id: "role" } } as never)
          .mockResolvedValue({ role: { id: "other" } } as never);
      if (boundary === "membership")
        vi.mocked(getRecruitingWorkspace)
          .mockResolvedValueOnce({ role: { id: "role" } } as never)
          .mockRejectedValue(new Error("Membership revoked"));
      await expect(f.read()).rejects.toThrow();
    },
  );
  it("omits malformed reply anchors instead of exposing rejected request text", async () => {
    const f = fixture();
    const call = f.effect.request[2] as { args: { reply_to_uuid: string } };
    call.args.reply_to_uuid = "private request text";
    expect((await f.read()).operations).toEqual([]);
  });
  it("bounds retained outcomes and reports overflow", async () => {
    const f = fixture();
    f.client.externalEffect.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ ...f.effect, id: `effect-${index}` })),
    );
    const result = await f.read();
    expect(result.operations).toHaveLength(100);
    expect(result.partial).toBe(true);
  });
});
