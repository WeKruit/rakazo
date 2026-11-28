import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { isRecruitingSpawnKey, RECRUITER_LANGUAGE, recruitingBotKey } from "@rakazo/core";
import { parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  decryptAgentEnvironment,
  formatAgentEnvironmentInstruction,
} from "../agent-environment.js";
import { commandCredentialRedactions, loadBotCommandEnvironment } from "../bot-secrets.js";
import { createBrowserProvider } from "../browser-provider-factory.js";
import { cloudAgentsEnabled } from "../cloud-agent-factory.js";
import type { ExecutorDeps } from "../executor.js";
import { loadGroupContext } from "../group-handoff.js";
import { modelAcceptsImageInput } from "../model-vision.js";
import { listAgentSkillRecords } from "../skill-tools.js";
import { TASK_CATALOG_GUIDANCE } from "../task-catalog.js";
import { createAccountModels } from "./harness-models.js";
import type { SessionToolHost } from "./run-turns.js";
import type { SessionConfig } from "./session-config.js";
import { buildSessionConfig } from "./session-config.js";
import type { ModelDeps } from "./session-models.js";
import { loadSessionModelRequest } from "./session-models.js";
import {
  assembleRunTools,
  CARD_TOOL_NAMES,
  loadRunConnections,
  toAgentTools,
} from "./session-tools.js";
import {
  agentSkillsLineFor,
  botInstructionsFor,
  computerInstructionFor,
  loadBotDirectory,
  messagingContextFor,
  pluginLineFor,
  runReplyGuidance,
  runSystemPrompt,
  taughtSkillsLineFor,
  workspaceInstructionFor,
} from "./system-prompt.js";
import { createToolGate, recordRunLimit } from "./tool-gate.js";

export type SessionLoadDeps = ModelDeps &
  Pick<
    ExecutorDeps,
    | "runtime"
    | "events"
    | "sandbox"
    | "browser"
    | "connector"
    | "memoryProviders"
    | "cloudAgent"
    | "messaging"
    | "email"
    | "ticketBoardEnabled"
    | "contextStrategy"
    | "listConnectedPluginSlugs"
  > & {
    /** Executes the session's tools: the run path's executor behind a ToolHost. */
    toolHost(models: { models: Models; model: Model<Api> }): SessionToolHost;
    /** Receives secret values that must never reach a projected row. */
    registerSecrets?(values: string[]): void;
    /** What started a run: a person's message unless the caller knows otherwise. */
    trigger?(runId: string): string;
  };

export interface SessionKey {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
}

const SESSION_TRIGGER = "user";

/**
 * A (thread, bot) session's configuration from the database alone: the system prompt, tools,
 * models and guardrails a person's turn on the old run path gets for that bot.
 */
export async function loadSessionConfig(
  deps: SessionLoadDeps,
  key: SessionKey,
): Promise<SessionConfig> {
  const scope = { spaceId: key.spaceId, userId: key.userId };
  const botScope = { ...scope, botId: key.botId };
  const [
    bot,
    thread,
    storedConnections,
    configuredMemory,
    savedSkills,
    agentSkills,
    agentSecretRows,
    botCommandEnvironment,
  ] = await Promise.all([
    deps.prisma.bot.findFirstOrThrow({
      where: { id: key.botId, spaceId: key.spaceId, userId: key.userId, archivedAt: null },
      include: { computer: true },
    }),
    deps.prisma.thread.findFirstOrThrow({ where: { id: key.threadId, spaceId: key.spaceId } }),
    deps.prisma.connection.findMany({
      where: scope,
      select: {
        id: true,
        connectorId: true,
        provider: true,
        providerRef: true,
        displayName: true,
        status: true,
      },
    }),
    deps.memoryProviders.resolve(key.spaceId),
    deps.prisma.taughtSkill.findMany({
      where: { botId: key.botId, spaceId: key.spaceId, status: "saved" },
    }),
    listAgentSkillRecords(deps.prisma, scope),
    deps.prisma.agentSecret.findMany({
      where: { spaceId: key.spaceId },
      select: { name: true, secret: { select: { id: true, ciphertext: true } } },
    }),
    loadBotCommandEnvironment(deps.prisma, deps.secretStore, botScope),
  ]);
  if (!bot.computer) throw new Error("Bot has no computer");
  const agentEnvironment = await decryptAgentEnvironment(agentSecretRows, deps.secretStore);
  deps.registerSecrets?.([
    ...Object.values(agentEnvironment),
    ...commandCredentialRedactions(botCommandEnvironment),
  ]);
  const { connectedPlugins, connectedComposio } = await loadRunConnections(
    deps,
    scope,
    storedConnections,
  );
  const discovered = deps.connector
    ? await deps.connector.discoverTools({
        operationId: `session:${key.threadId}:${key.botId}`,
        traceId: `session:${key.threadId}:${key.botId}`,
        spaceId: key.spaceId,
        userId: key.userId,
        botId: key.botId,
        accountWideConversation: Boolean(thread.groupId?.startsWith("recruiting-global-")),
        signal: new AbortController().signal,
        connectedConnections: connectedPlugins.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          externalId: row.provider,
          displayName: row.displayName,
          providerRef: row.providerRef ?? undefined,
        })),
        connectedProviders: connectedComposio.map((row) => row.provider),
      })
    : [];
  const model = await loadSessionModelRequest(deps, botScope, deps.registerSecrets);
  const computerKind = bot.computer.kind;
  const graphical = computerKind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
  const acceptsImages =
    deps.runtime.describe().capabilities.scripted ||
    modelAcceptsImageInput(model.model.provider, model.model.id, model.model.acceptsImages);
  const browser = deps.browser ?? createBrowserProvider(undefined, { sandbox: deps.sandbox });
  const hasMessagingIdentity = deps.messaging ? await deps.messaging.hasIdentity(bot.id) : false;
  let rulesPromise: Promise<ActionApprovalRule[]> | undefined;
  const loadOwnerToolRules = () => {
    rulesPromise ??= deps.prisma.actionApprovalRule
      .findMany({
        where: { spaceId: key.spaceId, createdByUserId: key.userId },
        select: { effect: true, matchKind: true, matchValue: true },
      })
      .then((rules) => rules as ActionApprovalRule[])
      .catch((error: unknown) => {
        getLogger().warn("tool_rules.load_failed", {
          threadId: key.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
    return rulesPromise;
  };
  const assembled = await assembleRunTools({
    prisma: deps.prisma,
    ticketBoardEnabled: deps.ticketBoardEnabled,
    email: Boolean(deps.email),
    historyRetrievalEnabled: (deps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY) !== "current",
    graphical,
    acceptsImages,
    pageBrowser: browser.describe().capabilities.page,
    heldForTakeover: false,
    run: { trigger: SESSION_TRIGGER, spaceId: key.spaceId },
    bot,
    thread,
    semanticMemoryEnabled: Boolean(configuredMemory?.provider),
    cloudAgentEnabled: cloudAgentsEnabled(deps.cloudAgent, key.spaceId),
    messagingChannelRun: false,
    voiceCall: false,
    hasMessagingIdentity,
    discovered,
    loadOwnerToolRules,
    connectedPlugins,
  });
  const { tools, disabledBuiltinTools } = assembled;
  // A recruiter never sees a provider's name; a bot with the people search is recruiting too.
  const hideVendors = Boolean(
    isRecruitingSpawnKey(bot.spawnKey) ||
      thread.activeRecruitingRoleId ||
      (!bot.spawnKey && recruitingBotKey(bot) && recruitingBotKey(bot) !== "main") ||
      assembled.recruitingSearch,
  );
  const [groupContext, botDirectory] = await Promise.all([
    thread.groupId
      ? loadGroupContext(deps.prisma, thread.groupId, { id: bot.id, name: bot.name })
      : undefined,
    loadBotDirectory(deps.prisma, { ...botScope, groupId: thread.groupId }),
  ]);
  const systemPrompt = runSystemPrompt({
    botInstructions: botInstructionsFor(thread.groupId, bot, SESSION_TRIGGER),
    groupContext,
    messagingContext: messagingContextFor(hasMessagingIdentity, false),
    // A session always carries its history and compaction summaries.
    hasHistoricalContext: true,
    computerInstruction: computerInstructionFor({
      heldForTakeover: false,
      graphicalToolsAllowed: assembled.graphicalToolsAllowed,
      graphical,
      disabled: disabledBuiltinTools,
      computerKind,
    }),
    pageBrowserAllowed: assembled.pageBrowserAllowed,
    taskCatalogInstruction: tools.some((tool) => tool.name === "task_catalog")
      ? TASK_CATALOG_GUIDANCE
      : undefined,
    workspaceInstruction: workspaceInstructionFor(parseComputerMode(bot.computer.scope), bot.id),
    agentEnvironmentInstruction: formatAgentEnvironmentInstruction({
      ...agentEnvironment,
      ...botCommandEnvironment,
    }),
    botDirectory,
    pluginLine: pluginLineFor(connectedPlugins),
    agentSkillsLine: agentSkillsLineFor({
      skills: agentSkills,
      agentScope: assembled.agentScope,
      toolNames: tools.map((tool) => tool.name),
      secretNames: agentSecretRows.map((row) => row.name),
    }),
    taughtSkillsLine: taughtSkillsLineFor(savedSkills),
    replyGuidance: runReplyGuidance(SESSION_TRIGGER),
    disabledBuiltinTools,
    recruiterLanguage: hideVendors ? RECRUITER_LANGUAGE : undefined,
  });
  const models = createAccountModels({ ...model, tools });
  if (!models) throw new Error(`Model ${model.model.provider}/${model.model.id} is not available`);
  const toolHost = deps.toolHost(models);
  return buildSessionConfig({
    ...models,
    hideVendors,
    beforeExecute: (operationId) => toolHost.ready(operationId),
    ...(model.model.thinkingLevel ? { thinkingLevel: model.model.thinkingLevel } : {}),
    systemPrompt,
    tools: toAgentTools(tools, toolHost, { perCallSignal: true }),
    maxImagesPerPrompt: model.model.maxImagesPerPrompt,
    guardrails: {
      checkTool: createToolGate({
        prisma: deps.prisma,
        threadId: key.threadId,
        disabledBuiltinTools,
        loadOwnerToolRules,
        connectedProviders: connectedComposio.map((row) => row.provider),
        readOnly: (name) => assembled.connectorTools.get(name)?.readOnly,
        trigger: deps.trigger,
      }),
      cardTools: CARD_TOOL_NAMES,
      onRunLimit: recordRunLimit(deps, key),
    },
  });
}
