import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";
import { MailReplySchema } from "@rakazo/contracts";
import type { BoundApprovalRoute } from "@rakazo/core";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "@rakazo/core";

export type ApprovalPausedToolResult = AgentToolExecutionResult & { terminate: true };

export interface ApprovedEffectReplay {
  kind: string;
  request: unknown;
}

export interface ApprovedEffectReplayQueue {
  nextToolName(): string | undefined;
  nextRequest(): unknown;
  take(toolName: string): unknown;
  assertDrained(): void;
}

export function createApprovedEffectReplayQueue(
  effects: readonly ApprovedEffectReplay[],
): ApprovedEffectReplayQueue {
  const pending = [...effects];

  return {
    nextToolName() {
      return pending[0]?.kind;
    },
    nextRequest() {
      return pending[0]?.request;
    },
    take(toolName) {
      const next = pending[0];
      if (!next || next.kind !== toolName) return undefined;
      pending.shift();
      return next.request;
    },
    assertDrained() {
      if (pending.length > 0) {
        throw new Error("Approved tool requests were not fully replayed");
      }
    },
  };
}

export function approvedCatalogReplay(
  queue: ApprovedEffectReplayQueue,
  toolName: string,
  marker: string,
  onCatalogExecuteRoute = false,
): { args?: Record<string, unknown>; error?: string } {
  const pending = catalogApprovalDetails(queue.nextRequest(), marker);
  if (!pending) return {};
  // Only the catalog execute wrapper may consume the wrapper envelope. After a catalog
  // shrink, matching direct tools resume via the FIFO path with inner arguments.
  if (!onCatalogExecuteRoute) return {};
  // Persisted approvals can predate the MCP wrapper rename. The executor still
  // checks the resolved resource/revision and uses only these approved arguments.
  const renamedMcpWrapper =
    pending.toolName === "mcp_execute_tool" && toolName === catalogExecuteToolName("mcp");
  if (pending.toolName !== toolName && !renamedMcpWrapper) {
    return { error: `Approved request ${pending.toolName} must be replayed before ${toolName}.` };
  }
  return { args: pending.args };
}

export function approvedReplayArgs(
  approvedRequest: unknown,
  resolvedArgs: Record<string, unknown>,
  marker: string,
): Record<string, unknown> {
  // Catalog execute keeps resolveCall-parsed args (defaults/coercion). Shrink-to-direct
  // restores inner arguments in the executor when catalogRemapped is false.
  if (catalogApprovalDetails(approvedRequest, marker)) return resolvedArgs;
  const bound = boundDirectApprovalDetails(approvedRequest, marker);
  if (bound) return bound.args;
  if (!approvedRequest || typeof approvedRequest !== "object" || Array.isArray(approvedRequest)) {
    throw new TypeError("Approved tool request is not a JSON object");
  }
  return approvedRequest as Record<string, unknown>;
}

export function approvalRoutesMatch(
  left: BoundApprovalRoute | undefined,
  right: BoundApprovalRoute | undefined,
): boolean {
  // Match resourceRevision so OAuth reauthorization (which bumps mcpServer.revision)
  // cannot replay an approval against a newly authenticated account. Quiet token
  // refresh persists credentials without incrementing revision, so those stay valid.
  return Boolean(
    left &&
      right &&
      left.connectorId === right.connectorId &&
      left.resourceId === right.resourceId &&
      left.toolName === right.toolName &&
      left.resourceRevision === right.resourceRevision,
  );
}

/** Reject draining a catalog approval from a non-catalog call unless the live route
 * matches the approved catalog target (catalog shrank back to direct tools). Direct
 * approvals may be replayed through a catalog wrapper after the catalog grows. */
export function approvalReplayPathError(
  toolName: string,
  catalogRemapped: boolean,
  approvedRequest: unknown,
  marker: string,
  liveRoute?: BoundApprovalRoute,
): string | undefined {
  if (!approvedRequest) return undefined;
  const catalog = catalogApprovalDetails(approvedRequest, marker);
  if (!catalogRemapped && catalog) {
    if (catalogApprovalMatchesLiveRoute(catalog, liveRoute)) return undefined;
    return `Approved catalog request ${toolName} must be replayed via its catalog execute tool.`;
  }
  return undefined;
}

/** Bound direct approvals must match the live connector resource on every replay.
 * Catalog approvals must match the approved target (and revision when persisted).
 * Legacy unbound direct approvals only fail closed when reached via catalog remap. */
export function approvalReplayResourceError(
  toolName: string,
  catalogRemapped: boolean,
  approvedRequest: unknown,
  liveRoute: BoundApprovalRoute | undefined,
  marker: string,
): string | undefined {
  const catalog = catalogApprovalDetails(approvedRequest, marker);
  if (catalog) {
    if (!liveRoute) return undefined;
    if (!catalogApprovalMatchesLiveRoute(catalog, liveRoute)) {
      return `Approved request ${toolName} was for a different connector resource.`;
    }
    return undefined;
  }
  const bound = boundDirectApprovalDetails(approvedRequest, marker);
  if (!bound) {
    if (catalogRemapped) {
      return `Approved direct request ${toolName} must be replayed as a direct tool call.`;
    }
    return undefined;
  }
  if (!approvalRoutesMatch(bound.route, liveRoute)) {
    return `Approved request ${toolName} was for a different connector resource.`;
  }
  return undefined;
}

/** Claude Code OAuth rejects tool names that start with `mcp_`; keep MCP wrappers on `connectors`. */
export function catalogToolPrefix(connectorId: string): string {
  return connectorId === "mcp" ? "connectors" : connectorId;
}

export function catalogExecuteToolName(connectorId: string): string {
  return `${catalogToolPrefix(connectorId)}_execute_tool`;
}

export function catalogIdForRoute(route: BoundApprovalRoute): string {
  return `${route.resourceId}:${encodeURIComponent(route.toolName)}`;
}

export function parseCatalogApprovalTarget(
  args: Record<string, unknown>,
): { resourceId: string; toolName: string } | undefined {
  const id = args.id;
  if (typeof id !== "string") return undefined;
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  try {
    const resourceId = id.slice(0, separator);
    const toolName = decodeURIComponent(id.slice(separator + 1));
    if (!resourceId || !toolName) return undefined;
    return { resourceId, toolName };
  } catch {
    return undefined;
  }
}

export function catalogApprovalConnectorId(wrapperToolName: string): string {
  const prefix = wrapperToolName.endsWith("_execute_tool")
    ? wrapperToolName.slice(0, -"_execute_tool".length)
    : wrapperToolName;
  return prefix === "connectors" ? "mcp" : prefix;
}

export function catalogApprovalMatchesLiveRoute(
  catalog: { toolName: string; args: Record<string, unknown>; route?: BoundApprovalRoute },
  liveRoute: BoundApprovalRoute | undefined,
): boolean {
  if (catalog.route) return approvalRoutesMatch(catalog.route, liveRoute);
  // Legacy catalog approvals without a bound route cannot prove revision identity.
  // If the live tool carries a revision (MCP), fail closed rather than replaying
  // across an OAuth reauth that the old envelope could not name.
  if (liveRoute?.resourceRevision !== undefined) return false;
  const target = parseCatalogApprovalTarget(catalog.args);
  return Boolean(
    liveRoute &&
      target &&
      liveRoute.connectorId === catalogApprovalConnectorId(catalog.toolName) &&
      liveRoute.resourceId === target.resourceId &&
      liveRoute.toolName === target.toolName,
  );
}

export function catalogApprovalInnerArgs(catalog: {
  args: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const inner = catalog.args.arguments;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  return inner as Record<string, unknown>;
}

/**
 * What a run resumed after a denied card is told: the paused call's result stays "Waiting for
 * approval.", so without this the model read the recruiter's next words with no sign the card was
 * cancelled (deny plays 11-21: "标题不对" renamed the role two seconds after the cancel).
 */
export function deniedContinuationNote(
  effects: readonly { kind: string; status: string; result?: unknown }[],
): string | undefined {
  const notes = effects.flatMap((effect) => {
    if (effect.status !== "denied") return [];
    const gate = resolveDuplicateEffectGate(effect, effect.kind);
    const error =
      gate.action === "return" && gate.result && typeof gate.result === "object"
        ? (gate.result as { error?: unknown }).error
        : undefined;
    return typeof error === "string" ? [`Card answered for ${effect.kind}: ${error}`] : [];
  });
  return notes.length ? notes.join("\n\n") : undefined;
}

export function approvalPausedToolResult(): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for approval." }],
    details: { approval: "paused" },
    terminate: true,
  };
}

export function inputPausedToolResult(): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for your answer on the original question." }],
    details: { input: "paused" },
    terminate: true,
  };
}

export function isToolPauseResult(result: unknown): result is ApprovalPausedToolResult {
  if (!result || typeof result !== "object") return false;
  const record = result as ApprovalPausedToolResult;
  if (record.kind !== "agent_tool_result") return false;
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  const pause = details as { approval?: unknown; secret?: unknown; input?: unknown };
  return pause.approval === "paused" || pause.secret === "paused" || pause.input === "paused";
}

export function isApprovalPausedResult(result: unknown): result is ApprovalPausedToolResult {
  return isToolPauseResult(result);
}

export type DuplicateEffectGate =
  | { action: "execute" }
  | { action: "return"; result: unknown }
  | { action: "paused" }
  | { action: "uncertain"; toolName: string };

export type ExternalEffectStore = {
  externalEffect: {
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
};

const DENIED_ACTION =
  "The user denied this action. Do not retry it unchanged. If the user has written since and asks for a change (such as a new subject, wording or people), save that change and ask again, which shows a new card; never say it is changed before the tool that saves it succeeds. Otherwise tell the user in one line, in their language, that it was not done and ask what they want instead. Do not show again what the card showed (an email, its subject or people): a copy goes stale once they change it.";
/** Deny plays 11-20/21: "标题不对" after a cancelled send card was put on the role's name. */
const DENIED_SEND =
  "A 标题, title or subject they give now is this email's subject line, never the role's name: save the whole email with the new subject (ensure_role_campaign steps), then call activate_campaign again for a new card.";

/** The send card's own subject beside the reading of a new title, when the card was a send. */
function sendCard(result: unknown, toolName: string) {
  const shown =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { instantlyActivationShown?: unknown }).instantlyActivationShown
      : undefined;
  if (!shown && !toolName.endsWith("activate_campaign")) return "";
  const card = (shown ?? {}) as {
    firstEmail?: { subject?: unknown } | null;
    recipients?: { firstEmail?: { subject?: unknown } }[];
  };
  const subject = card.firstEmail?.subject ?? card.recipients?.[0]?.firstEmail?.subject;
  return ` ${typeof subject === "string" ? `The cancelled card's subject was "${subject.slice(0, 200)}". ` : ""}${DENIED_SEND}`;
}

export function resolveDuplicateEffectGate(
  effect: { status: string; result?: unknown },
  toolName: string,
): DuplicateEffectGate {
  if (effect.status === "completed") {
    return { action: "return", result: effect.result ?? { duplicate: true } };
  }
  if (effect.status === "denied") {
    const retained =
      effect.result && typeof effect.result === "object" && !Array.isArray(effect.result)
        ? (effect.result as { mailReplyApproval?: unknown }).mailReplyApproval
        : undefined;
    if (MailReplySchema.safeParse(retained).success)
      return {
        action: "return",
        result: {
          status: "discarded",
          dispatched: false,
          message:
            "The reply card was already created and the user discarded it. Nothing was sent. Do not claim card creation failed and do not retry.",
        },
      };
    return {
      action: "return",
      result: {
        error: `${DENIED_ACTION}${sendCard(effect.result, toolName)}`,
      },
    };
  }
  if (effect.status === "executing") {
    return { action: "uncertain", toolName };
  }
  if (effect.status === "uncertain") {
    return { action: "return", result: effect.result ?? uncertainEffectResult(toolName) };
  }
  if (effect.status === "approved") {
    return { action: "execute" };
  }
  if (effect.status === "intended") {
    return { action: "paused" };
  }
  return { action: "uncertain", toolName };
}

export type UncertainEffectResult = { error: string; uncertain: true; providerResult?: unknown };

export function uncertainEffectResult(toolName: string): UncertainEffectResult {
  return {
    error: `The ${toolName} outcome could not be verified. It was not replayed to avoid a duplicate side effect. Verify the destination before proposing another action.`,
    uncertain: true,
  };
}

export async function settleUncertainEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: never };
      }) => Promise<{ count: number }>;
      findUnique: (args: {
        where: { id: string };
      }) => Promise<{ status: string; result?: unknown } | null>;
    };
  },
  effectId: string,
  toolName: string,
  evidence?: { providerResult: unknown },
): Promise<unknown> {
  const result = { ...uncertainEffectResult(toolName), ...evidence };
  const settled = await store.externalEffect.updateMany({
    where: { id: effectId, status: "executing" },
    data: { status: "uncertain", result: result as never },
  });
  if (settled.count === 1) return result;

  const current = await store.externalEffect.findUnique({ where: { id: effectId } });
  if (!current) return result;
  const gate = resolveDuplicateEffectGate(current, toolName);
  return gate.action === "return" ? gate.result : result;
}

export async function claimApprovedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "approved" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function claimIntendedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "intended" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function completeExternalEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  expectedStatus: "intended" | "executing",
  result: unknown,
): Promise<boolean> {
  const completed = await store.externalEffect.updateMany({
    where: { id: effectId, status: expectedStatus },
    data: { status: "completed", result: result as never },
  });
  return completed.count === 1;
}

export async function replaceCompletedExternalEffectResult(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  result: unknown,
): Promise<boolean> {
  const replaced = await store.externalEffect.updateMany({
    where: { id: effectId, status: "completed" },
    data: { result: result as never },
  });
  return replaced.count === 1;
}

export const DENIED_THIS_TURN_RESULT = {
  error:
    "The user already denied this kind of action in this turn. Do not ask again with changed content; tell the user it was not done and ask what they want instead.",
  dispatched: false,
} as const;

/**
 * Whether the person denied an action of this kind earlier in this turn and has not written
 * since. send-through-blip 11-16: denied, the turn rewrote the email and asked again on a new
 * card, because a changed request is a new approval. A message from the person lifts it.
 */
export async function deniedEarlierThisTurn(
  prisma: {
    externalEffect: {
      findFirst: (args: {
        where: { runId: string; kind: string; status: "denied"; id: { not: string } };
        orderBy: { updatedAt: "desc" };
        select: { updatedAt: true };
      }) => Promise<{ updatedAt: Date } | null>;
    };
    message: {
      findFirst: (args: {
        where: {
          threadId: string;
          role: "user";
          createdAt: { gt: Date };
          OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: string } } }];
        };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  input: { threadId: string; effect: { id: string; runId: string; kind: string } },
): Promise<boolean> {
  const denied = await prisma.externalEffect.findFirst({
    where: {
      runId: input.effect.runId,
      kind: input.effect.kind,
      status: "denied",
      id: { not: input.effect.id },
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  if (!denied) return false;
  const spoke = await prisma.message.findFirst({
    where: {
      threadId: input.threadId,
      role: "user",
      createdAt: { gt: denied.updatedAt },
      OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: "autocontinue:" } } }],
    },
    select: { id: true },
  });
  return !spoke;
}
