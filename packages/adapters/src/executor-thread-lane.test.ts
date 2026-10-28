import type { BackgroundJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

type Row = {
  id: string;
  threadId: string;
  botId: string;
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
    const value = row[key as keyof Row];
    if (condition instanceof Date || condition === null || typeof condition !== "object")
      return compare(value) === compare(condition);
    const filter = condition as Record<string, unknown>;
    if ("in" in filter && !(filter.in as unknown[]).includes(value)) return false;
    if ("not" in filter && value === filter.not) return false;
    if ("lt" in filter && !(value !== null && compare(value) < compare(filter.lt))) return false;
    if ("lte" in filter && !(value !== null && compare(value) <= compare(filter.lte))) return false;
    return true;
  });
}

const CLAIMED = "claimed: the run left the queue";

/** Runs in one database; the executor stops right after a successful claim. */
function lane(seed: Array<Partial<Row> & Pick<Row, "id" | "trigger" | "status">>) {
  const rows: Row[] = seed.map((row, index) => ({
    threadId: "thread-1",
    botId: "bot-1",
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
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
    events: {},
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
  const set = (id: string, next: string) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    row.status = next;
  };
  return { start, status, set, enqueue, prisma };
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
