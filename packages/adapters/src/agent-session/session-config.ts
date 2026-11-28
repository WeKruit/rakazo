import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessStreamOptions,
  AgentHarnessTool,
  AgentLane,
  AgentTool,
  CompactionSettings,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { compact } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { HISTORY_SUMMARY_TEMPLATE } from "../history-compaction.js";
import {
  pruneComputerScreenshotContext,
  pruneStalePageStateContext,
  pruneStaleToolResults,
} from "../pi-runtime.js";
import type { GuardrailDeps } from "./guardrails.js";
import { installGuardrails } from "./guardrails.js";
import type { RakazoToolContext } from "./harness-tools.js";
import { toHarnessTool } from "./harness-tools.js";

/** Pi's defaults (compaction.js:75-79), stated so a Pi upgrade cannot move them silently. */
export const SESSION_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** Everything the session host needs to attach a harness to one (thread, bot) session. */
export interface SessionConfig {
  models: Models;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: NonNullable<AgentHarnessOptions<RakazoToolContext>["systemPrompt"]>;
  tools: AgentHarnessTool<RakazoToolContext>[];
  toolContext?: RakazoToolContext;
  compaction: CompactionSettings;
  retry?: RetryPolicy;
  streamOptions?: AgentHarnessStreamOptions;
  /** Registers hooks once the harness and its lane exist; returns their disposer. */
  install?(harness: AgentHarness<RakazoToolContext>, lane: AgentLane): () => void;
}

export interface SessionConfigPieces {
  models: Models;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: SessionConfig["systemPrompt"];
  tools: AgentTool[];
  guardrails?: GuardrailDeps;
  maxImagesPerPrompt?: number;
  retry?: RetryPolicy;
}

function installContextHooks(
  harness: AgentHarness<RakazoToolContext>,
  pieces: SessionConfigPieces,
): () => void {
  const disposers = [
    harness.hooks.on("transform_context", (event) => ({
      messages: pruneComputerScreenshotContext(
        pruneStaleToolResults(pruneStalePageStateContext(event.messages)),
        pieces.maxImagesPerPrompt,
      ),
    })),
    // Pi's hook cannot change the summary prompt, only replace the result, so the anchored
    // recruiting template runs through Pi's own compactor.
    harness.hooks.on("before_compaction", async (event, context) => {
      const instructions = [HISTORY_SUMMARY_TEMPLATE, event.customInstructions]
        .filter(Boolean)
        .join("\n\n");
      const result = await compact(
        event.preparation,
        pieces.models,
        pieces.model,
        instructions,
        pieces.thinkingLevel,
        pieces.retry,
        undefined,
        context,
      );
      return result.ok ? { compaction: result.value } : undefined;
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * Assembles a session's configuration from pieces the caller has already built for the
 * (thread, bot): models, system prompt and runtime tools.
 */
export function buildSessionConfig(pieces: SessionConfigPieces): SessionConfig {
  return {
    models: pieces.models,
    model: pieces.model,
    ...(pieces.thinkingLevel === undefined ? {} : { thinkingLevel: pieces.thinkingLevel }),
    systemPrompt: pieces.systemPrompt,
    tools: pieces.tools.map((tool) => toHarnessTool(tool)),
    compaction: SESSION_COMPACTION,
    ...(pieces.retry === undefined ? {} : { retry: pieces.retry }),
    install(harness, lane) {
      const disposers = [
        installContextHooks(harness, pieces),
        installGuardrails(harness, lane, pieces.guardrails ?? {}),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
  };
}
