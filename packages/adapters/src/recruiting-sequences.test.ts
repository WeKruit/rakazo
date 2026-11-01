import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  IsolationError: class IsolationError extends Error {},
  getRecruitingWorkspace: vi.fn(async () => ({ role: { id: "role" } })),
}));

import { executeRecruitingSequence } from "./recruiting-sequences.js";

const actor = { userId: "user", spaceId: "space" } as never;
const target = { kind: "bot", botId: "bot", threadId: "thread" } as const;
function dependencies() {
  const assignment = {
    botId: "bot",
    allowAllTools: true,
    allowedTools: [],
    server: { id: "server", revision: 1 },
  };
  const execute = vi.fn(async function* () {
    yield {
      type: "result" as const,
      data: {
        structuredContent: {
          result: {
            roleId: "role",
            roleTitle: "Engineer",
            mailboxes: [],
            campaign: null,
          },
        },
      },
    };
  });
  return {
    prisma: { botMcpServer: { findFirst: vi.fn(async () => assignment) } } as never,
    connectors: { execute } as never,
    reauthorize: vi.fn(async () => target),
    stillAuthorized: vi.fn(async () => true),
    execute,
  };
}
it("rejects activation and arbitrary tool commands before connector dispatch", async () => {
  const deps = dependencies();
  await expect(
    executeRecruitingSequence(deps, actor, target, {
      operation: "activate",
      roleId: "role",
      serverId: "server",
    } as never),
  ).rejects.toThrow();
  expect(deps.execute).not.toHaveBeenCalled();
});
it("rejects results if authorization is revoked while the provider responds", async () => {
  const deps = dependencies();
  deps.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    executeRecruitingSequence(deps, actor, target, {
      operation: "read",
      roleId: "role",
      serverId: "server",
    }),
  ).rejects.toThrow();
  expect(deps.execute).toHaveBeenCalledOnce();
});
