import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Actor } from "@rakazo/contracts";
import type { DbClientOptions } from "./client.js";
import { createPool, PrismaClient } from "./client.js";

type Identity = Pick<Actor, "userId" | "spaceId">;
type Adapter = Awaited<ReturnType<PrismaPg["connect"]>>;
type Query = Parameters<Adapter["queryRaw"]>[0];
type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>;
export const actorRlsTables = [
  "artifacts",
  "messages",
  "recruiting_roles",
  "recruiting_role_revisions",
  "recruiting_candidates",
  "recruiting_calibration_rounds",
  "threads",
  "tasks",
  "runs",
  "external_effects",
  "events",
  "recruiting_crm_roles",
  "recruiting_crm_contacts",
  "recruiting_crm_messages",
  "recruiting_crm_sync_progress",
  "recruiting_crm_campaigns",
  "recruiting_crm_leads",
  "recruiting_crm_workspace_attachments",
  "recruiting_reminders",
  "recruiting_candidate_notes",
  "recruiting_saved_profiles",
  "recruiting_research_tasks",
  "recruiting_assessments",
  "recruiting_candidate_pages",
  "recruiting_candidate_occurrences",
  "recruiting_research_actions",
  "recruiting_crm_imports",
  "recruiting_replies",
  "recruiting_crm_role_contacts",
] as const;
const protectedSqlNames = actorRlsTables.map((name) => `'${name}'`).join(", ");
const identity = new AsyncLocalStorage<Readonly<Identity>>();

/** Bind lazy iterators too: consuming an RPC stream happens after its middleware returns. */
export async function withDatabaseActor<T extends { output: unknown }>(
  actor: Identity,
  run: () => Promise<T>,
): Promise<T> {
  const scope = Object.freeze({ userId: actor.userId, spaceId: actor.spaceId });
  if (!scope.userId || !scope.spaceId) throw new Error("Database actor is required");
  const result = await identity.run(scope, run);
  const output = result.output;
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    const iterator = (output as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    return {
      ...result,
      output: {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: (...args: [] | [unknown]) => identity.run(scope, () => iterator.next(...args)),
        return: async (value: unknown) =>
          identity.run(
            scope,
            () => iterator.return?.(value) ?? Promise.resolve({ done: true, value }),
          ),
        throw: async (error: unknown) =>
          identity.run(scope, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      },
    };
  }
  return result;
}

function actorIdentity() {
  const actor = identity.getStore();
  if (!actor) throw new Error("Protected database access requires an actor");
  return actor;
}

const sql = (statement: string): Query => ({ sql: statement, args: [], argTypes: [] });
async function bindIdentity(tx: Transaction, actor: Identity) {
  await tx.executeRaw({
    sql: "SELECT set_config('app.user_id', $1, true), set_config('app.space_id', $2, true)",
    args: [actor.userId, actor.spaceId],
    argTypes: [
      { scalarType: "string", arity: "scalar" },
      { scalarType: "string", arity: "scalar" },
    ],
  });
}

/** Restricted-role client: never falls back to the auth/background database identity. */
export function createActorDb(connectionString: string, options: DbClientOptions = {}) {
  const pool = createPool(connectionString, { ...options, pipeline: true });
  const base = new PrismaPg(pool);
  const adapter = {
    provider: "postgres" as const,
    adapterName: base.adapterName,
    async connect() {
      const inner = await base.connect();
      const role = await inner.queryRaw(
        sql(`SELECT r.rolsuper, r.rolbypassrls,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname IN (${protectedSqlNames}, 'home_authority_tombstones', 'home_authority_cutover')
          AND pg_has_role(current_user, c.relowner, 'MEMBER'))
        OR EXISTS (SELECT 1 FROM pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls)
          AND pg_has_role(current_user, privileged.oid, 'MEMBER'))
        FROM pg_roles r WHERE r.rolname=current_user`),
      );
      if (role.rows.length !== 1 || role.rows[0]?.some(Boolean)) {
        await inner.dispose();
        throw new Error("Protected database role must not own protected tables or bypass RLS");
      }
      const policies = await inner.queryRaw(
        sql(`SELECT count(*)::int FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        AND c.relname IN (${protectedSqlNames}) AND c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace fn ON fn.oid=f.pronamespace
          WHERE fn.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0
          AND NOT f.prosecdef AND f.provolatile='s' AND f.proconfig @> ARRAY['search_path=pg_catalog'])
        AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='rakazo_actor_isolation')
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive AND p.polname<>'rakazo_actor_isolation')`),
      );
      if (policies.rows[0]?.[0] !== actorRlsTables.length) {
        await inner.dispose();
        throw new Error("Protected database requires the first-batch RLS policies");
      }
      const internal = await inner.queryRaw(
        sql(`SELECT count(*)::int FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        AND c.relname IN ('home_authority_tombstones', 'home_authority_cutover') AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)`),
      );
      if (internal.rows[0]?.[0] !== 2) {
        await inner.dispose();
        throw new Error("Protected database requires system-only home authority metadata");
      }
      async function startTransaction(level?: Parameters<Adapter["startTransaction"]>[0]) {
        const actor = actorIdentity();
        const tx = await inner.startTransaction(level);
        try {
          await bindIdentity(tx, actor);
          return tx;
        } catch (error) {
          try {
            await tx.executeRaw(sql("ROLLBACK"));
          } finally {
            await tx.rollback();
          }
          throw error;
        }
      }
      async function standalone<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
        const actor = actorIdentity();
        // BEGIN must complete on the exclusively checked-out native transaction.
        const tx = await inner.startTransaction();
        try {
          // Both public adapter calls enqueue synchronously before their first
          // await in the pinned PrismaPg version. pg's public pipeline sends SET
          // first, then the parameterized business query, on this same client.
          // Drain both outcomes before rollback/release; never enqueue COMMIT
          // until parameter binding and result decoding have both succeeded.
          const [bound, queried] = await Promise.allSettled([
            bindIdentity(tx, actor),
            Promise.resolve().then(() => run(tx)),
          ]);
          if (bound.status === "rejected") throw bound.reason;
          if (queried.status === "rejected") throw queried.reason;
          const result = queried.value;
          await tx.executeRaw(sql("COMMIT"));
          await tx.commit();
          return result;
        } catch (error) {
          try {
            await tx.executeRaw(sql("ROLLBACK"));
          } finally {
            await tx.rollback();
          }
          throw error;
        }
      }
      return {
        provider: "postgres" as const,
        adapterName: inner.adapterName,
        queryRaw: (query: Query) => standalone((tx) => tx.queryRaw(query)),
        executeRaw: (query: Query) => standalone((tx) => tx.executeRaw(query)),
        startTransaction,
        executeScript: async () => {
          throw new Error("Protected database cannot execute migration scripts");
        },
        getConnectionInfo: () => inner.getConnectionInfo(),
        dispose: () => inner.dispose(),
      };
    },
  };
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: { timeout: 15_000, maxWait: 5_000 },
  });
  return { prisma, pool };
}
