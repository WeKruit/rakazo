import type { ActionApprovalRule, RunBudgetLimit } from "@rakazo/core";
import {
  BLOCKED_TOOL_REFUSAL,
  blockedToolEffect,
  connectorKindFromToolName,
  runBudgetStopText,
  toolReadsExternalText,
  unattendedMemoryWrite,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { builtinAgentTools } from "../builtin-tools.js";
import type { RunLimitFact, ToolBlock, ToolCallFacts } from "./guardrails.js";
import type { RunProjectionDeps } from "./run-projection.js";
import { publishMessage } from "./run-projection.js";

const BUILTIN_AGENT_TOOL_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));

/** Whether this run has called a tool that reads outside text (web pages, mail, files). */
export async function runHasReadExternalText(
  prisma: Pick<PrismaClient, "event">,
  run: { runId: string; threadId: string },
): Promise<boolean> {
  const called = await prisma.event.findMany({
    where: { runId: run.runId, threadId: run.threadId, type: "agent.tool.called" },
    select: { payload: true },
  });
  return called.some((event) => {
    const tool = (event.payload as { name?: unknown } | null)?.name;
    return (
      typeof tool === "string" && toolReadsExternalText(tool, !BUILTIN_AGENT_TOOL_NAMES.has(tool))
    );
  });
}

export interface ToolGateInput {
  prisma: Pick<PrismaClient, "event">;
  threadId: string;
  /** Built-in names this bot turned off. */
  disabledBuiltinTools: ReadonlySet<string>;
  /** The owner's block and hide rules. */
  loadOwnerToolRules(): Promise<ActionApprovalRule[]>;
  connectedProviders: readonly string[];
  /** A connector tool's declared read-only flag, by its exposed name. */
  readOnly(toolName: string): boolean | undefined;
  /** What started the run: a person's message unless the caller knows otherwise. */
  trigger?(runId: string): string;
}

/**
 * The checks a call meets before it runs, from the same decision functions the executor uses
 * (core action-approval): a tool the bot turned off, an owner's block rule, and memory saved by
 * a run no person started after it read outside text. Approval and send cards are not decided
 * here: the executor shows them when the call reaches it. The reason states facts only.
 */
export function createToolGate(
  input: ToolGateInput,
): (call: ToolCallFacts) => Promise<ToolBlock | undefined> {
  return async (call) => {
    const name = call.toolName;
    if (input.disabledBuiltinTools.has(name))
      return { reason: "This tool is disabled for this bot." };
    const readOnly = input.readOnly(name);
    const rules = await input.loadOwnerToolRules();
    if (
      blockedToolEffect({
        toolName: name,
        connectorKind: connectorKindFromToolName(name, [...input.connectedProviders]),
        readOnly,
        rules,
      })
    )
      return { reason: BLOCKED_TOOL_REFUSAL };
    const unattended = await unattendedMemoryWrite({
      trigger: input.trigger?.(call.runId) ?? "user",
      toolName: name,
      preference: name === "recruiting_feedback" && call.args.target === "preference",
      readExternalText: () =>
        runHasReadExternalText(input.prisma, { runId: call.runId, threadId: input.threadId }),
    });
    if (unattended && "refusal" in unattended) return { reason: unattended.refusal };
    return undefined;
  };
}

/**
 * Records a run stopped by its cost or time limit the way the run path does: the limit on the
 * run row and the stop reply in the conversation.
 */
export function recordRunLimit(
  deps: Pick<RunProjectionDeps, "prisma" | "events">,
  key: { spaceId: string; threadId: string; botId: string },
): (fact: RunLimitFact) => void {
  return (fact) => {
    const text = runBudgetStopText(fact.limit, fact);
    void (async () => {
      const run = await deps.prisma.run.findFirst({
        where: { id: fact.runId, threadId: key.threadId, botId: key.botId },
        select: { trigger: true },
      });
      if (!run) return;
      await deps.prisma.run.updateMany({
        where: { id: fact.runId, threadId: key.threadId, botId: key.botId },
        data: { stopKind: fact.limit satisfies RunBudgetLimit },
      });
      await publishMessage(deps, { ...key, id: fact.runId, trigger: run.trigger }, "bot", [
        { kind: "text", text },
      ]);
    })().catch((error) =>
      getLogger().warn("run limit not recorded", { runId: fact.runId, error: String(error) }),
    );
  };
}
