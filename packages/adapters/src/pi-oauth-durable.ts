import { randomUUID } from "node:crypto";
import type { RealtimeFanout, SecretStore } from "@rakazo/adapter-kit";
import { ModelCredentialSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { PiOAuthConnected, PiOAuthFinish } from "./pi-oauth.js";
import { PiOAuthLogins } from "./pi-oauth.js";

type Actor = { userId: string; spaceId: string };
type Begin = Parameters<PiOAuthLogins["begin"]>[0] & {
  persist: (login: PiOAuthConnected) => Promise<unknown>;
};
type Row = {
  id: string;
  userId: string;
  spaceId: string;
  provider: string;
  ownerId: string;
  state: string;
  codeCiphertext: string | null;
  result: string | null;
  acceptsCode: boolean;
  expiresAt: Date;
};
const MISSING = "Sign-in session not found. Start sign-in again.";
const FAILED = "Subscription sign-in failed. Start sign-in again.";
const TOPIC = "model-oauth:";

/** Only the originating process runs pi and saves credentials. Other instances use durable receipts. */
export class DurablePiOAuthLogins {
  private readonly ownerId = randomUUID();
  private readonly owned = new Map<
    string,
    { localId: string; actor: Actor; persist: Begin["persist"]; busy: boolean }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => Promise<void>;
  private closed = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly realtime: RealtimeFanout,
    private readonly local = new PiOAuthLogins(),
  ) {}

  private async start() {
    if (this.closed) throw new Error("Sign-in service is stopping.");
    if (this.timer) return;
    // Reuse the API's shared listener, never open another session-mode connection.
    this.timer = setInterval(() => {
      void this.drain();
    }, 500);
    this.timer.unref?.();
    this.unsubscribe = await this.realtime.subscribe(`${TOPIC}${this.ownerId}`, () => {
      void this.drain();
    });
  }

  async begin(input: Begin) {
    await this.start();
    const id = randomUUID();
    await this.waitForSave(input);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-oauth:${input.userId}:${input.provider}`}, 0))`;
      const saving = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM model_oauth_sessions WHERE "userId" = ${input.userId} AND provider = ${input.provider} AND state = 'saving' AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
      if (saving.length) throw new Error("Sign-in is finishing. Try again.");
      await tx.$executeRaw`UPDATE model_oauth_sessions SET state = 'cancelled', "codeCiphertext" = NULL WHERE "userId" = ${input.userId} AND "spaceId" = ${input.spaceId} AND provider = ${input.provider} AND state IN ('pending', 'starting', 'connected')`;
      await tx.$executeRaw`DELETE FROM model_oauth_sessions WHERE "expiresAt" < (now() AT TIME ZONE 'UTC')`;
      await tx.$executeRaw`INSERT INTO model_oauth_sessions (id, "userId", "spaceId", provider, "ownerId", state, "expiresAt") VALUES (${id}, ${input.userId}, ${input.spaceId}, ${input.provider}, ${this.ownerId}, 'starting', (now() AT TIME ZONE 'UTC') + interval '15 minutes')`;
    });
    try {
      const started = await this.local.begin(input);
      this.owned.set(id, {
        localId: started.loginId,
        actor: input,
        persist: input.persist,
        busy: false,
      });
      const updated = await this.prisma
        .$executeRaw`UPDATE model_oauth_sessions SET state = 'pending', "acceptsCode" = ${started.mode === "auth-url"}, "expiresAt" = ${new Date(Date.now() + started.expiresInSeconds * 1000)} WHERE id = ${id} AND "ownerId" = ${this.ownerId} AND state = 'starting'`;
      if (updated !== 1) {
        await this.local.cancel(started.loginId, input);
        this.owned.delete(id);
        throw new Error(MISSING);
      }
      void this.drain();
      return { ...started, loginId: id };
    } catch (error) {
      await this.fail(id);
      throw error;
    }
  }

  private async row(id: string, actor: Actor) {
    const rows = await this.prisma.$queryRaw<
      Row[]
    >`SELECT * FROM model_oauth_sessions WHERE id = ${id} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId} AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
    return rows[0];
  }

  async submit(id: string, actor: Actor, code: string): Promise<{ ok: true }> {
    const row = await this.row(id, actor);
    if (!row || !["pending", "saving", "connected"].includes(row.state)) throw new Error(MISSING);
    if (!row.acceptsCode) throw new Error("This sign-in is not waiting for a pasted code.");
    if (!code.trim()) throw new Error("Paste an authorization code or callback URL.");
    if (row.state !== "pending" || row.codeCiphertext) return { ok: true };
    const sealed = await this.secrets.put(
      code.trim(),
      {
        operationId: id,
        traceId: id,
        ...actor,
        signal: new AbortController().signal,
      },
      { ephemeral: true, recordId: id },
    );
    await this.prisma
      .$executeRaw`UPDATE model_oauth_sessions SET "codeCiphertext" = ${sealed.ciphertext} WHERE id = ${id} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId} AND state = 'pending' AND "codeCiphertext" IS NULL`;
    await this.realtime.publish(`${TOPIC}${row.ownerId}`, id).catch(() => undefined);
    return { ok: true };
  }

  async complete(
    id: string,
    actor: Actor,
  ): Promise<{ status: "pending" } | { status: "connected" } | { status: "error"; error: string }> {
    const row = await this.row(id, actor);
    if (!row || row.state === "cancelled") return { status: "error", error: MISSING };
    if (row.state === "error") return { status: "error", error: FAILED };
    return { status: row.state === "connected" ? "connected" : "pending" };
  }

  async finish<T>(
    id: string,
    actor: Actor,
    _persist: (login: PiOAuthConnected) => Promise<T>,
  ): Promise<PiOAuthFinish<T>> {
    const row = await this.row(id, actor);
    if (!row || row.state === "cancelled") return { status: "error", error: MISSING };
    if (row.state === "error") return { status: "error", error: FAILED };
    if (row.state !== "connected" || !row.result) return { status: "pending" };
    return { status: "connected", value: JSON.parse(row.result) as T };
  }

  private async waitForSave(actor: { userId: string; provider?: string }) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await this.prisma.$queryRaw<
        Row[]
      >`SELECT * FROM model_oauth_sessions WHERE "userId" = ${actor.userId} AND (${actor.provider ?? null}::text IS NULL OR provider = ${actor.provider ?? null}) AND state = 'saving' AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
      if (!rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Sign-in is finishing. Try again.");
  }

  async cancel(id: string, actor: Actor) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForSave(actor);
      const cancelled = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Row[]
        >`SELECT * FROM model_oauth_sessions WHERE id = ${id} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId} FOR UPDATE`;
        if (rows[0]?.state === "saving" && rows[0].expiresAt > new Date()) return false;
        await tx.$executeRaw`UPDATE model_oauth_sessions SET state = 'cancelled', "codeCiphertext" = NULL, result = NULL WHERE id = ${id} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}`;
        return true;
      });
      if (cancelled) {
        await this.drain();
        return;
      }
    }
    throw new Error("Sign-in is finishing. Try again.");
  }

  async cancelProvider(input: { userId: string; provider: string }) {
    await this.waitForSave(input);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-oauth:${input.userId}:${input.provider}`}, 0))`;
      const saving = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM model_oauth_sessions WHERE "userId" = ${input.userId} AND provider = ${input.provider} AND state = 'saving' AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
      if (saving.length) throw new Error("Sign-in is finishing. Try again.");
      await tx.$executeRaw`UPDATE model_oauth_sessions SET state = 'cancelled', "codeCiphertext" = NULL, result = NULL WHERE "userId" = ${input.userId} AND provider = ${input.provider}`;
    });
    await this.drain();
  }

  private async fail(id: string) {
    await this.prisma
      .$executeRaw`UPDATE model_oauth_sessions SET state = 'error', "codeCiphertext" = NULL WHERE id = ${id} AND "ownerId" = ${this.ownerId} AND state IN ('starting', 'pending', 'saving')`;
  }

  private async drain() {
    await Promise.all(
      [...this.owned].map(async ([id, session]) => {
        if (session.busy || this.closed) return;
        session.busy = true;
        try {
          const row = await this.row(id, session.actor);
          if (!row || ["cancelled", "error"].includes(row.state)) {
            if (!row) await this.fail(id);
            await this.local.cancel(session.localId, session.actor);
            this.owned.delete(id);
            return;
          }
          if (row.state !== "pending") return;
          if (row.codeCiphertext) {
            const code = await this.secrets.load(row.codeCiphertext, { recordId: id });
            this.local.submit(session.localId, session.actor, code);
          }
          const result = this.local.complete(session.localId, session.actor);
          if (result.status === "pending") return;
          if (result.status === "error") {
            await this.fail(id);
            this.owned.delete(id);
            return;
          }
          const claimed = await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-oauth:${session.actor.userId}:${row.provider}`}, 0))`;
            return tx.$executeRaw`UPDATE model_oauth_sessions SET state = 'saving', "codeCiphertext" = NULL WHERE id = ${id} AND "ownerId" = ${this.ownerId} AND state = 'pending' AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
          });
          if (!claimed) return;
          // The committed saving claim is never replayed: owner loss must not duplicate an uncertain write.
          const saved = await this.local.finish(session.localId, session.actor, (login) =>
            session.persist({
              ...login,
              signal: AbortSignal.any([login.signal, AbortSignal.timeout(30_000)]),
            }),
          );
          if (saved.status !== "connected") throw new Error(FAILED);
          await this.prisma
            .$executeRaw`UPDATE model_oauth_sessions SET state = 'connected', result = ${JSON.stringify(ModelCredentialSchema.parse(saved.value))} WHERE id = ${id} AND "ownerId" = ${this.ownerId} AND state = 'saving' AND "expiresAt" > (now() AT TIME ZONE 'UTC')`;
          this.owned.delete(id);
        } catch {
          await this.fail(id).catch(() => undefined);
          await this.local.cancel(session.localId, session.actor).catch(() => undefined);
          this.owned.delete(id);
        } finally {
          session.busy = false;
        }
      }),
    );
  }

  async abortAll() {
    this.closed = true;
    clearInterval(this.timer);
    await this.unsubscribe?.();
    while ([...this.owned.values()].some((entry) => entry.busy))
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.local.abortAll();
    await this.prisma
      .$executeRaw`UPDATE model_oauth_sessions SET state = 'error', "codeCiphertext" = NULL WHERE "ownerId" = ${this.ownerId} AND state IN ('starting', 'pending')`;
    this.owned.clear();
  }
}
