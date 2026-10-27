import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { PrismaClient } from "@rakazo/db";
import {
  acquireSessionReplacement,
  listSessionAdmissions,
  releaseSessionAdmission,
  releaseSessionReplacement,
  setDesiredSessionGeneration,
} from "@rakazo/db";

type Slot = "worker-a" | "worker-b";
export type SlotTarget = {
  slot: Slot;
  appId: string;
  appName: string;
  entry: string;
  environment: string;
};
type Health = {
  ok: boolean;
  state: string;
  identity: { instanceId: string; generation: string; service: string };
};
export interface SlotPlatform {
  validateTarget(target: SlotTarget, generation: string): Promise<void>;
  containers(target: SlotTarget): Promise<string[]>;
  health(target: SlotTarget, id: string): Promise<Health>;
  finished(target: SlotTarget, id: string): Promise<boolean>;
  drain(target: SlotTarget, id: string, timeoutSeconds: number): Promise<void>;
  stop(target: SlotTarget, id: string): Promise<void>;
  deploy(target: SlotTarget, generation: string): Promise<void>;
}

/** Concrete pinned-SDK command adapter. Constructing it never runs a command. */
export class ModalSlotPlatform implements SlotPlatform {
  private readonly identities = new Map<string, Health["identity"]>();
  constructor(
    private readonly python: string,
    private readonly cwd: string,
  ) {}
  private async call(
    target: SlotTarget,
    action: string,
    id?: string,
    timeoutSeconds = 300,
    generation?: string,
  ) {
    const args = [
      "-m",
      "infra.modal.slot_platform",
      action,
      "--app-id",
      target.appId,
      "--app-name",
      target.appName,
      "--slot",
      target.slot,
      "--environment",
      target.environment,
    ];
    if (id) args.push("--container-id", id);
    if (action === "deploy" || action === "validate")
      args.push("--entry", target.entry, "--generation", generation ?? "");
    if (action === "stop" || action === "drain") {
      const identity = id ? this.identities.get(id) : undefined;
      if (!identity) throw new Error("Container identity must be observed before mutation");
      args.push("--expected-instance", identity.instanceId, "--generation", identity.generation);
    }
    if (action === "drain") args.push("--timeout", String(timeoutSeconds));
    const { stdout } = await promisify(execFile)(this.python, args, {
      cwd: this.cwd,
      timeout:
        action === "deploy" ? 300_000 : action === "drain" ? (timeoutSeconds + 5) * 1000 : 3_000,
      maxBuffer: 1024 * 1024,
    });
    const records = stdout.split("\n").filter((line) => line.startsWith("RAKAZO_SLOT_RESULT "));
    if (records.length !== 1) throw new Error("Slot command result missing or ambiguous");
    return JSON.parse(records[0]!.slice("RAKAZO_SLOT_RESULT ".length)) as unknown;
  }
  async validateTarget(target: SlotTarget, generation: string) {
    await this.call(target, "validate", undefined, 300, generation);
  }
  async containers(target: SlotTarget) {
    const ids = await this.call(target, "list");
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new Error("Invalid container inventory");
    return ids as string[];
  }
  async health(target: SlotTarget, id: string) {
    const value = (await this.call(target, "health", id)) as Health;
    if (
      !value ||
      typeof value.ok !== "boolean" ||
      typeof value.state !== "string" ||
      !value.identity ||
      !value.identity.instanceId ||
      !value.identity.generation ||
      value.identity.service !== target.slot
    )
      throw new Error("Invalid slot health identity");
    this.identities.set(id, value.identity);
    return value;
  }
  async finished(target: SlotTarget, id: string) {
    const value = (await this.call(target, "finished", id)) as { finished: unknown };
    if (typeof value?.finished !== "boolean") throw new Error("Container stop observation missing");
    return value.finished;
  }
  async drain(target: SlotTarget, id: string, seconds: number) {
    await this.call(target, "drain", id, seconds);
  }
  async stop(target: SlotTarget, id: string) {
    await this.call(target, "stop", id);
  }
  async deploy(target: SlotTarget, generation: string) {
    await this.call(target, "deploy", undefined, 300, generation);
  }
}

/** One independently deployed worker slot per invocation; peer readiness is checked before critical steps and during polling.
 * Any error retains the global controller lease for attended recovery, never TTL takeover.
 */
export async function replaceWorkerSlot(
  prisma: PrismaClient,
  platform: SlotPlatform,
  input: {
    target: SlotTarget;
    peer: SlotTarget;
    expectedGeneration: string;
    generation: string;
    timeoutMs: number;
  },
  options: { now?: () => number; wait?: (ms: number) => Promise<void> } = {},
) {
  const { target, peer } = input;
  if (
    target.slot === peer.slot ||
    target.appId === peer.appId ||
    target.appName === peer.appName ||
    target.entry === peer.entry
  )
    throw new Error("Worker slots require distinct independent App identities");
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !input.generation ||
    input.generation === input.expectedGeneration
  )
    throw new Error("Invalid slot replacement generation/deadline");
  const lease = await acquireSessionReplacement(prisma, { owner: randomUUID() });
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const one = async (slot: SlotTarget) => {
    const ids = await platform.containers(slot);
    if (ids.length !== 1) throw new Error("Expected exactly one container in worker slot");
    return ids[0]!;
  };
  const readyPeer = async () => {
    const id = await one(peer);
    const health = await platform.health(peer, id);
    const rows = await listSessionAdmissions(prisma);
    if (
      !health.ok ||
      health.state !== "ready" ||
      health.identity.service !== peer.slot ||
      !rows.some(
        (row) =>
          row.service === peer.slot &&
          row.instanceId === health.identity.instanceId &&
          row.generation === health.identity.generation &&
          row.status === "active",
      )
    )
      throw new Error("Independent ready peer unavailable");
  };
  const poll = async (check: () => Promise<boolean>) => {
    const deadline = now() + input.timeoutMs;
    for (;;) {
      await readyPeer();
      if (await check()) return;
      if (now() >= deadline) throw new Error("Slot observation deadline; replacement postponed");
      await wait(Math.min(250, deadline - now()));
    }
  };
  try {
    await platform.validateTarget(target, input.generation);
    await readyPeer();
    const old = await one(target);
    const health = await platform.health(target, old);
    if (
      health.identity.generation !== input.expectedGeneration ||
      health.identity.service !== target.slot
    )
      throw new Error("Old worker generation mismatch");
    const oldAdmission = (await listSessionAdmissions(prisma)).find(
      (row) =>
        row.service === target.slot &&
        row.instanceId === health.identity.instanceId &&
        row.generation === input.expectedGeneration,
    );
    if (!oldAdmission) throw new Error("Old worker admission identity missing");
    // No stop/deploy is issued on drain timeout or failure.
    await platform.drain(target, old, Math.max(1, Math.ceil(input.timeoutMs / 1000)));
    const assertQuiesced = async () => {
      await readyPeer();
      const h = await platform.health(target, old);
      if (!h.ok || h.state !== "drained" || h.identity.instanceId !== oldAdmission.instanceId)
        throw new Error("Old worker drain unconfirmed");
    };
    await setDesiredSessionGeneration(
      prisma,
      {
        service: target.slot,
        expectedGeneration: input.expectedGeneration,
        desiredGeneration: input.generation,
        replacement: lease,
      },
      { withQuiescedSlot: (run) => run(assertQuiesced) },
    );
    await readyPeer();
    await platform.stop(target, old);
    await poll(() => platform.finished(target, old));
    if ((await listSessionAdmissions(prisma)).some((row) => row.token === oldAdmission.token)) {
      await releaseSessionAdmission(prisma, oldAdmission, {
        withStoppedInstance: (run) =>
          run(async () => {
            if (!(await platform.finished(target, old)))
              throw new Error("Old container still running");
          }),
      });
    }
    await readyPeer();
    if ((await listSessionAdmissions(prisma)).some((row) => row.service === target.slot))
      throw new Error("Old slot reservation remains; deployment prohibited");
    await platform.deploy(target, input.generation);
    await poll(async () => {
      const ids = await platform.containers(target);
      if (ids.length !== 1 || ids[0] === old) return false;
      const next = await platform.health(target, ids[0]!);
      return (
        next.ok &&
        next.state === "ready" &&
        next.identity.generation === input.generation &&
        next.identity.instanceId !== oldAdmission.instanceId &&
        (await listSessionAdmissions(prisma)).some(
          (row) =>
            row.service === target.slot &&
            row.instanceId === next.identity.instanceId &&
            row.generation === input.generation &&
            row.status === "active",
        )
      );
    });
    await releaseSessionReplacement(prisma, lease);
    return { status: "completed" as const, slot: target.slot, generation: input.generation };
  } catch (error) {
    return {
      status: "postponed" as const,
      slot: target.slot,
      reason: error instanceof Error ? error.message : String(error),
      recoveryOwner: lease.owner,
    };
  }
}
