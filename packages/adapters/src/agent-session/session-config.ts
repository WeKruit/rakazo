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
import {
  pruneComputerScreenshotContext,
  pruneStalePageStateContext,
  pruneStaleToolResults,
} from "../pi-runtime.js";
import type { GuardrailDeps } from "./guardrails.js";
import { installGuardrails } from "./guardrails.js";
import type { RakazoToolContext } from "./harness-tools.js";
import { toHarnessTool } from "./harness-tools.js";

/**
 * Fixed sections keep recruiting constraints and decisions anchored across repeated
 * compactions; an omitted section would otherwise silently drop on the next merge.
 */
export const HISTORY_SUMMARY_TEMPLATE = [
  "Use exactly these sections in this order, each as a heading, and write (none) under any empty section:",
  "## Goal: the human's current objective and the roles in play.",
  "## Requirements and preferences: hard requirements, preferences, exclusions, location, compensation, disclosure limits and the human's standing working preferences.",
  "## Candidates and decisions: people advanced, held, passed or rejected with the stated reason, and approvals given or refused, each with its message reference.",
  "## Progress: completed work and current state, such as searches, saved results, drafts and scheduling, with actual counts.",
  "## Open questions and next steps: unanswered questions, pending cards or approvals and promised follow-ups.",
  "## Critical references: exact message and artifact IDs, provider task references, URLs, numbers and dates needed to continue.",
  "## Mistakes to avoid: corrections the human made and failed attempts not to repeat.",
  "Copy the human's wording, names, numbers, IDs and URLs verbatim; never paraphrase a constraint. Do not pad. When space runs short, condense settled history before current requirements, open items and references.",
].join("\n");

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
