import type { BackgroundJob } from "@rakazo/adapter-kit";
import { AUTOMATION_RATE_LIMITED_ERROR, AUTOMATION_RUNS_PER_MINUTE } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

type Row = {
  id: string;
  spaceId: string;
  taskId: string;
  threadId: string;
  botId: string;
  routineId: string | null;
  error: string | null;
  trigger: string;
  status: string;
  createdAt: Date;
  checkpoint: string | null;
  leaseFence: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
};

type Where = Record<string, unknown>;

const compare = (value: unknown) => (value instanceof Date ? value.getTime() : value) as number;

/** Enough of Prisma's filter semantics for the claim and lane queries. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    if (key === "AND") return (condition as Where[]).every((branch) => matches(row, branch));
    const value = row[key as keyof Row];
    if (condition instanceof Date || condition === null || typeof condition !== "object")
      return compare(value) === compare(condition);
    const filter = condition as Record<string, unknown>;
    if ("in" in filter && !(filter.in as unknown[]).includes(value)) return false;
    if ("not" in filter && value === filter.not) return false;
    if ("gte" in filter && !(value !== null && compare(value) >= compare(filter.gte))) return false;
    if ("lt" in filter && !(value !== null && compare(value) < compare(filter.lt))) return false;
    if ("lte" in filter && !(value !== null && compare(value) <= compare(filter.lte))) return false;
    return true;
  });
}

const CLAIMED = "claimed: the run left the queue";

/** Runs in one database; the executor stops right after a successful claim. */
function lane(seed: Array<Partial<Row> & Pick<Row, "id" | "trigger" | "status">>) {
  const rows: Row[] = seed.map((row, index) => ({
    spaceId: "space-1",
    taskId: `task-${row.id}`,
    threadId: "thread-1",
    botId: "bot-1",
    routineId: null,
    error: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 9, index)),
    checkpoint: null,
    leaseFence: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...row,
  }));
  const run = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      structuredClone(rows.find((row) => row.id === where.id) ?? null),
    ),
    findUniqueOrThrow: vi.fn(async () => {
      throw new Error(CLAIMED);
    }),
    count: vi.fn(
      async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)).length,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }),
  };
  const prisma = {
    run,
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const append = vi.fn(async () => ({}));
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
    events: { append },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  /** Continue a run; true when this worker claimed it. */
  const start = async (id: string) => {
    try {
      await executor.continueRun(id, "worker-1");
      return false;
    } catch (error) {
      if ((error as Error).message === CLAIMED) return true;
      throw error;
    }
  };
  const status = (id: string) => rows.find((row) => row.id === id)?.status;
  const row = (id: string) => rows.find((candidate) => candidate.id === id);
  const set = (id: string, next: string) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    row.status = next;
  };
  return { start, status, set, row, enqueue, append, prisma };
}

describe("thread lanes for automation runs", () => {
  it("starts queued automations in one thread oldest first, one at a time", async () => {
    const db = lane([
      { id: "routine-early", trigger: "routine", status: "queued" },
      { id: "webhook-late", trigger: "webhook", status: "queued" },
    ]);

    // The later run's job arrives first: it waits for the earlier one.
    expect(await db.start("webhook-late")).toBe(false);
    expect(db.status("webhook-late")).toBe("queued");
    expect(db.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "webhook-late" },
        availableAt: expect.any(Date),
      }),
    );

    expect(await db.start("routine-early")).toBe(true);
    expect(db.status("routine-early")).toBe("leased");

    // While the earlier run holds the turn, the later one keeps waiting.
    db.set("routine-early", "running");
    expect(await db.start("webhook-late")).toBe(false);
    expect(db.status("webhook-late")).toBe("queued");

    db.set("routine-early", "completed");
    expect(await db.start("webhook-late")).toBe(true);
  });

  it("serializes different bots' automations in a group thread", async () => {
    const db = lane([
      { id: "main-webhook", botId: "main", trigger: "webhook", status: "running" },
      { id: "sourcer-wake", botId: "sourcer", trigger: "recruiting_research", status: "queued" },
    ]);
    expect(await db.start("sourcer-wake")).toBe(false);
    expect(db.status("sourcer-wake")).toBe("queued");
  });

  it("does not wait for a run that is waiting for a person", async () => {
    const db = lane([
      { id: "ask", trigger: "user", status: "waiting_input" },
      { id: "takeover", trigger: "routine", status: "waiting_takeover" },
      { id: "routine", trigger: "routine", status: "queued" },
    ]);
    expect(await db.start("routine")).toBe(true);
  });

  it("waits behind an earlier queued person's turn and an answered ask", async () => {
    const db = lane([
      { id: "answered", trigger: "user", status: "queued", leaseFence: 1 },
      { id: "routine", trigger: "routine", status: "queued" },
    ]);
    expect(await db.start("routine")).toBe(false);
    expect(await db.start("answered")).toBe(true);
  });

  it("keeps a person's message claim unchanged while an automation runs", async () => {
    const db = lane([
      { id: "routine", trigger: "routine", status: "running" },
      { id: "message", trigger: "user", status: "queued" },
    ]);
    expect(await db.start("message")).toBe(true);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("ignores runs in other threads", async () => {
    const db = lane([
      { id: "elsewhere", threadId: "thread-2", trigger: "routine", status: "running" },
      { id: "routine", trigger: "routine", status: "queued" },
    ]);
    expect(await db.start("routine")).toBe(true);
  });
});

/** `count` fires of one automation, a second apart, all in one minute and already finished. */
function burst(count: number, fire: Partial<Row> & Pick<Row, "trigger">) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fire-${String(index).padStart(2, "0")}`,
    status: "completed",
    createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, index)),
    ...fire,
  }));
}

describe("automation rate cap", () => {
  it("skips a routine's fire past its per-minute cap and records why", async () => {
    const fires = burst(AUTOMATION_RUNS_PER_MINUTE + 1, { trigger: "routine", routineId: "r-1" });
    fires.at(-1)!.status = "queued";
    const last = fires.at(-1)!.id;
    const db = lane(fires);

    expect(await db.start(last)).toBe(false);
    expect(db.row(last)).toMatchObject({
      status: "cancelled",
      error: AUTOMATION_RATE_LIMITED_ERROR,
    });
    expect(db.prisma.task.updateMany).toHaveBeenCalledWith({
      where: { id: `task-${last}` },
      data: { status: "cancelled" },
    });
    expect(db.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.cancelled",
        runId: last,
        payload: { reason: "rate_limited" },
      }),
    );
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("lets the first fires of a burst run whatever order workers take them in", async () => {
    const fires = burst(AUTOMATION_RUNS_PER_MINUTE + 1, { trigger: "webhook", routineId: "r-1" });
    for (const fire of fires) fire.status = "queued";
    const db = lane(fires);
    // The newest fire is picked up first and is the one skipped.
    expect(await db.start(fires.at(-1)!.id)).toBe(false);
    expect(db.status(fires.at(-1)!.id)).toBe("cancelled");
    expect(await db.start(fires[0]!.id)).toBe(true);
  });

  it("does not count skipped fires, so the cap resets once the storm stops", async () => {
    const fires = burst(AUTOMATION_RUNS_PER_MINUTE + 1, { trigger: "bot_message" });
    for (const fire of fires.slice(1, -1)) fire.error = AUTOMATION_RATE_LIMITED_ERROR;
    fires.at(-1)!.status = "queued";
    const db = lane(fires);
    expect(await db.start(fires.at(-1)!.id)).toBe(true);
  });

  it("counts a bot's turns of one trigger together when no routine owns them", async () => {
    const fires = burst(AUTOMATION_RUNS_PER_MINUTE, { trigger: "tickets" });
    const db = lane([
      ...fires,
      {
        id: "other-bot",
        botId: "bot-2",
        trigger: "tickets",
        status: "queued",
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 30)),
      },
      {
        id: "same-bot",
        trigger: "tickets",
        status: "queued",
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 31)),
      },
    ]);
    expect(await db.start("other-bot")).toBe(true);
    db.set("other-bot", "completed");
    expect(await db.start("same-bot")).toBe(false);
    expect(db.status("same-bot")).toBe("cancelled");
  });

  it("never caps a person's message or a run that already started once", async () => {
    const db = lane([
      ...burst(AUTOMATION_RUNS_PER_MINUTE, { trigger: "routine", routineId: "r-1" }),
      {
        id: "resumed",
        trigger: "routine",
        routineId: "r-1",
        status: "queued",
        leaseFence: 2,
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 40)),
      },
    ]);
    expect(await db.start("resumed")).toBe(true);

    const people = lane([
      ...burst(AUTOMATION_RUNS_PER_MINUTE, { trigger: "user" }),
      {
        id: "message",
        trigger: "user",
        status: "queued",
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 40)),
      },
    ]);
    expect(await people.start("message")).toBe(true);
  });

  it("forgets fires older than a minute", async () => {
    const db = lane([
      ...burst(AUTOMATION_RUNS_PER_MINUTE, { trigger: "routine", routineId: "r-1" }),
      {
        id: "later",
        trigger: "routine",
        routineId: "r-1",
        status: "queued",
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 1, 5)),
      },
    ]);
    expect(await db.start("later")).toBe(true);
  });
});
