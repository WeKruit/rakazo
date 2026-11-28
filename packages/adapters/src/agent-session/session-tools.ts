import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolCompletion, ConnectorTool } from "@rakazo/adapter-kit";
import { AskUserInputSchema, disabledBuiltinToolSet } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  isBackgroundRunTrigger,
  recruitingAgentScope,
  shortQuestion,
  withoutHiddenTools,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "../approval-effect.js";
import { agentConnectionTools, builtinAgentTools } from "../builtin-tools.js";
import { selectCloudAgentTools } from "../cloud-agent-tools-select.js";
import { COMPLETION_EMAIL_TOOL, completionEmailTool } from "../completion-email.js";
import type { PluginConnectionRow } from "../composio-connector.js";
import {
  mergeConnectedPlugins,
  needsLivePluginSync,
  planLiveConnectionSync,
} from "../composio-connector.js";
import { egressLocked, loadEgressRules } from "../computer-network.js";
import { databaseConflictText } from "../connector-safety.js";
import { shortenToolResultText } from "../context-selection.js";
import {
  RECORD_TOOL_DEADLINE_MS,
  RECORD_TOOL_LATE_TEXT,
  RECORD_TOOLS,
  withinDeadline,
} from "../deadline.js";
import { selectMemoryTools } from "../memory-tools.js";
import { filterImageReturningComputerTools } from "../model-vision.js";
import type { ToolHost } from "../pi-runtime.js";
import {
  ASK_SUPERSEDED_BY_MESSAGE,
  beginToolCall,
  boundAgentToolResult,
  endToolCall,
  executeSubagent,
  isAgentToolExecutionResult,
  normalizeAgentToolNames,
  parametersFor,
  prepareRequestSecretArguments,
  SLOW_TOOL_BACKGROUND_MS,
  serializeToolResult,
  subagentResultsBeforePause,
  toolOutputStore,
  toolResultJson,
  untilStopped,
} from "../pi-runtime.js";
import {
  clipWithFullOutput,
  spillRequiredResult,
  withoutUndeclaredArguments,
} from "../pi-runtime-limits.js";
import { normalizeRecruitingRoleArgs, repairSourceRefs } from "../recruiting-tools.js";
import { VERBATIM_TOOL_RESULTS } from "../runtime-context.js";
import { filterBuiltinToolsForRun, filterBuiltinToolsForThread } from "../schedule-tools.js";
import { textContentArg } from "../tool-text.js";

// The tools an agent has in a conversation: which ones it is offered, and how each call reaches
// the executor. Moved from executor.ts (continueRun) and pi-runtime.ts so the run path and the
// session path offer the same list from one source.

async function loadLivePluginSlugs(
  listConnectedPluginSlugs: ((userId: string) => Promise<string[]>) | undefined,
  userId: string,
): Promise<{ ok: true; slugs: string[] } | { ok: false }> {
  if (!listConnectedPluginSlugs) return { ok: false };
  try {
    return { ok: true, slugs: await listConnectedPluginSlugs(userId) };
  } catch {
    return { ok: false };
  }
}

export async function persistLivePluginConnections(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
  rows: PluginConnectionRow[],
  liveSlugs: string[],
): Promise<void> {
  const sync = planLiveConnectionSync(rows, liveSlugs);
  if (sync.connectIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.connectIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
      },
      data: { status: "connected" },
    });
    for (const row of rows) {
      if (sync.connectIds.includes(row.id)) row.status = "connected";
    }
  }
  if (sync.revokeIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.revokeIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
      },
      data: { status: "revoked" },
    });
    for (const row of rows) {
      if (sync.revokeIds.includes(row.id)) row.status = "revoked";
    }
  }
}

export function selectBuiltinToolsForRun(options: {
  ticketBoardEnabled?: boolean;
  historyRetrievalEnabled?: boolean;
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  semanticMemoryEnabled: boolean;
  cloudAgentEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Hanging up is only offered to a turn the caller spoke on a live call. */
  voiceCall?: boolean;
  /** Built-in names this bot turned off. Unknown names are ignored. */
  disabledBuiltinTools?: readonly string[];
  /** The agent's own tool list; every builtin when absent (Claude Code subagent `tools:`). */
  allowedBuiltinTools?: readonly string[];
}) {
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const allowed = options.allowedBuiltinTools && new Set(options.allowedBuiltinTools);
  return selectCloudAgentTools(
    selectMemoryTools(
      filterBuiltinToolsForRun(
        filterBuiltinToolsForThread(
          filterPageBrowserTools(
            filterImageReturningComputerTools(builtinAgentTools, options.graphicalToolsAllowed),
            options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
          ),
          options.groupId,
        ),
        options.trigger,
      ),
      options.semanticMemoryEnabled,
    ),
    Boolean(options.cloudAgentEnabled),
  ).filter(
    (tool) =>
      !disabled.has(tool.name) &&
      (!allowed || allowed.has(tool.name)) &&
      (options.ticketBoardEnabled ||
        (tool.name !== "board_tickets" && !tool.name.startsWith("ticket_"))) &&
      (!isBackgroundRunTrigger(options.trigger) ||
        ![
          "message_user",
          "message_bot",
          "delegate_work",
          "stop_work",
          "handoff_to_bot",
          "message_agent",
          "create_poll",
          "vote_poll",
          "render_view",
          "canvas_write",
        ].includes(tool.name)) &&
      (options.voiceCall || tool.name !== "end_call") &&
      (options.historyRetrievalEnabled ||
        !["search_history", "read_history"].includes(tool.name)) &&
      (!options.messagingChannelRun ||
        (![
          "remember",
          "recruiting_role",
          "recruiting_candidates",
          "recruiting_shortlist",
          "recruiting_feedback",
          "recruiting_research",
          "recruiting_crm_target",
          "recruiting_crm_import",
          "read_memory",
          "save_shared_memory",
          "save_group_memory",
          "save_memory",
          "recall_memory",
          "forget_memory",
          "task_catalog",
          "board_tickets",
          "create_poll",
          "vote_poll",
          "render_view",
          "canvas_write",
          "canvas_read",
        ].includes(tool.name) &&
          !tool.name.startsWith("scratchpad_") &&
          !tool.name.startsWith("ticket_"))),
  );
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}

export function selectRunConnections<
  T extends { connectorId: string; provider: string; status: string },
>(rows: T[], connectedComposioProviders: string[]): T[] {
  const liveProviders = new Set(
    connectedComposioProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const connectedKeys = new Set(
    rows
      .filter((row) => row.status === "connected")
      .map((row) => `${row.connectorId}:${row.provider.trim().toLowerCase()}`),
  );
  return rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.status === "revoked") return false;
    // Recover a pending/error Composio row only when this provider has no
    // connected row of its own. A sibling that shares the slug must not
    // pull a non-live row — and its dead providerRef — into the run.
    if (row.connectorId !== "composio") return false;
    if (row.status !== "pending" && row.status !== "error") return false;
    const providerKey = row.provider.trim().toLowerCase();
    if (!liveProviders.has(providerKey)) return false;
    return !connectedKeys.has(`composio:${providerKey}`);
  });
}

/** The run's connections: stored rows, with Composio's live list when it must be re-read. */
export async function loadRunConnections<
  T extends PluginConnectionRow & { connectorId: string; provider: string; status: string },
>(
  deps: {
    prisma: PrismaClient;
    listConnectedPluginSlugs?: (userId: string) => Promise<string[]>;
  },
  run: { userId: string; spaceId: string },
  storedConnections: T[],
) {
  const composioRows = storedConnections.filter(
    (connection) => connection.connectorId === "composio",
  );
  let liveSlugs: string[] = [];
  if (needsLivePluginSync(composioRows)) {
    const listing = await loadLivePluginSlugs(deps.listConnectedPluginSlugs, run.userId);
    if (listing.ok) {
      liveSlugs = listing.slugs;
      // Bookkeeping for the next run; this run already uses the live list.
      void persistLivePluginConnections(deps.prisma, run, composioRows, listing.slugs).catch(
        () => undefined,
      );
    }
  }
  const connectedComposio = mergeConnectedPlugins(composioRows, liveSlugs);
  const connectedPlugins = selectRunConnections(
    storedConnections,
    connectedComposio.map((connection) => connection.provider),
  );
  return { connectedPlugins, connectedComposio };
}

export interface RunToolsInput {
  prisma: PrismaClient;
  ticketBoardEnabled?: boolean;
  /** The deployment can send completion emails. */
  email: boolean;
  historyRetrievalEnabled: boolean;
  /** The bot's computer has a screen. */
  graphical: boolean;
  /** The run's model reads images, or the runtime is scripted. */
  acceptsImages: boolean;
  /** The page browser can drive this computer. */
  pageBrowser: boolean;
  heldForTakeover: boolean;
  run: { trigger: string; spaceId: string };
  bot: { disabledBuiltinTools: string[] } & Parameters<typeof recruitingAgentScope>[0];
  thread: { groupId: string | null; activeRecruitingRoleId: string | null };
  semanticMemoryEnabled: boolean;
  cloudAgentEnabled: boolean;
  messagingChannelRun: boolean;
  voiceCall: boolean;
  hasMessagingIdentity: boolean;
  /** Connector tools discovered for this run. */
  discovered: ConnectorTool[];
  /** The owner's block and hide rules. */
  loadOwnerToolRules(): Promise<ActionApprovalRule[]>;
  connectedPlugins: ReadonlyArray<{ provider: string }>;
}

/** The tools a bot is offered in a thread, as continueRun has always listed them. */
export async function assembleRunTools(input: RunToolsInput) {
  const {
    prisma,
    ticketBoardEnabled,
    email,
    historyRetrievalEnabled,
    graphical,
    acceptsImages,
    pageBrowser,
    heldForTakeover,
    run,
    bot,
    thread,
    semanticMemoryEnabled,
    cloudAgentEnabled,
    messagingChannelRun,
    voiceCall,
    hasMessagingIdentity,
    discovered,
    loadOwnerToolRules,
    connectedPlugins,
  } = input;
  const graphicalToolsAllowed = graphical && acceptsImages && !heldForTakeover;
  const pageBrowserAllowed = graphical && pageBrowser && !heldForTakeover;
  // A recruiting agent is offered its own tools and skills (Claude Code subagent `tools:`).
  const agentScope = recruitingAgentScope(bot, thread.groupId);
  const runDisabledBuiltinTools = bot.disabledBuiltinTools;
  const disabledBuiltinTools = disabledBuiltinToolSet(runDisabledBuiltinTools);
  const builtins = [
    ...selectBuiltinToolsForRun({
      ticketBoardEnabled: ticketBoardEnabled,
      historyRetrievalEnabled: historyRetrievalEnabled,
      graphicalToolsAllowed,
      pageBrowserAllowed,
      groupId: thread.groupId,
      trigger: run.trigger,
      semanticMemoryEnabled,
      cloudAgentEnabled: cloudAgentEnabled,
      messagingChannelRun,
      voiceCall,
      disabledBuiltinTools: runDisabledBuiltinTools,
      allowedBuiltinTools: agentScope?.tools,
    }),
    ...(email && !messagingChannelRun && !disabledBuiltinTools.has(COMPLETION_EMAIL_TOOL)
      ? [completionEmailTool]
      : []),
    // Cross-owner agent connections only exist for chat-linked bots.
    ...(hasMessagingIdentity && !isBackgroundRunTrigger(run.trigger)
      ? agentConnectionTools.filter((tool) => !disabledBuiltinTools.has(tool.name))
      : []),
  ];
  // Before a role's first round the people search is already listed and the turn ends on
  // the next-step card, so the tool catalog would only cost a lookup step. A role built from
  // the recruiter's own list may never have a round, so it keeps the catalog.
  // A bot with the people search is recruiting, even before a role is linked to the thread:
  // older crews' Main has no recruiting spawn key, so its first turns would get no English or
  // vendor-name rules.
  const recruitingSearch = discovered.some((tool) => tool.name.endsWith("web_search_advanced_exa"));
  const firstRoundPending =
    Boolean(thread.activeRecruitingRoleId) &&
    recruitingSearch &&
    !(await prisma.recruitingCalibrationRound.findFirst({
      where: {
        roleId: thread.activeRecruitingRoleId ?? "",
        role: { spaceId: run.spaceId },
      },
      select: { id: true },
    })) &&
    !(await prisma.externalEffect.findFirst({
      where: {
        spaceId: run.spaceId,
        kind: "recruiting_research",
        status: "completed",
        AND: [
          { request: { path: ["operation"], equals: "import_csv" } },
          {
            request: {
              path: ["roleId"],
              equals: thread.activeRecruitingRoleId ?? "",
            },
          },
        ],
      },
      select: { id: true },
    }));
  // A role that emails people the recruiter named may never have a round: once its sending
  // campaign exists, the role keeps the catalog that holds its sending tools (gate 44c1ad44:
  // a turn after the card could not save a corrected email or answer about its sends).
  const hideCatalog =
    firstRoundPending &&
    !(await prisma.externalEffect.findFirst({
      where: {
        spaceId: run.spaceId,
        kind: "instantly_role_campaign",
        status: "completed",
        request: { path: ["roleId"], equals: thread.activeRecruitingRoleId ?? "" },
      },
      select: { id: true },
    }));
  const exposedConnectorTools = discovered.filter(
    (tool) =>
      !builtinAgentTools.some((builtin) => builtin.name === tool.name) &&
      !(hideCatalog && /_(search_tools|load_tool|execute_tool)$/.test(tool.name)),
  );
  const connectorTools = new Map(exposedConnectorTools.map((tool) => [tool.name, tool] as const));
  // The intro turn confirms how a bot read its own role before anyone hands it
  // real work — it must not be able to act on that reading (shell, computer,
  // scheduling, spawning another bot, ...) before the user has assigned any task.
  // Asking to allow a site only means something on a computer limited to allowed sites.
  const sitesLimited = await Promise.resolve()
    .then(() => loadEgressRules(prisma, run.spaceId))
    .then(egressLocked, () => false);
  const listedTools = withoutHiddenTools(
    [...builtins, ...exposedConnectorTools].filter(
      (tool) => sitesLimited || tool.name !== "allow_computer_site",
    ),
    await loadOwnerToolRules(),
    connectedPlugins.map((plugin) => plugin.provider),
  );
  const tools = run.trigger === "created" ? [] : listedTools;
  return {
    agentScope,
    graphicalToolsAllowed,
    pageBrowserAllowed,
    disabledBuiltinTools,
    recruitingSearch,
    firstRoundPending,
    connectorTools,
    tools,
  };
}

/**
 * Tools whose call shows the person a card and ends the turn: a question, a takeover of the
 * screen, or protected input. The answer arrives as the person's next input.
 */
export const CARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ask_user",
  "request_takeover",
  "request_secret",
]);

/** Where a tool call's stop comes from. */
export interface ToolAbortSource {
  /** A harness session: each call's own signal (per-call Stop). Otherwise the host's signal. */
  perCallSignal?: boolean;
}

export function toAgentTools(
  toolDefs: readonly ConnectorTool[],
  host: ToolHost,
  options: ToolAbortSource = {},
): AgentTool[] {
  // Registration order is incidental. Canonicalize before allocating collision suffixes
  // so both provider-visible names and JSON schema serialization stay stable.
  const canonicalJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonicalJson(item)]),
      );
    }
    return value;
  };
  const ordered = toolDefs
    .map((tool) => ({
      tool: {
        ...tool,
        inputSchema: canonicalJson(tool.inputSchema) as Record<string, unknown>,
      },
      key: JSON.stringify(canonicalJson(tool)),
    }))
    .sort((a, b) =>
      a.tool.name < b.tool.name
        ? -1
        : a.tool.name > b.tool.name
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    )
    .map(({ tool }) => tool);
  const names = normalizeAgentToolNames(ordered);
  return ordered.map((tool, index) => toAgentTool(tool, host, names[index]!, options));
}

function toAgentTool(
  tool: ConnectorTool,
  host: ToolHost,
  exposedName: string,
  options: ToolAbortSource,
): AgentTool {
  return {
    name: exposedName,
    label: tool.name,
    description: tool.description,
    parameters: parametersFor(tool),
    prepareArguments: (args: unknown) => {
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (tool.name === "destination.write") {
        return {
          collection: String(raw.collection ?? "notes"),
          title: String(raw.title ?? "Rakazo result"),
          body: String(raw.body ?? ""),
        };
      }
      if (tool.name === "remember") {
        return {
          // An edit carries no content; an undefined value here failed every edit-mode save.
          ...(raw.content === undefined ? {} : { content: raw.content }),
          path: String(raw.path ?? "MEMORY.md"),
          expectedRevision: raw.expectedRevision,
          // The schema offers a partial edit; dropping it here failed every edit-mode save.
          ...(raw.edit === undefined ? {} : { edit: raw.edit }),
          ...(raw.recruitingFeedback === undefined
            ? {}
            : { recruitingFeedback: raw.recruitingFeedback }),
        };
      }
      // Repair slips before the schema check so they never reject a regenerated brief.
      if (tool.name === "recruiting_role")
        return normalizeRecruitingRoleArgs(raw, new Date().toISOString());
      // A preference cites the recruiter's words; a citation written in another tool's shape is
      // rewritten to this one instead of failing the save.
      if (tool.name === "recruiting_feedback" && raw.target === "preference") {
        const sourceRefs = repairSourceRefs(raw.sourceRefs, new Date().toISOString());
        return sourceRefs ? { ...raw, sourceRefs } : raw;
      }
      // The server fills sources and names the people; an empty list reaches it for a precise error.
      if (tool.name === "recruiting_feedback" && raw.target !== "preference") {
        const { candidateKeys, ...rest } = raw;
        return {
          ...rest,
          sourceRefs: Array.isArray(raw.sourceRefs) ? raw.sourceRefs : [],
          ...(typeof candidateKeys === "string"
            ? { candidateKeys: [candidateKeys] }
            : Array.isArray(candidateKeys) && candidateKeys.length
              ? { candidateKeys }
              : {}),
        };
      }
      if (tool.name === "request_takeover") {
        return { reason: String(raw.reason ?? "I need you on the screen.") };
      }
      if (tool.name === "ask_user") {
        // An over-long option keeps its start instead of failing the card (80 characters).
        const options = Array.isArray(raw.options)
          ? raw.options.map((option) => {
              const text = String(option).trim();
              return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
            })
          : raw.options;
        return {
          // An over-long question loses its leading sentences instead of failing the card.
          question: shortQuestion(String(raw.question ?? "What should I use?")),
          // Keep a missing/invalid options value as-is so schema minItems can reject it;
          // do not coerce to [] (that used to look like a valid empty list upstream).
          ...(options === undefined ? {} : { options }),
          ...(raw.multiple === undefined ? {} : { multiple: raw.multiple }),
          ...(raw.requestedSchema === undefined ? {} : { requestedSchema: raw.requestedSchema }),
        };
      }
      if (tool.name === "request_secret") {
        return prepareRequestSecretArguments(raw);
      }
      if (tool.name === "write_file") {
        return {
          ...(raw.path === undefined ? {} : { path: String(raw.path) }),
          ...(Object.hasOwn(raw, "content") ? { content: textContentArg(raw.content, "") } : {}),
          ...(Object.hasOwn(raw, "artifactId") ? { artifactId: raw.artifactId } : {}),
        };
      }
      if (tool.name === "computer_act") {
        return {
          actions: Array.isArray(raw.actions) ? raw.actions : [],
          observe: raw.observe === undefined ? true : Boolean(raw.observe),
          settle_ms: Number(raw.settle_ms ?? 350),
        };
      }
      if (tool.name === "list_files") return { path: String(raw.path ?? "") };
      if (tool.name === "read_file" || tool.name === "open_path") {
        return { path: String(raw.path ?? "") };
      }
      if (tool.name === "launch_app") {
        return {
          application: String(raw.application ?? ""),
          uri: raw.uri ? String(raw.uri) : "",
        };
      }
      if (tool.name === "shell") {
        return {
          command: String(raw.command ?? ""),
          // The executor chooses the bot-scoped default, including Team workspaces.
          ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
        };
      }
      if (tool.name === "run_subagent") {
        return {
          name: String(raw.name ?? "helper"),
          task: String(raw.task ?? ""),
          instructions: raw.instructions ? String(raw.instructions) : "",
          model_provider: raw.model_provider ? String(raw.model_provider) : "",
          model_id: raw.model_id ? String(raw.model_id) : "",
          ...(raw.background === true ? { background: true } : {}),
          ...(raw.handle ? { handle: String(raw.handle) } : {}),
          ...(Array.isArray(raw.wait) ? { wait: raw.wait.map(String) } : {}),
          ...(raw.timeout_seconds !== undefined ? { timeout_seconds: raw.timeout_seconds } : {}),
        };
      }
      if (tool.name === "spawn_bot") {
        return {
          name: String(raw.name ?? ""),
          title: raw.title ? String(raw.title) : "",
          instructions: raw.instructions ? String(raw.instructions) : "",
          prompt: raw.prompt ? String(raw.prompt) : "",
          computer_mode: raw.computer_mode ? String(raw.computer_mode) : "",
        };
      }
      if (tool.name === "update_bot") {
        const notifyRaw = raw.notifyOnFinish ?? raw.notify_on_finish;
        return {
          ...(raw.name !== undefined ? { name: String(raw.name) } : {}),
          ...(raw.title !== undefined ? { title: String(raw.title) } : {}),
          ...(raw.description !== undefined ? { description: String(raw.description) } : {}),
          ...(raw.color !== undefined ? { color: String(raw.color) } : {}),
          ...(raw.artifact_id !== undefined ? { artifact_id: String(raw.artifact_id) } : {}),
          ...(raw.use_attached_image !== undefined
            ? { use_attached_image: raw.use_attached_image }
            : {}),
          ...(notifyRaw !== undefined ? { notifyOnFinish: notifyRaw } : {}),
        };
      }
      if (tool.name === "create_space") {
        return { name: String(raw.name ?? "") };
      }
      if (tool.name === "archive_bot" || tool.name === "delete_bot") {
        return {
          confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
          bot_id: raw.bot_id ? String(raw.bot_id) : raw.botId ? String(raw.botId) : "",
        };
      }
      return withoutUndeclaredArguments(raw, tool.inputSchema) as never;
    },
    execute: async (toolCallId, params, callSignal): Promise<AgentToolResult<unknown>> => {
      // A harness session stops each call through its own signal; the run path stops the host.
      const signal = options.perCallSignal && callSignal ? callSignal : host.signal;
      signal.throwIfAborted();
      const args = (params ?? {}) as Record<string, unknown>;
      const rawCallId =
        toolCallId || `${host.request.runId}:${tool.name}:${host.toolCallSeq.value++}`;
      // Backend idempotency includes the agent namespace; Pi wire IDs remain untouched.
      const executionId = JSON.stringify(["pi-tool", host.agentNamespace ?? "main", rawCallId]);
      if (!beginToolCall(host)) {
        return {
          content: [{ type: "text", text: "Skipped: tool-call limit reached." }],
          details: { skipped: true },
        };
      }
      host.queue.push({ type: "tool", name: tool.name, args, executionId });
      const startedAt = Date.now();
      let result: unknown;
      let failure: unknown;
      host.dispatchedToolCalls.add(toolCallId);
      let promotion: Promise<void> | undefined;
      // Human interaction tools pause explicitly; only executing work moves to the background.
      const promotionTimer =
        host.request.onSlowTool && !CARD_TOOL_NAMES.has(tool.name)
          ? setTimeout(() => {
              promotion = host.request.onSlowTool!({
                name: tool.name,
                executionId,
                durationMs: Date.now() - startedAt,
              }).catch((error) => {
                getLogger().error("slow tool promotion failed", error);
              });
            }, SLOW_TOOL_BACKGROUND_MS)
          : undefined;
      try {
        result = await (async () => {
          if (tool.name === "request_takeover") {
            const helped = await subagentResultsBeforePause(host);
            if (helped) return helped;
            host.pausePending = true;
            host.queue.push({
              type: "takeover",
              reason: String(args.reason ?? "I need you on the screen."),
            });
            return {
              content: [{ type: "text", text: "Takeover requested." }],
              details: args,
              terminate: true,
            };
          }
          if (tool.name === "ask_user") {
            const parsed = AskUserInputSchema.safeParse(args);
            if (!parsed.success)
              throw new Error(
                "ask_user requires two to four unique, non-empty options or a valid requestedSchema. Add two to four short options (the card already offers a custom answer) and ask again; never ask in plain text instead.",
              );
            const { question } = parsed.data;
            const known = await host.request.beforeAsk?.(question);
            if (known) {
              // Each bounce costs the person another model step before the card; say which check.
              getLogger().info("ask.not_shown", {
                runId: host.request.runId,
                reason: typeof known === "string" ? "already_answered" : known.instead.slice(0, 80),
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      typeof known === "string"
                        ? `Not asked: the recruiter already replied after this question: ${known}`
                        : known.instead,
                  },
                ],
                details: args,
              };
            }
            const helped = await subagentResultsBeforePause(host);
            if (helped) return helped;
            // A message the user sent while this question was being written may already answer
            // it; read it before pausing, so the user is never left waiting behind the card.
            const arrived = (host.steeredUnseen ?? 0) + ((await host.claimNewSteering?.()) ?? 0);
            if (arrived)
              return {
                content: [{ type: "text", text: ASK_SUPERSEDED_BY_MESSAGE }],
                details: args,
              };
            const options = "options" in parsed.data ? parsed.data.options : undefined;
            const requestedSchema =
              "requestedSchema" in parsed.data ? parsed.data.requestedSchema : undefined;
            host.pausePending = true;
            host.queue.push({
              type: "ask",
              text: question,
              ...(requestedSchema
                ? { requestedSchema }
                : {
                    actions: options!.map((label, index) => ({
                      id: `choice-${index + 1}`,
                      label,
                    })),
                    ...("multiple" in parsed.data && parsed.data.multiple
                      ? { multiple: true }
                      : {}),
                  }),
            });
            return {
              content: [{ type: "text", text: "Waiting for the user's answer." }],
              details: args,
              terminate: true,
            };
          }
          if (tool.name === "request_secret") {
            if (host.request.executeTool) {
              const result = await host.request.executeTool(tool.name, args, executionId);
              if (isAgentToolExecutionResult(result)) {
                if (isToolPauseResult(result)) host.pausePending = true;
                return result;
              }
              return {
                content: [
                  {
                    type: "text",
                    text: serializeToolResult(
                      result,
                      host.request.contextStrategy,
                      tool.name,
                      args,
                    ),
                  },
                ],
                details: result,
              };
            }
            host.pausePending = true;
            return {
              content: [{ type: "text", text: "Protected input requested." }],
              details: args,
              terminate: true,
            };
          }
          if (tool.name === "run_subagent") {
            const result = await executeSubagent(host, executionId, args);
            return {
              content: [{ type: "text", text: result }],
              details: { result },
            };
          }
          if (host.request.executeTool) {
            const call = host.request.executeTool(tool.name, args, executionId, tool.route, {
              onShellStillRunning: (completion) => {
                host.pendingShells.push(completion);
              },
            });
            const result = await untilStopped(
              RECORD_TOOLS.has(tool.name)
                ? withinDeadline(call, RECORD_TOOL_DEADLINE_MS, () => {
                    getLogger().warn("run.tool.late", {
                      runId: host.request.runId,
                      tool: tool.name,
                      executionId,
                    });
                    return { error: RECORD_TOOL_LATE_TEXT };
                  })
                : call,
              signal,
              () =>
                getLogger().warn("run.tool.abandoned", {
                  runId: host.request.runId,
                  tool: tool.name,
                  executionId,
                }),
            );
            if (isAgentToolExecutionResult(result)) {
              if (isToolPauseResult(result)) host.pausePending = true;
              return boundAgentToolResult(result);
            }
            return {
              content: [
                {
                  type: "text",
                  text: await clipWithFullOutput(
                    toolResultJson(result),
                    (full) =>
                      shortenToolResultText(full, 12_000, { name: tool.name, arguments: args }),
                    VERBATIM_TOOL_RESULTS.has(tool.name)
                      ? undefined
                      : toolOutputStore(host, tool.name, executionId),
                    VERBATIM_TOOL_RESULTS.has(tool.name) ? Number.POSITIVE_INFINITY : 12_000,
                  ),
                },
              ],
              details: result,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `${tool.name} is unavailable without an executor.`,
              },
            ],
            details: { error: "no executor" },
          };
        })();
        clearTimeout(promotionTimer);
        await promotion;
        if (VERBATIM_TOOL_RESULTS.has(tool.name))
          return spillRequiredResult(
            result as AgentToolResult<unknown>,
            toolOutputStore(host, tool.name, executionId),
            host.activeModel.config.contextWindow ?? host.activeModel.model.contextWindow,
          );
        return boundAgentToolResult(
          result as AgentToolResult<unknown>,
          toolOutputStore(host, tool.name, executionId),
        );
      } catch (error) {
        failure = error;
        // A database conflict reaches the model as plain words, never its SQL or code.
        const conflict = databaseConflictText(error);
        if (conflict) throw new Error(conflict, { cause: error });
        throw error;
      } finally {
        clearTimeout(promotionTimer);
        endToolCall(host);
        const completion: AgentToolCompletion = {
          name: tool.name,
          executionId,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(result === undefined ? {} : { result }),
          ...(failure === undefined ? {} : { error: failure }),
          ...(host.pausePending ? { paused: true } : {}),
        };
        try {
          void Promise.resolve(host.request.onToolCompleted?.(completion)).catch(() => undefined);
        } catch {
          // Audit hooks are best effort and must never change tool behavior.
        }
      }
    },
  };
}
