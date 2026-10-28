import type { PrismaClient } from "@rakazo/db";

type Entry = { name: string; version: string };
/**
 * What a running agent's frozen prompt was built from: durable memory, skills and the tool
 * sources assigned to it. Keyed by row id (memory by "scope: path", which the run's own writes
 * know); the version tells an edit from no change.
 */
export type RunContextSnapshot = Record<RunContextKind, Map<string, Entry>>;
export type RunContextKind = "memory" | "skills" | "tools";

type SnapshotPrisma = Pick<
  PrismaClient,
  "memoryDocument" | "agentSkill" | "botMcpServer" | "connection" | "capabilityInstall"
>;

const MAX_NAMES = 8;
const MAX_NAME_LENGTH = 80;

/**
 * Reads ids, names and versions only, never content: five small selects on indexed owner
 * columns, sent together so a turn boundary waits one round trip.
 */
export async function readRunContextSnapshot(
  prisma: SnapshotPrisma,
  owner: { spaceId: string; userId: string; botId: string },
): Promise<RunContextSnapshot> {
  const { spaceId, userId, botId } = owner;
  const [memory, skills, servers, connections, installs] = await Promise.all([
    prisma.memoryDocument.findMany({
      where: { spaceId, userId, OR: [{ scope: "user" }, { scope: "bot", botId }] },
      select: { scope: true, path: true, revision: true },
    }),
    prisma.agentSkill.findMany({
      where: { spaceId, userId },
      select: { id: true, name: true, updatedAt: true },
    }),
    prisma.botMcpServer.findMany({
      where: { botId, spaceId, userId, server: { enabled: true } },
      select: { id: true, updatedAt: true, server: { select: { name: true, revision: true } } },
    }),
    prisma.connection.findMany({
      where: { spaceId, userId, status: "connected" },
      select: { id: true, displayName: true },
    }),
    prisma.capabilityInstall.findMany({
      where: { spaceId, userId, kind: { in: ["mcp", "api", "graphql"] } },
      select: { id: true, name: true },
    }),
  ]);
  return {
    memory: new Map(
      memory.map((doc) => {
        const name = `${doc.scope}: ${doc.path}`;
        return [name, { name, version: String(doc.revision) }];
      }),
    ),
    skills: new Map(
      skills.map((skill) => [
        skill.id,
        { name: skill.name, version: skill.updatedAt.toISOString() },
      ]),
    ),
    tools: new Map<string, Entry>([
      ...servers.map((row): [string, Entry] => [
        `mcp:${row.id}`,
        { name: row.server.name, version: `${row.server.revision}:${row.updatedAt.toISOString()}` },
      ]),
      ...connections.map((row): [string, Entry] => [
        `connection:${row.id}`,
        { name: row.displayName, version: "" },
      ]),
      ...installs.map((row): [string, Entry] => [
        `install:${row.id}`,
        { name: row.name, version: "" },
      ]),
    ]),
  };
}

/**
 * Turns changes since run start into one short notice for the next turn boundary. The prompt
 * prefix stays as it was; the notice points at the tools that read the current state.
 * `acknowledge` marks the run's own writes so they are adopted without a notice.
 */
export function createRunContextWatch(
  read: () => Promise<RunContextSnapshot>,
  baseline: Promise<RunContextSnapshot | undefined>,
  redact: (text: string) => string = (text) => text,
) {
  let seen: RunContextSnapshot | undefined;
  let started = false;
  const own = new Set<string>();
  return {
    /** The run itself changed this row (or, without an id, this kind). */
    acknowledge(kind: RunContextKind, id?: string) {
      own.add(id ? `${kind}\0${id}` : kind);
    },
    async claimNotice(): Promise<string | undefined> {
      if (!started) {
        started = true;
        seen = await baseline.catch(() => undefined);
      }
      if (!seen) return undefined;
      const current = await read().catch(() => undefined);
      if (!current) return undefined;
      const previous = seen;
      seen = current;
      const owned = new Set(own);
      own.clear();
      const changed = (kind: RunContextKind) => {
        const added: string[] = [];
        const other: string[] = [];
        if (owned.has(kind)) return { added, other };
        for (const [id, entry] of current[kind]) {
          if (owned.has(`${kind}\0${id}`)) continue;
          const before = previous[kind].get(id);
          if (!before) added.push(entry.name);
          else if (before.version !== entry.version) other.push(entry.name);
        }
        for (const [id, entry] of previous[kind])
          if (!current[kind].has(id) && !owned.has(`${kind}\0${id}`)) other.push(entry.name);
        return { added, other };
      };
      const memory = changed("memory");
      const skills = changed("skills");
      const tools = changed("tools");
      const lines = [
        memory.added.length || memory.other.length
          ? `Memory changed: ${names([...memory.added, ...memory.other], redact)}; read_memory for details.`
          : undefined,
        skills.added.length || skills.other.length
          ? `Skills changed: ${names([...skills.added, ...skills.other], redact)}; skill_read for details.`
          : undefined,
        tools.added.length
          ? `New tools available: ${names(tools.added, redact)} (callable from the next run).`
          : undefined,
        tools.other.length
          ? `Tools changed or removed: ${names(tools.other, redact)} (from the next run).`
          : undefined,
      ].filter(Boolean);
      return lines.length ? lines.join("\n") : undefined;
    },
  };
}

function names(values: string[], redact: (text: string) => string): string {
  const unique = [...new Set(values)];
  const shown = unique
    .slice(0, MAX_NAMES)
    .map((value) => redact(value).replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH));
  const more = unique.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}
