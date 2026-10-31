import type { PrismaClient } from "./client.js";

type Row = Record<string, unknown>;
type Thread = { id: string; messages?: Row[]; runs?: Row[] };

/**
 * Unit-test fakes describe a bot's or group's newest messages and runs as nested `thread.messages`
 * and `thread.runs`, the shape a Prisma include would return. The repos now read those rows with
 * one indexed raw query per list; this answers that query from the threads the fake returned.
 */
export function withLatestThreadRows<T extends object>(fake: T): PrismaClient {
  // Read back what the fake's find* mocks returned so far, the rows a list just loaded.
  const threads = async () => {
    const byId = new Map<string, Thread>();
    for (const model of Object.values(fake)) {
      if (!model || typeof model !== "object") continue;
      for (const [name, method] of Object.entries(model)) {
        const results = (method as { mock?: { results: Array<{ value: unknown }> } }).mock?.results;
        if (!/^find/.test(name) || !results) continue;
        for (const result of results) {
          const value = await Promise.resolve(result.value).catch(() => null);
          for (const item of Array.isArray(value) ? value : [value]) {
            const thread = (item as { thread?: Thread } | null)?.thread;
            if (thread?.id) byId.set(thread.id, thread);
          }
        }
      }
    }
    return byId;
  };
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    const known = await threads();
    const ids = values[0] as string[];
    if (sql.includes('FROM "runs"'))
      return ids.flatMap((id) => {
        const run = known.get(id)?.runs?.[0];
        return run ? [{ threadId: id, id: run.id, status: run.status }] : [];
      });
    const take = values.at(-1) as number;
    const hideAutocontinue = JSON.stringify(values).includes("autocontinue");
    return ids.flatMap((id) =>
      (known.get(id)?.messages ?? [])
        .filter(
          (message) =>
            !hideAutocontinue || !String(message.clientNonce ?? "").startsWith("autocontinue:"),
        )
        .slice(0, take)
        .map((message) => ({ runId: null, ...message, threadId: id })),
    );
  };
  return Object.assign(fake, { $queryRaw }) as unknown as PrismaClient;
}
