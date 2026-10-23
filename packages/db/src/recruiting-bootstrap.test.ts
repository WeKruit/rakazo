import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import * as recruiting from "./recruiting-bootstrap.js";

const native = vi.hoisted(() => ({ bot: vi.fn(), group: vi.fn() }));
vi.mock("./repos.js", () => ({ createBotInTransaction: native.bot }));
vi.mock("./groups.js", () => ({ createGroupInTransaction: native.group }));
const actor: Actor = {
  userId: "person-a",
  spaceId: "personal-a",
  email: "a@example.test",
  isDeploymentOwner: false,
};

type BotRow = {
  id: string;
  spawnKey: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  disabledBuiltinTools: string[];
  archivedAt: Date | null;
  modelId?: string;
};
type ServiceRow = {
  id: string;
  slug: string;
  endpoint: string;
  transport: string;
  secretId?: string;
  enabled: boolean;
  revision: number;
  args: unknown[];
  headers: object;
  env: object;
  command: null;
};
type AssignmentRow = {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: string[];
};
type PresetRow = {
  id: string;
  kind: string;
  source: string;
  version: string;
  digest: string | null;
  spaceId: string;
  userId: string;
  config: unknown;
};
type ManagedState = {
  schemaVersion: number;
  groupId: string;
  members: string[];
  bots: Record<string, { id: string; fields: Record<string, string> }>;
  services: Record<
    string,
    {
      id: string;
      signature: string;
      assignments: Record<string, { id: string; signature: string } | null>;
    }
  >;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture() {
  const bots: BotRow[] = [];
  const servers: ServiceRow[] = [];
  const assignments: AssignmentRow[] = [];
  const presets: PresetRow[] = [];
  let busy = false;
  let botSequence = 0;
  let assignmentSequence = 0;
  let group: {
    id: string;
    userId: string;
    spaceId: string;
    name: string;
    archivedAt: Date | null;
    thread: { id: string };
    members: { botId: string }[];
  } | null = null;
  const tx = {
    $queryRaw: vi.fn(async (_query: { sql: string }) => [{ complete: true }]),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org-a", space: { deletingAt: null } })),
    },
    space: { findFirst: vi.fn(async () => ({ id: actor.spaceId })) },
    run: { count: vi.fn(async () => (busy ? 1 : 0)) },
    bot: {
      findMany: vi.fn(async () => [...bots]),
      count: vi.fn(async () => bots.length),
      updateMany: vi.fn(async ({ where, data }) => {
        const bot = bots.find((row) => row.id === where.id && !row.archivedAt);
        if (
          !bot ||
          Object.keys(data).some((key) =>
            key === "disabledBuiltinTools"
              ? JSON.stringify(bot.disabledBuiltinTools) !== JSON.stringify(where[key]?.equals)
              : (bot as unknown as Record<string, unknown>)[key] !== where[key],
          )
        )
          return { count: 0 };
        Object.assign(bot, data);
        return { count: 1 };
      }),
    },
    chatGroup: {
      findFirst: vi.fn(async () =>
        group ? { ...group, members: group.members.map((member) => ({ ...member })) } : null,
      ),
      count: vi.fn(async () => (group ? 1 : 0)),
    },
    chatGroupMember: {
      createMany: vi.fn(async ({ data }) => {
        group!.members.push(...data.map((row: { botId: string }) => ({ botId: row.botId })));
        return { count: data.length };
      }),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost: "docker" })) },
    mcpServer: {
      findFirst: vi.fn(async ({ where }) => servers.find((row) => row.slug === where.slug) ?? null),
      findMany: vi.fn(async () =>
        servers.map((row) => ({
          ...row,
          assignments: assignments.filter((a) => a.serverId === row.id),
        })),
      ),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `${data.slug}-a`,
          enabled: true,
          revision: 1,
          args: [],
          headers: {},
          env: {},
          command: null,
          ...data,
        };
        servers.push(row);
        return row;
      }),
    },
    botMcpServer: {
      findMany: vi.fn(async () => assignments),
      createMany: vi.fn(async ({ data }) => {
        for (const row of data)
          if (!assignments.some((a) => a.botId === row.botId && a.serverId === row.serverId))
            assignments.push({ id: `assignment-${assignmentSequence++}`, ...row });
        return { count: data.length };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = assignments.find(
          (a) =>
            a.id === where.id &&
            a.allowAllTools === where.allowAllTools &&
            JSON.stringify(a.allowedTools) === JSON.stringify(where.allowedTools.equals),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    capabilityInstall: {
      findFirst: vi.fn(
        async ({ where }) =>
          presets.find(
            (row) =>
              row.id === where.id &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              row.kind === where.kind &&
              row.source === where.source,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        presets.push(data);
        return data;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = presets.find((p) => p.id === where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  native.bot.mockImplementation(async (_tx, _actor, input) => {
    const bot = {
      id: `bot-${botSequence++}`,
      disabledBuiltinTools: [],
      ...input,
      archivedAt: null,
    };
    bots.push(bot);
    return bot;
  });
  native.group.mockImplementation(async (_tx, _actor, input) => {
    group = {
      id: input.id,
      userId: actor.userId,
      spaceId: actor.spaceId,
      name: input.name,
      archivedAt: null,
      thread: { id: "crew-thread" },
      members: input.botIds.map((botId: string) => ({ botId })),
    };
    return group;
  });
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    capabilityInstall: tx.capabilityInstall,
  } as unknown as PrismaClient;
  return {
    prisma,
    tx,
    bots,
    servers,
    assignments,
    presets,
    busy: () => {
      busy = true;
    },
    getGroup: () => group,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "0");
});
afterEach(() => vi.unstubAllEnvs());

describe("ensureRecruitingWorkspace", () => {
  it("creates one private four-specialist crew atomically with platform defaults and no credentials or schedules", async () => {
    const f = fixture();
    const result = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      sandboxKind: "fake",
    });
    expect(native.bot.mock.calls.map(([, , input]) => input.name)).toEqual([
      "Main",
      "Sourcer",
      "Outreach",
      "Scheduling",
    ]);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      native.bot.mock.calls.every(
        ([tx, who, input]) =>
          tx === f.tx && who === actor && !input.modelProvider && !input.modelId,
      ),
    ).toBe(true);
    expect(native.group).toHaveBeenCalledWith(
      f.tx,
      actor,
      expect.objectContaining({ botIds: f.bots.map((bot) => bot.id) }),
    );
    expect(result).toEqual({ botId: f.bots[0]!.id, groupId: f.getGroup()!.id });
    expect(f.tx.space.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: actor.spaceId, createdByUserId: actor.userId }),
      }),
    );
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        endpoint: "https://api.autumn.ai/mcp",
        secretId: undefined,
      }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [0, 1].map((index) =>
        expect.objectContaining({
          botId: f.bots[index]!.id,
          allowAllTools: false,
          allowedTools: ["credits", "research", "get_task", "get_rows", "reply", "stop_task"],
        }),
      ),
      skipDuplicates: true,
    });
  });

  it("gives fresh Main and Outreach only scoped FullEnrich tools without copying credentials", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: "fullenrich",
        endpoint: "https://mcp.fullenrich.com/mcp",
        secretId: undefined,
      }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [0, 2].map((index) =>
        expect.objectContaining({
          botId: f.bots[index]!.id,
          serverId: "fullenrich-a",
          allowAllTools: false,
          allowedTools: ["get_credits", "enrich_bulk", "get_enrichment_results"],
        }),
      ),
      skipDuplicates: true,
    });
    f.tx.botMcpServer.createMany.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });

  it("reuses an existing product crew without overwriting private instructions, membership or names", async () => {
    const f = fixture();
    const first = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      sandboxKind: "fake",
    });
    f.bots[0]!.instructions = "My private instructions";
    f.tx.mcpServer.create.mockClear();
    f.tx.botMcpServer.createMany.mockClear();
    const again = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      sandboxKind: "fake",
    });
    expect(again).toEqual(first);
    expect(native.bot).toHaveBeenCalledTimes(4);
    expect(native.group).toHaveBeenCalledTimes(1);
    expect(f.bots[0]!.instructions).toBe("My private instructions");
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });

  it("establishes fresh service access before a platform key exists, without repairing it on repeat", async () => {
    const f = fixture();
    const options = { sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        endpoint: "https://api.autumn.ai/mcp",
        secretId: undefined,
      }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledTimes(2);
    f.tx.botMcpServer.createMany.mockClear();
    f.tx.mcpServer.create.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });

  it("rejects shared or foreign Spaces before creating any agents", async () => {
    const f = fixture();
    f.tx.space.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        sandboxKind: "fake",
      }),
    ).rejects.toThrow();
    expect(native.bot).not.toHaveBeenCalled();
    expect(native.group).not.toHaveBeenCalled();
  });

  it("does not add defaults to an existing non-product workspace or revive archived defaults", async () => {
    const f = fixture();
    f.bots.push({
      id: "custom",
      name: "Custom",
      title: "",
      description: "",
      spawnKey: "private",
      instructions: "Keep",
      disabledBuiltinTools: [],
      archivedAt: null,
    });
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        sandboxKind: "fake",
      }),
    ).rejects.toThrow();
    expect(native.bot).not.toHaveBeenCalled();
  });

  it("does not revive an archived product workspace", async () => {
    const f = fixture();
    const options = { sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.getGroup()!.archivedAt = new Date();
    await expect(recruiting.ensureRecruitingWorkspace(f.prisma, actor, options)).rejects.toThrow();
    expect(native.bot).toHaveBeenCalledTimes(4);
  });

  it("does not replace a customized Autumn endpoint during fresh setup", async () => {
    const f = fixture();
    f.tx.mcpServer.findFirst.mockResolvedValueOnce({
      id: "private-autumn",
      endpoint: "https://example.test/mcp",
      transport: "streamable_http",
    } as never);
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        sandboxKind: "fake",
      }),
    ).rejects.toThrow("customized");
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });

  it("does not restore a deliberately removed Autumn assignment on repeat setup", async () => {
    const f = fixture();
    const options = { sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.tx.botMcpServer.createMany.mockClear();
    f.tx.mcpServer.create.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" }),
    );
  });

  it("does not overwrite a customized FullEnrich endpoint during fresh setup", async () => {
    const f = fixture();
    f.tx.mcpServer.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "private-contact-service",
      endpoint: "https://custom.example.test/mcp",
      transport: "streamable_http",
    } as never);
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" }),
    ).rejects.toThrow("FullEnrich connection is customized");
    expect(f.tx.mcpServer.create.mock.calls.some(([{ data }]) => data.slug === "fullenrich")).toBe(
      false,
    );
    expect(
      f.tx.botMcpServer.createMany.mock.calls.every(([{ data }]) =>
        data.every(
          (row: Pick<AssignmentRow, "serverId">) => row.serverId !== "private-contact-service",
        ),
      ),
    ).toBe(true);
  });

  it("propagates native group creation failure from the same transaction before assigning services", async () => {
    const f = fixture();
    native.group.mockRejectedValueOnce(new Error("group write failed"));
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        sandboxKind: "fake",
      }),
    ).rejects.toThrow("group write failed");
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(native.bot.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });
});

describe("managed recruiting default upgrades", () => {
  const options = { sandboxKind: "fake" };
  async function previous() {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const state = f.presets[0]!.config as ManagedState;
    f.bots[0]!.instructions = "Earlier maintained instructions";
    state.bots.main!.fields.instructions = hash(f.bots[0]!.instructions);
    f.presets[0]!.digest = "earlier-release";
    return { ...f, state };
  }
  it("records fresh defaults atomically without raw instructions, credentials or model pins", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.presets).toHaveLength(1);
    expect(f.presets[0]).toMatchObject({
      kind: "plugin",
      source: "builtin:recruiting",
      version: "1",
    });
    expect(f.tx.capabilityInstall.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      native.group.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(f.presets[0]!.config)).not.toContain(f.bots[0]!.instructions);
    expect(JSON.stringify(f.presets[0]!.config)).not.toMatch(/secretId|modelId|ciphertext/);
  });
  it("updates only unchanged managed fields, keeps personal fields and becomes idempotent", async () => {
    const f = await previous();
    f.bots[0]!.name = "My recruiting partner";
    f.bots[0]!.modelId = "my-personal-model";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.bots[0]!.instructions).not.toBe("Earlier maintained instructions");
    expect(f.bots[0]!.name).toBe("My recruiting partner");
    expect(f.bots[0]!.modelId).toBe("my-personal-model");
    f.tx.bot.updateMany.mockClear();
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
  });
  it("does not overwrite private instructions or restore removed bots, assignments, connections or group members", async () => {
    const f = await previous();
    f.bots[0]!.instructions = "My private instructions";
    const removedBot = f.bots.splice(1, 1)[0]!;
    f.getGroup()!.members = f.getGroup()!.members.filter((m) => m.botId !== removedBot.id);
    f.assignments.splice(0, 1);
    f.servers.splice(1, 1);
    const before = JSON.stringify({
      bots: f.bots,
      assignments: f.assignments,
      servers: f.servers,
      group: f.getGroup(),
    });
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(
      JSON.stringify({
        bots: f.bots,
        assignments: f.assignments,
        servers: f.servers,
        group: f.getGroup(),
      }),
    ).toBe(before);
  });
  it.each(["queued", "leased", "running", "waiting_input", "waiting_takeover"])(
    "defers upgrades while an existing %s task could reload configuration",
    async (status) => {
      const f = await previous();
      f.busy();
      const before = JSON.stringify(f.presets);
      await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      expect(f.bots[0]!.instructions).toBe("Earlier maintained instructions");
      expect(JSON.stringify(f.presets)).toBe(before);
      expect(f.tx.run.count).toHaveBeenCalledWith({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          status: { in: expect.arrayContaining([status]) },
        },
      });
    },
  );
  it("does not adopt a legacy workspace or create content from the update-only entrypoint", async () => {
    const f = fixture();
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(native.bot).not.toHaveBeenCalled();
    expect(f.presets).toHaveLength(0);
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.presets.splice(0);
    f.bots[0]!.instructions = "Private legacy instructions";
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.presets[0]).toMatchObject({ version: "unmanaged" });
    expect(f.bots[0]!.instructions).toBe("Private legacy instructions");
  });
  it("adds a newly maintained service only in unchanged managed scope, retaining revocation history", async () => {
    const f = await previous();
    delete f.state.services.fullenrich;
    f.servers.splice(1, 1);
    for (let i = f.assignments.length - 1; i >= 0; i--)
      if (f.assignments[i]!.serverId === "fullenrich-a") f.assignments.splice(i, 1);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.servers.some((s) => s.slug === "fullenrich")).toBe(true);
    expect(f.assignments.filter((a) => a.serverId === "fullenrich-a")).toHaveLength(2);
  });
});

describe("managed recruiting computer policy", () => {
  const disabled = [
    "computer_observe",
    "computer_act",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "open_path",
    "launch_app",
    "request_takeover",
    "request_secret",
  ];
  const options = { sandboxKind: "fake" };
  it.each(["fresh", "new-role"])(
    "disables computer and website login tools on %s managed roles",
    async (stage) => {
      const f = fixture();
      await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      if (stage === "new-role") {
        const removed = f.bots.pop()!;
        const baseline = f.presets[0]!.config as ManagedState;
        delete baseline.bots.scheduling;
        f.getGroup()!.members = f
          .getGroup()!
          .members.filter((member) => member.botId !== removed.id);
        baseline.members = f.getGroup()!.members.map((member) => member.botId);
        f.presets[0]!.digest = "before-new-role";
        await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      }
      expect(f.bots).toHaveLength(4);
      for (const bot of f.bots) expect(bot.disabledBuiltinTools).toEqual(disabled);
    },
  );
  it("unions the policy into all four managed roles without overwriting private fields or rebuilding on repeat", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    for (const bot of f.bots) {
      bot.disabledBuiltinTools = ["save_shared_memory"];
      bot.instructions = `Private instructions for ${bot.id}`;
      bot.modelId = "private-model";
    }
    const unrelated = {
      ...f.bots[0]!,
      id: "unmanaged",
      spawnKey: "private",
      disabledBuiltinTools: [],
    };
    f.bots.push(unrelated);
    f.presets[0]!.digest = "before-computer-policy";
    const assignments = JSON.stringify(f.assignments);
    f.tx.bot.updateMany.mockClear();
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    for (const bot of f.bots.slice(0, 4)) {
      expect(bot.disabledBuiltinTools).toEqual(["save_shared_memory", ...disabled]);
      expect(bot.instructions).toBe(`Private instructions for ${bot.id}`);
      expect(bot.modelId).toBe("private-model");
    }
    expect(unrelated.disabledBuiltinTools).toEqual([]);
    expect(f.tx.bot.updateMany).toHaveBeenCalledTimes(4);
    f.tx.bot.updateMany.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
    expect(native.bot).toHaveBeenCalledTimes(4);
    expect(native.group).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.assignments)).toBe(assignments);
  });
});

it("upgrades exact managed tool sets without changing a user-replaced assignment", async () => {
  const f = fixture();
  const options = { sandboxKind: "fake" };
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
  const state = f.presets[0]!.config as ManagedState;
  f.assignments[0]!.allowedTools = ["research"];
  state.services.autumn!.assignments.main!.signature = hash([false, ["research"]]);
  f.assignments[1]!.allowedTools = ["credits"];
  f.presets[0]!.digest = "previous-release";
  await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
  expect(f.assignments[0]!.allowedTools).toEqual([
    "credits",
    "research",
    "get_task",
    "get_rows",
    "reply",
    "stop_task",
  ]);
  expect(f.assignments[1]!.allowedTools).toEqual(["credits"]);
  expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: f.assignments[0]!.id,
        allowedTools: { equals: ["research"] },
      }),
    }),
  );
});

it("adds a new maintained role using the configured native sandbox, without reviving an archived one", async () => {
  const f = fixture();
  const options = { sandboxKind: "docker" };
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
  const state = f.presets[0]!.config as ManagedState;
  const removed = f.bots.splice(2, 1)[0]!;
  delete state.bots.outreach;
  delete state.services.fullenrich!.assignments.outreach;
  f.getGroup()!.members = f.getGroup()!.members.filter((row) => row.botId !== removed.id);
  state.members = state.members.filter((id) => id !== removed.id);
  for (let i = f.assignments.length - 1; i >= 0; i--)
    if (f.assignments[i]!.botId === removed.id) f.assignments.splice(i, 1);
  f.bots[1]!.archivedAt = new Date();
  f.presets[0]!.digest = "previous-release";
  f.tx.deploymentSettings.findUnique.mockResolvedValue({ computerHost: "this-mac" });
  await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
  expect(native.bot).toHaveBeenLastCalledWith(
    f.tx,
    actor,
    expect.objectContaining({ name: "Outreach" }),
    "desktop",
  );
  expect(native.bot).toHaveBeenCalledTimes(5);
  expect(f.bots[1]!.archivedAt).not.toBeNull();
  expect(f.assignments.filter((row) => row.serverId === "fullenrich-a")).toHaveLength(2);
});

it("does not resurrect a deleted managed workspace or apply another actor's ledger", async () => {
  const f = fixture();
  const options = { sandboxKind: "fake" };
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
  f.presets[0]!.digest = "previous-release";
  const calls = f.tx.bot.updateMany.mock.calls.length;
  await recruiting.upgradeRecruitingWorkspace(
    f.prisma,
    { ...actor, userId: "another-person" },
    options,
  );
  await recruiting.upgradeRecruitingWorkspace(
    f.prisma,
    { ...actor, spaceId: "another-space" },
    options,
  );
  expect(f.tx.bot.updateMany.mock.calls).toHaveLength(calls);
  f.tx.chatGroup.findFirst.mockResolvedValue(null);
  f.bots.splice(0);
  await expect(recruiting.ensureRecruitingWorkspace(f.prisma, actor, options)).rejects.toThrow(
    "removed",
  );
  expect(native.bot).toHaveBeenCalledTimes(4);
});

it("preserves a simultaneous private edit when the native field compare-and-set loses", async () => {
  const f = fixture();
  const options = { sandboxKind: "fake" };
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
  const state = f.presets[0]!.config as ManagedState;
  f.bots[0]!.instructions = "Earlier maintained instructions";
  state.bots.main!.fields.instructions = hash(f.bots[0]!.instructions);
  f.presets[0]!.digest = "previous-release";
  f.tx.bot.updateMany.mockImplementationOnce(async ({ where }) => {
    expect(where.instructions).toBe("Earlier maintained instructions");
    f.bots[0]!.instructions = "Concurrent private edit";
    return { count: 0 };
  });
  await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
  expect(f.bots[0]!.instructions).toBe("Concurrent private edit");
  expect((f.presets[0]!.config as ManagedState).bots.main!.fields.instructions).toBe(
    hash("Earlier maintained instructions"),
  );
});

it.each(["chat_groups", "threads", "mcp_servers", "bot_mcp_servers", "bots"])(
  "defers the entire upgrade without mutations when %s has a concurrently locked row",
  async (table) => {
    const f = fixture();
    const options = { sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const state = f.presets[0]!.config as ManagedState;
    f.bots[0]!.instructions = "Earlier maintained instructions";
    state.bots.main!.fields.instructions = hash(f.bots[0]!.instructions);
    f.presets[0]!.digest = "previous-release";
    const before = JSON.stringify({ bots: f.bots, assignments: f.assignments, presets: f.presets });
    f.tx.bot.updateMany.mockClear();
    f.tx.botMcpServer.updateMany.mockClear();
    f.tx.botMcpServer.createMany.mockClear();
    f.tx.capabilityInstall.updateMany.mockClear();
    f.tx.$queryRaw.mockImplementation(async (query) => [
      { complete: !query.sql.includes(`FROM ${table}\n`) },
    ]);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(JSON.stringify({ bots: f.bots, assignments: f.assignments, presets: f.presets })).toBe(
      before,
    );
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
    expect(f.tx.botMcpServer.updateMany).not.toHaveBeenCalled();
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(f.tx.capabilityInstall.updateMany).not.toHaveBeenCalled();
  },
);

it("defers before writes when native computer quota maintenance already holds its user lock", async () => {
  const f = fixture();
  const options = { sandboxKind: "fake" };
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
  const state = f.presets[0]!.config as ManagedState;
  f.bots[0]!.instructions = "Earlier maintained instructions";
  state.bots.main!.fields.instructions = hash(f.bots[0]!.instructions);
  delete state.bots.outreach;
  f.presets[0]!.digest = "previous-release";
  const before = JSON.stringify({ bots: f.bots, assignments: f.assignments, presets: f.presets });
  vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
  try {
    f.tx.$queryRaw.mockImplementation(async () => [{ complete: true, acquired: false }]);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(JSON.stringify({ bots: f.bots, assignments: f.assignments, presets: f.presets })).toBe(
      before,
    );
    expect(native.bot).toHaveBeenCalledTimes(4);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("managed first-party recruiting CRM installation", () => {
  const endpoint = "https://crm.example.test/mcp";
  const options = { sandboxKind: "fake", firstPartyMcpUrl: endpoint };
  it("installs Main eleven tools and Sourcer eight reads without copying credentials or changing the four native agents", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const server = f.servers.find((row) => row.slug === "recruiting-crm");
    expect(server).toMatchObject({ endpoint, transport: "streamable_http" });
    expect(server?.secretId).toBeUndefined();
    expect(f.bots).toHaveLength(4);
    const assignments = f.assignments.filter((row) => row.serverId === server!.id);
    expect(assignments).toHaveLength(2);
    const main = assignments.find((row) => row.botId === f.bots[0]!.id)!;
    const sourcer = assignments.find((row) => row.botId === f.bots[1]!.id)!;
    expect(main.allowedTools).toEqual([
      "whoami",
      "list_crm_memberships",
      "list_crm_candidates",
      "get_crm_role",
      "get_crm_candidate_source_context",
      "get_crm_candidate_review",
      "list_crm_candidate_messages",
      "list_crm_roles",
      "crm_import_candidate",
      "list_crm_candidate_roles",
      "list_crm_candidate_correspondence",
    ]);
    expect(sourcer.allowedTools).toEqual(main.allowedTools.slice(0, 8));
    expect(assignments.every((row) => row.allowAllTools === false)).toBe(true);
  });
  it.each(["managed", "restricted", "removed"] as const)(
    "upgrades the CRM correspondence read only for an unchanged managed assignment: %s",
    async (state) => {
      const f = fixture();
      await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      const baseline = f.presets[0]!.config as ManagedState;
      const server = f.servers.find((row) => row.slug === "recruiting-crm")!;
      const assignments = f.assignments.filter((row) => row.serverId === server.id);
      const main = assignments.find((row) => row.botId === f.bots[0]!.id)!;
      const sourcer = assignments.find((row) => row.botId === f.bots[1]!.id)!;
      for (const [key, assignment] of [
        ["main", main],
        ["sourcer", sourcer],
      ] as const) {
        assignment.allowedTools = assignment.allowedTools.filter(
          (tool) => tool !== "list_crm_candidate_correspondence",
        );
        baseline.services["recruiting-crm"]!.assignments[key]!.signature = hash([
          false,
          assignment.allowedTools,
        ]);
      }
      if (state === "restricted") main.allowedTools = [];
      if (state === "removed") f.assignments.splice(f.assignments.indexOf(main), 1);
      f.presets[0]!.digest = "previous-correspondence-defaults";
      await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      expect(sourcer.allowedTools).toHaveLength(8);
      expect(sourcer.allowedTools).not.toContain("list_crm_candidate_correspondence");
      if (state === "managed")
        expect(main.allowedTools).toContain("list_crm_candidate_correspondence");
      else if (state === "restricted") expect(main.allowedTools).toEqual([]);
      else
        expect(
          f.assignments.some((row) => row.botId === main.botId && row.serverId === server.id),
        ).toBe(false);
    },
  );
  it("adds the newly configured native service to an unchanged managed crew, preserving revocations on subsequent upgrades", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    const server = f.servers.find((row) => row.slug === "recruiting-crm")!;
    expect(server).toBeDefined();
    const main = f.assignments.find(
      (row) => row.serverId === server.id && row.botId === f.bots[0]!.id,
    )!;
    expect(main.allowedTools).toHaveLength(11);
    main.allowedTools = [];
    const installed = f.presets[0]!;
    installed.digest = "changed-catalog";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(main.allowedTools).toEqual([]);
    f.servers.splice(f.servers.indexOf(server), 1);
    installed.digest = "changed-again";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.servers.some((row) => row.slug === "recruiting-crm")).toBe(false);
  });
  it.each(["fresh", "upgrade"])(
    "preserves a private same-slug connection during %s setup without adopting or assigning it",
    async (stage) => {
      const f = fixture();
      if (stage === "upgrade")
        await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
      const privateServer = {
        id: "private-crm",
        slug: "recruiting-crm",
        endpoint,
        transport: "streamable_http",
        secretId: "private-secret",
        enabled: true,
        revision: 1,
        args: [],
        headers: {},
        env: {},
        command: null,
      };
      f.servers.push(privateServer);
      if (stage === "upgrade")
        await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      else await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      expect(f.servers.find((row) => row.id === privateServer.id)).toEqual(privateServer);
      expect(f.assignments.some((row) => row.serverId === privateServer.id)).toBe(false);
      expect((f.presets[0]!.config as ManagedState).services["recruiting-crm"]).toBeUndefined();
    },
  );
  it("defers the new service upgrade while an original crew run is active", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    const before = structuredClone(f.presets[0]);
    f.busy();
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.servers).toHaveLength(2);
    expect(f.presets[0]).toEqual(before);
  });
});
