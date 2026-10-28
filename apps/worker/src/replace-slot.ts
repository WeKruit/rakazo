/** Explicit operator entrypoint. Importing it does not run cloud commands. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SlotTarget } from "@rakazo/adapters";
import { ModalSlotPlatform, replaceWorkerSlot } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";

export function parseReplacementPlan(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Replacement plan required");
  const value = raw as Record<string, unknown>;
  const target = (raw: unknown): SlotTarget => {
    if (!raw || typeof raw !== "object") throw new Error("Explicit slot target required");
    const x = raw as Record<string, unknown>;
    if (x.slot !== "worker-a" && x.slot !== "worker-b")
      throw new Error("Only a worker slot may be replaced");
    for (const field of ["appId", "appName", "entry", "environment"])
      if (typeof x[field] !== "string" || !x[field]) throw new Error(`Missing ${field}`);
    if (!(x.entry as string).includes("::")) throw new Error("Entry must name one App variable");
    return {
      slot: x.slot,
      appId: x.appId as string,
      appName: x.appName as string,
      entry: x.entry as string,
      environment: x.environment as string,
    };
  };
  for (const field of ["expectedGeneration", "generation"])
    if (typeof value[field] !== "string" || !/^[0-9a-f]{40}$/.test(value[field] as string))
      throw new Error("Generation must be an image source commit");
  if (
    typeof value.timeoutMs !== "number" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs <= 0
  )
    throw new Error("Positive bounded drain deadline required");
  return {
    target: target(value.target),
    peer: target(value.peer),
    expectedGeneration: value.expectedGeneration as string,
    generation: value.generation as string,
    timeoutMs: value.timeoutMs,
  };
}

async function main() {
  const [planFile, python] = process.argv.slice(2);
  if (!planFile || !python)
    throw new Error("Usage: replace-slot.mjs PLAN.json PYTHON_WITH_MODAL_1_6_1");
  const plan = parseReplacementPlan(JSON.parse(await readFile(planFile, "utf8")));
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).port !== "6543")
    throw new Error("Control uses the transaction pooler on port 6543");
  const db = createDb(url, { poolMax: 1, applicationName: "rakazo-slot-control" });
  try {
    const result = await replaceWorkerSlot(
      db.prisma,
      new ModalSlotPlatform(python, process.cwd()),
      plan,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "completed") process.exitCode = 2;
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
