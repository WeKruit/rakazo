import { ORPCError } from "@orpc/server";
import type { Actor, RunTrace } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** Read the same account-owned history the runtime writes; never another account's trace. */
export async function readRunTrace(
  prisma: PrismaClient,
  actor: Actor,
  input: { runId: string; includeDiagnostics: boolean },
): Promise<RunTrace> {
  if (!actor.isDeploymentOwner || !input.includeDiagnostics) throw new ORPCError("FORBIDDEN");
  const run = await prisma.run.findFirst({
    where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      id: true,
      status: true,
      threadId: true,
      startedAt: true,
      createdAt: true,
      completedAt: true,
    },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const [events, usage] = await Promise.all([
    prisma.event.findMany({
      where: {
        spaceId: actor.spaceId,
        threadId: run.threadId,
        runId: run.id,
        type: {
          in: [
            "agent.tool.called",
            "agent.tool.completed",
            "group.handoff",
            "thread.message.created",
            "thread.subagent",
            "run.requeued",
            "thread.progress",
            "run.completed",
          ],
        },
      },
      orderBy: { seq: "asc" },
      select: { id: true, botId: true, type: true, payload: true, createdAt: true },
    }),
    prisma.usageRecord.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, runId: run.id, unit: "tokens" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        model: true,
        createdAt: true,
        totalTokens: true,
        costUsd: true,
      },
    }),
  ]);
  const rows: RunTrace["rows"] = [];
  const tools = new Map<string, RunTrace["rows"][number]>();
  const subagents = new Map<string, RunTrace["rows"][number]>();
  for (const event of events) {
    const p =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload
        : {};
    const row: RunTrace["rows"][number] = {
      id: event.id,
      kind: "tool",
      label: typeof p.name === "string" ? p.name : "Tool call",
      startedAt: event.createdAt.toISOString(),
      durationMs: null,
      status: "unknown",
      tokens: null,
      costUsd: null,
    };
    if (event.type === "agent.tool.called") {
      row.status = run.completedAt ? "unknown" : "running";
      if (typeof p.executionId === "string") tools.set(p.executionId, row);
      rows.push(row);
    } else if (event.type === "agent.tool.completed") {
      const call = typeof p.executionId === "string" ? tools.get(p.executionId) : undefined;
      const target = call ?? row;
      target.status =
        p.outcome === "error"
          ? "failed"
          : p.outcome === "paused"
            ? "paused"
            : p.outcome === "succeeded"
              ? "completed"
              : "unknown";
      if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs) && p.durationMs >= 0) {
        target.durationMs = p.durationMs;
        // Tool audits may be flushed after execution: the completion carries measured duration.
        target.startedAt = new Date(event.createdAt.getTime() - p.durationMs).toISOString();
      }
      if (!call) rows.push(target);
      if (typeof p.executionId === "string") tools.delete(p.executionId);
    } else if (event.type === "group.handoff") {
      rows.push({
        ...row,
        kind: "handoff",
        label: `${p.fromBotId ?? "Agent"} → ${p.toBotId ?? "Agent"}`,
        status: "completed",
      });
    } else if (event.type === "thread.message.created" && Array.isArray(p.blocks)) {
      for (const [index, block] of p.blocks.entries()) {
        if (
          !block ||
          typeof block !== "object" ||
          Array.isArray(block) ||
          block.kind !== "bot_message_sent" ||
          typeof block.toBotId !== "string"
        )
          continue;
        rows.push({
          ...row,
          id: `${event.id}:${index}`,
          kind: "handoff",
          label: `${event.botId ?? "Agent"} → ${block.toBotId}`,
          status: "completed",
        });
      }
    } else if (event.type === "thread.subagent" && typeof p.agentId === "string") {
      row.label = typeof p.name === "string" ? p.name : p.agentId;
      if (p.status === "running") {
        if (!subagents.has(p.agentId)) {
          const child = { ...row, kind: "handoff" as const, status: "running" as const };
          subagents.set(p.agentId, child);
          rows.push(child);
        }
      } else {
        const child = subagents.get(p.agentId);
        if (child) {
          child.durationMs = Math.max(0, event.createdAt.getTime() - Date.parse(child.startedAt));
          child.status = p.status === "failed" ? "failed" : "completed";
          subagents.delete(p.agentId);
        } else
          rows.push({
            ...row,
            kind: "handoff",
            status: p.status === "failed" ? "failed" : "completed",
          });
      }
    } else if (
      event.type === "run.completed" &&
      typeof p.modelRetries === "number" &&
      p.modelRetries > 0
    ) {
      rows.push({
        ...row,
        kind: "retry",
        label: `${p.modelRetries} model retries`,
        status: "completed",
      });
    } else if (
      event.type === "run.requeued" ||
      (event.type === "thread.progress" && p.phase === "retrying")
    )
      rows.push({ ...row, kind: "retry", label: "Retry" });
  }
  if (run.completedAt) for (const child of subagents.values()) child.status = "unknown";
  for (const call of usage)
    rows.push({
      id: call.id,
      kind: "model",
      label: `${call.provider} / ${call.model}`,
      startedAt: call.createdAt.toISOString(),
      durationMs: null,
      status: "completed",
      tokens: call.totalTokens,
      costUsd: call.costUsd,
    });
  rows.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return {
    runId: run.id,
    status: run.status as RunTrace["status"],
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    rows,
  };
}
