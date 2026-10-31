import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { memoryTidyRoutineCron, RECRUITING_DEFAULT_BOTS } from "@rakazo/core";
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
type RoutineRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  notify: boolean;
  active: boolean;
  nextRunAt: Date;
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
  const routines: RoutineRow[] = [];
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
  const globalGroups = new Map<
    string,
    {
      id: string;
      userId: string;
      spaceId: string;
      name: string;
      archivedAt: Date | null;
      thread: { id: string };
      members: { botId: string }[];
    }
  >();
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
      findFirst: vi.fn(async ({ where }) => {
        const found = where.id?.startsWith("recruiting-global-")
          ? globalGroups.get(where.id)
          : group;
        return found ? { ...found, members: found.members.map((member) => ({ ...member })) } : null;
      }),
      count: vi.fn(async () => (group ? 1 : 0)),
    },
    chatGroupMember: {
      createMany: vi.fn(async ({ data }) => {
        group!.members.push(...data.map((row: { botId: string }) => ({ botId: row.botId })));
        return { count: data.length };
      }),
    },
    routine: {
      findFirst: vi.fn(
        async ({ where }) =>
          routines.find(
            (row) =>
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              row.botId === where.botId &&
              row.name === where.name,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        const row = { id: `routine-${routines.length}`, ...data };
        routines.push(row);
        return row;
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
    const created = {
      id: input.id,
      userId: actor.userId,
      spaceId: actor.spaceId,
      name: input.name,
      archivedAt: null,
      thread: { id: "crew-thread" },
      members: input.botIds.map((botId: string) => ({ botId })),
    };
    if (input.id?.startsWith("recruiting-global-")) globalGroups.set(input.id, created);
    else group = created;
    return created;
  });
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    capabilityInstall: tx.capabilityInstall,
    bot: tx.bot,
  } as unknown as PrismaClient;
  return {
    prisma,
    tx,
    bots,
    servers,
    assignments,
    presets,
    routines,
    busy: () => {
      busy = true;
    },
    getGroup: () => group,
    globalGroups,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "0");
});
afterEach(() => vi.unstubAllEnvs());

describe("ensureRecruitingWorkspace", () => {
  it("creates one private five-specialist crew atomically with platform defaults and no credentials or schedules", async () => {
    const f = fixture();
    const result = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      sandboxKind: "fake",
    });
    expect(native.bot.mock.calls.map(([, , input]) => input.name)).toEqual([
      "Main",
      "Sourcer",
      "Outreach",
      "Scheduling",
      "Reviewer",
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
      data: [
        ...[0, 1].map((index) =>
          expect.objectContaining({
            botId: f.bots[index]!.id,
            allowAllTools: false,
            allowedTools: ["credits", "research", "get_task", "get_rows", "reply", "stop_task"],
          }),
        ),
        // The quality check only starts grading and reads its rows.
        expect.objectContaining({
          botId: f.bots[4]!.id,
          allowAllTools: false,
          allowedTools: ["credits", "research", "get_task", "get_rows"],
        }),
      ],
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
    expect(native.bot).toHaveBeenCalledTimes(5);
    expect(native.group).toHaveBeenCalledTimes(2);
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
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledTimes(3);
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

  it("adds the private global defaults beside an existing custom conversation without changing it", async () => {
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
    const custom = structuredClone(f.bots[0]);
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    expect(f.bots.find((bot) => bot.id === "custom")).toEqual(custom);
    expect(native.bot).toHaveBeenCalledTimes(5);
    expect(native.group).toHaveBeenCalledWith(
      f.tx,
      actor,
      expect.objectContaining({ id: recruiting.recruitingGlobalGroupId(actor), name: "Main" }),
    );
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    expect(native.bot).toHaveBeenCalledTimes(5);
  });

  it("does not revive an archived product workspace", async () => {
    const f = fixture();
    const options = { sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.getGroup()!.archivedAt = new Date();
    await expect(recruiting.ensureRecruitingWorkspace(f.prisma, actor, options)).rejects.toThrow();
    expect(native.bot).toHaveBeenCalledTimes(5);
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

describe("recruiting bootstrap idempotency and per-user identity", () => {
  const options = { sandboxKind: "fake", firstPartyMcpUrl: "https://crm.example.test/mcp" };
  const snapshot = (f: ReturnType<typeof fixture>) =>
    JSON.stringify({
      bots: f.bots,
      servers: f.servers,
      assignments: f.assignments,
      presets: f.presets,
      group: f.getGroup(),
    });

  it("creates the crew, connections and assignments once; login repeats and upgrades change nothing", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const counts = [f.bots.length, f.servers.length, f.assignments.length, f.presets.length];
    expect(counts[0]).toBe(5);
    expect(counts[3]).toBe(1);
    const before = snapshot(f);
    for (let login = 0; login < 3; login++) {
      await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    }
    expect([f.bots.length, f.servers.length, f.assignments.length, f.presets.length]).toEqual(
      counts,
    );
    expect(snapshot(f)).toBe(before);
    expect(native.bot).toHaveBeenCalledTimes(5);
    expect(native.group).toHaveBeenCalledTimes(2);
  });

  it("keeps private edits and removed grants across repeated login and upgrade", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.bots[1]!.instructions = "My own sourcing rules";
    f.assignments.splice(0, 1);
    const before = snapshot(f);
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(snapshot(f)).toBe(before);
  });

  it("derives a different group, preset and bot identity for every user and Space", async () => {
    const other: Actor = { ...actor, userId: "person-b", spaceId: "personal-b" };
    // fixture() binds the shared native mocks, so build and run each user in turn.
    const a = fixture();
    const first = await recruiting.ensureRecruitingWorkspace(a.prisma, actor, options);
    const b = fixture();
    const second = await recruiting.ensureRecruitingWorkspace(b.prisma, other, options);
    expect(first.groupId).not.toBe(second.groupId);
    expect(recruiting.recruitingPresetId(actor)).not.toBe(recruiting.recruitingPresetId(other));
    expect(a.presets[0]!.userId).toBe(actor.userId);
    expect(b.presets[0]!.userId).toBe(other.userId);
    const keys = [...a.bots, ...b.bots].map((bot) => bot.spawnKey);
    expect(new Set(keys).size).toBe(10);
    expect(a.bots.every((bot) => bot.spawnKey.includes(actor.userId))).toBe(true);
    expect(b.bots.every((bot) => bot.spawnKey.includes(other.userId))).toBe(true);
    expect(JSON.stringify(a.presets)).not.toContain(other.userId);
  });

  it("copies no chat history or admin data into a new user's crew", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    for (const [, , input] of native.bot.mock.calls)
      expect(Object.keys(input).sort()).toEqual(
        [
          "color",
          "description",
          // PR #5 managed defaults carry the computer/login denylist; still no chat or admin data.
          "disabledBuiltinTools",
          "instructions",
          "name",
          "notifyOnFinish",
          "spawnKey",
          "title",
        ].sort(),
      );
    expect(Object.keys(native.group.mock.calls[0]![2]).sort()).toEqual(["botIds", "id", "name"]);
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
        delete baseline.bots.reviewer;
        f.getGroup()!.members = f
          .getGroup()!
          .members.filter((member) => member.botId !== removed.id);
        baseline.members = f.getGroup()!.members.map((member) => member.botId);
        f.presets[0]!.digest = "before-new-role";
        await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      }
      expect(f.bots).toHaveLength(5);
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
    expect(f.tx.bot.updateMany).toHaveBeenCalledTimes(5);
    f.tx.bot.updateMany.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.bot.updateMany).not.toHaveBeenCalled();
    expect(native.bot).toHaveBeenCalledTimes(5);
    expect(native.group).toHaveBeenCalledTimes(2);
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
  expect(native.bot).toHaveBeenCalledTimes(6);
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
  expect(native.bot).toHaveBeenCalledTimes(5);
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
    expect(native.bot).toHaveBeenCalledTimes(5);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("managed first-party recruiting CRM installation", () => {
  const endpoint = "https://crm.example.test/mcp";
  const options = { sandboxKind: "fake", firstPartyMcpUrl: endpoint };
  it("installs Main twelve tools and Sourcer eight reads without copying credentials or changing the four native agents", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const server = f.servers.find((row) => row.slug === "recruiting-crm");
    expect(server).toMatchObject({ endpoint, transport: "streamable_http" });
    expect(server?.secretId).toBeUndefined();
    expect(f.bots).toHaveLength(5);
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
      "list_crm_role_correspondence",
    ]);
    expect(sourcer.allowedTools).toEqual(main.allowedTools.slice(0, 8));
    expect(assignments.every((row) => row.allowAllTools === false)).toBe(true);
  });
  it.each(["managed", "restricted", "customized", "removed"] as const)(
    "adds required role mail only to unchanged managed Main: %s",
    async (state) => {
      const f = fixture();
      await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      const baseline = f.presets[0]!.config as ManagedState;
      const server = f.servers.find((row) => row.slug === "recruiting-crm")!;
      const main = f.assignments.find(
        (row) => row.serverId === server.id && row.botId === f.bots[0]!.id,
      )!;
      const sourcer = f.assignments.find(
        (row) => row.serverId === server.id && row.botId === f.bots[1]!.id,
      )!;
      main.allowedTools = main.allowedTools.filter(
        (tool) => tool !== "list_crm_role_correspondence",
      );
      baseline.services["recruiting-crm"]!.assignments.main!.signature = hash([
        false,
        main.allowedTools,
      ]);
      if (state === "restricted") main.allowedTools = [];
      if (state === "customized") main.allowedTools = ["get_crm_role"];
      if (state === "removed") f.assignments.splice(f.assignments.indexOf(main), 1);
      const before = [...main.allowedTools];
      f.presets[0]!.digest = "previous-role-mail-defaults";
      await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
      expect(sourcer.allowedTools).not.toContain("list_crm_role_correspondence");
      if (state === "managed") expect(main.allowedTools).toContain("list_crm_role_correspondence");
      else if (state === "removed") expect(f.assignments).not.toContain(main);
      else expect(main.allowedTools).toEqual(before);
    },
  );
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
    expect(main.allowedTools).toHaveLength(12);
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
    expect(f.servers).toHaveLength(3);
    expect(f.presets[0]).toEqual(before);
  });
});

describe("crews set up before the recruiting preset", () => {
  const options = { sandboxKind: "fake" };
  const AUTUMN = "https://api.autumn.ai/mcp";
  function legacy() {
    const f = fixture();
    const updated = new Date("2026-10-01T00:00:00Z");
    for (const name of ["Main", "Sourcer", "Outreach", "Scheduling"])
      f.bots.push({
        id: `old-${name.toLowerCase()}`,
        spawnKey: name === "Main" ? "onboarding:first" : "",
        name,
        title: "",
        description: "",
        instructions: `Old ${name} instructions`,
        disabledBuiltinTools: [],
        archivedAt: null,
        updatedAt: updated,
      } as BotRow);
    f.servers.push({
      id: "old-autumn",
      slug: "autumn",
      endpoint: AUTUMN,
      transport: "streamable_http",
      enabled: true,
      revision: 1,
      args: [],
      headers: {},
      env: {},
      command: null,
    });
    f.assignments.push(
      {
        id: "a1",
        botId: "old-main",
        serverId: "old-autumn",
        allowAllTools: false,
        allowedTools: [],
      },
      {
        id: "a2",
        botId: "old-sourcer",
        serverId: "old-autumn",
        allowAllTools: false,
        allowedTools: [],
      },
    );
    const skills = [
      {
        id: "s1",
        name: "Recruitment intake and handoff",
        description: "old",
        content: "Old intake",
        source: "user",
      },
      { id: "s2", name: "My own notes", description: "mine", content: "Keep", source: "user" },
    ];
    const roleGroup = { id: "old-role", members: [{ botId: "old-main" }] };
    (f.tx.chatGroup.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id ? null : roleGroup),
    );
    Object.assign(f.tx, {
      agentSkill: {
        deleteMany: vi.fn(async ({ where }: { where: { name: { in: string[] } } }) => {
          const names = where.name.in.map((name) => name.toLowerCase());
          for (let i = skills.length - 1; i >= 0; i--)
            if (names.includes(skills[i]!.name.toLowerCase())) skills.splice(i, 1);
          return { count: 1 };
        }),
      },
    });
    f.tx.bot.updateMany.mockImplementation(async ({ where, data }) => {
      const bot = f.bots.find((row) => row.id === where.id) as BotRow & { updatedAt: Date };
      if (!bot || bot.updatedAt !== where.updatedAt) return { count: 0 };
      Object.assign(bot, data, { updatedAt: new Date() });
      return { count: 1 };
    });
    (f.tx.chatGroup as unknown as { count: unknown }).count = vi.fn(async () => 0);
    Object.assign(f.tx.chatGroupMember, {
      count: vi.fn(async () => roleGroup.members.length),
      createMany: vi.fn(async ({ data }: { data: Array<{ botId: string }> }) => {
        roleGroup.members.push(...data.map((row) => ({ botId: row.botId })));
        return { count: data.length };
      }),
    });
    return { ...f, skills, roleGroup };
  }

  it("returns the existing crew instead of failing, and brings it to the defaults", async () => {
    const f = legacy();
    const result = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(result).toEqual({ botId: "old-main", groupId: "old-role" });
    // Only the role added after these crews were set up joins, with its research tools.
    expect(native.bot.mock.calls.map(([, , input]) => input.name)).toEqual(["Reviewer"]);
    const reviewer = f.bots.find((bot) => bot.name === "Reviewer")!;
    expect(f.roleGroup.members).toContainEqual({ botId: reviewer.id });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          botId: reviewer.id,
          serverId: "old-autumn",
          allowedTools: ["credits", "research", "get_task", "get_rows"],
        }),
      ],
      skipDuplicates: true,
    });
    const main = f.bots.find((bot) => bot.id === "old-main")!;
    expect(main.instructions).toBe(
      RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!.instructions,
    );
    expect(main.name).toBe("Main");
    expect(main.disabledBuiltinTools).toContain("request_secret");
    expect(f.skills.map((skill) => skill.name)).toEqual(["My own notes"]);
    expect(f.presets[0]).toMatchObject({
      version: "legacy",
      config: { legacy: true, added: ["reviewer"] },
    });
  });

  it("adds a new role once and never brings a deleted one back", async () => {
    const f = legacy();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const reviewer = f.bots.find((bot) => bot.name === "Reviewer")!;
    reviewer.archivedAt = new Date();
    f.presets[0]!.digest = "older catalog";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(native.bot).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and applies later default changes", async () => {
    const f = legacy();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const main = f.bots.find((bot) => bot.id === "old-main")!;
    main.instructions = "Edited";
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(main.instructions).toBe("Edited");
    f.presets[0]!.digest = "older catalog";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(main.instructions).toBe(
      RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!.instructions,
    );
  });

  it("upgrades on sign-in too, and waits while a run is active", async () => {
    const f = legacy();
    f.busy();
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.bots.find((bot) => bot.id === "old-main")!.instructions).toBe("Old Main instructions");
    expect(f.presets).toHaveLength(0);
  });

  it("does not wait for a turn paused on a question or approval card", async () => {
    const f = legacy();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    const main = f.bots.find((bot) => bot.id === "old-main")!;
    main.instructions = "Older defaults";
    f.presets[0]!.digest = "older catalog";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(main.instructions).toBe(
      RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!.instructions,
    );
    expect(f.tx.run.count).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        status: { in: ["queued", "leased", "running"] },
      },
    });
  });

  it("does not adopt a crew without the platform research service", async () => {
    const f = legacy();
    f.assignments.splice(0);
    const original = f.bots.map((bot) => structuredClone(bot));
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    for (const bot of original)
      expect(f.bots.find((current) => current.id === bot.id)).toEqual(bot);
    expect(f.bots.find((bot) => bot.id === "old-main")!.instructions).toBe("Old Main instructions");
    expect(native.bot).toHaveBeenCalledTimes(5);
    const global = native.group.mock.calls.find(
      ([, , input]) => input.id === recruiting.recruitingGlobalGroupId(actor),
    )?.[2];
    expect(global.botIds).not.toContain("old-main");
  });

  it("gives the adopted crew one nightly memory tidy per bot, once", async () => {
    const f = legacy();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.routines.map((row) => row.botId)).toEqual([
      "old-main",
      "old-sourcer",
      "old-outreach",
      "old-scheduling",
      f.bots.find((bot) => bot.name === "Reviewer")!.id,
    ]);
    f.routines.splice(1, 1);
    f.presets[0]!.digest = "older catalog";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.routines).toHaveLength(4);
    expect(f.presets[0]!.config).toMatchObject({
      legacy: true,
      routines: { sourcer: "routine-1" },
    });
  });
});

describe("nightly memory tidy defaults", () => {
  const options = { sandboxKind: "fake" };
  it("gives each new bot one active nightly tidy in its own scope; only Main tidies shared memory", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.routines).toHaveLength(5);
    expect(f.routines.map((row) => row.botId)).toEqual(f.bots.map((bot) => bot.id));
    for (const row of f.routines) {
      expect(row).toMatchObject({
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Nightly memory tidy",
        timezone: "UTC",
        notify: false,
        active: true,
      });
      expect(row.crons).toEqual([expect.stringMatching(/^\d{1,2} 8 \* \* \*$/)]);
      expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(row.nextRunAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(row.prompt).toMatch(/^\/Tidy memory\n/);
      expect(row).not.toHaveProperty("threadId");
    }
    expect(f.routines[0]!.prompt).toMatch(/shared memory\.\nprecondition: memory$/);
    expect(
      f.routines.slice(1).every((row) => row.prompt.endsWith("precondition: bot_memory")),
    ).toBe(true);
    expect((f.presets[0]!.config as { routines: unknown }).routines).toEqual({
      main: "routine-0",
      sourcer: "routine-1",
      outreach: "routine-2",
      scheduling: "routine-3",
      reviewer: "routine-4",
    });
  });

  it("adds tidies to an earlier managed crew once and never recreates a deleted one", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.routines.splice(0);
    delete (f.presets[0]!.config as { routines?: unknown }).routines;
    f.presets[0]!.digest = "earlier-release";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.routines).toHaveLength(5);
    f.routines.splice(2, 1);
    for (let login = 0; login < 3; login++) {
      await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
      f.presets[0]!.digest = "earlier-release";
      await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    }
    expect(f.routines).toHaveLength(4);
    expect(f.tx.routine.create).toHaveBeenCalledTimes(10);
  });

  it("adopts a same-named routine instead of adding a second one", async () => {
    const f = fixture();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    delete (f.presets[0]!.config as { routines?: unknown }).routines;
    f.presets[0]!.digest = "earlier-release";
    await recruiting.upgradeRecruitingWorkspace(f.prisma, actor, options);
    expect(f.routines).toHaveLength(5);
    expect(f.tx.routine.create).toHaveBeenCalledTimes(5);
  });

  it("spreads accounts over the hour without depending on anything but the account", () => {
    expect(memoryTidyRoutineCron("person-a")).toBe(memoryTidyRoutineCron("person-a"));
    const minutes = new Set(
      ["a", "b", "c", "d", "e", "f"].map((id) => memoryTidyRoutineCron(`person-${id}`)),
    );
    expect(minutes.size).toBeGreaterThan(1);
  });
});

it("provisions one separate global native conversation with the same private crew", async () => {
  const f = fixture();
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
  await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
  const globalId = recruiting.recruitingGlobalGroupId(actor);
  expect(native.group.mock.calls.filter(([, , input]) => input.id === globalId)).toHaveLength(1);
  expect(native.group).toHaveBeenCalledWith(f.tx, actor, {
    id: globalId,
    name: "Main",
    botIds: f.bots.map((bot) => bot.id),
  });
  expect(globalId).not.toBe(f.getGroup()!.id);
  expect(recruiting.recruitingGlobalGroupId({ ...actor, userId: "other" })).not.toBe(globalId);
  expect(recruiting.recruitingGlobalGroupId({ ...actor, spaceId: "other" })).not.toBe(globalId);
});

describe("startup recruiting account backfill", () => {
  function privateMembership(userId = actor.userId, spaceId = actor.spaceId) {
    return {
      userId,
      spaceId,
      space: {
        createdByUserId: userId,
        memberships: [{ userId }],
        organization: { members: [{ userId }] },
      },
    };
  }
  function account() {
    const f = fixture();
    const findGroup = f.tx.chatGroup.findFirst.getMockImplementation()!;
    f.tx.chatGroup.findFirst.mockImplementation(async (args) => {
      const group = await findGroup(args);
      return group && args.include?.members
        ? {
            ...group,
            members: group.members.map((member) => ({
              botId: member.botId,
              bot: {
                ...f.bots.find((bot) => bot.id === member.botId),
                userId: actor.userId,
                spaceId: actor.spaceId,
              },
            })),
          }
        : group;
    });
    Object.assign(f.prisma, {
      spaceMember: { findMany: vi.fn(async () => [privateMembership()]) },
      user: { findMany: vi.fn(async () => [{ id: actor.userId, email: actor.email }]) },
      chatGroup: f.tx.chatGroup,
      mcpServer: f.tx.mcpServer,
      bot: { ...f.tx.bot, findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
      botMcpServer: { ...f.tx.botMcpServer, findMany: vi.fn(async () => []) },
    });
    return f;
  }
  it("provisions an existing private account that has never opened recruiting, once", async () => {
    const f = account();
    const errors = vi.fn();
    expect(
      await recruiting.backfillRecruitingCrews(f.prisma, { sandboxKind: "fake" }, errors),
    ).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    expect(f.bots).toHaveLength(5);
    expect(f.globalGroups.has(recruiting.recruitingGlobalGroupId(actor))).toBe(true);
    expect(
      await recruiting.backfillRecruitingCrews(f.prisma, { sandboxKind: "fake" }, errors),
    ).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    expect(native.bot).toHaveBeenCalledTimes(5);
    expect(f.globalGroups).toHaveLength(1);
  });
  it("excludes shared Spaces and ownership mismatches from the startup population", async () => {
    const f = account();
    const shared = privateMembership("other-user", "shared-space");
    shared.space.memberships.push({ userId: actor.userId });
    const organization = privateMembership("other-user", "shared-organization");
    organization.space.organization.members.push({ userId: actor.userId });
    const mismatch = privateMembership("other-user", "wrong-owner");
    mismatch.space.createdByUserId = actor.userId;
    vi.mocked(f.prisma.spaceMember.findMany).mockResolvedValue([
      privateMembership(),
      shared,
      organization,
      mismatch,
    ] as never);
    const errors = vi.fn();
    await recruiting.backfillRecruitingCrews(f.prisma, { sandboxKind: "fake" }, errors);
    expect(errors).not.toHaveBeenCalled();
    expect(
      native.bot.mock.calls.every(
        ([, who]) => who.userId === actor.userId && who.spaceId === actor.spaceId,
      ),
    ).toBe(true);
    expect(f.prisma.spaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "owner", space: { isDefault: true, deletingAt: null } },
      }),
    );
  });
  it("does not create new conversations or upgrade services after the product workspace was archived", async () => {
    const f = account();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    f.getGroup()!.archivedAt = new Date();
    f.globalGroups.clear();
    native.group.mockClear();
    const before = structuredClone(f.servers);
    const errors = vi.fn();
    await recruiting.backfillRecruitingCrews(f.prisma, { sandboxKind: "fake" }, errors);
    expect(errors).not.toHaveBeenCalled();
    expect(native.group).not.toHaveBeenCalled();
    expect(f.servers).toEqual(before);
  });
  it("preserves an archived global Main and its chosen membership", async () => {
    const f = account();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, { sandboxKind: "fake" });
    const global = f.globalGroups.get(recruiting.recruitingGlobalGroupId(actor))!;
    global.archivedAt = new Date();
    global.members.splice(1);
    const before = structuredClone(global);
    native.group.mockClear();
    const errors = vi.fn();
    await recruiting.backfillRecruitingCrews(f.prisma, { sandboxKind: "fake" }, errors);
    expect(errors).not.toHaveBeenCalled();
    expect(global).toEqual(before);
    expect(native.group).not.toHaveBeenCalled();
  });
});
