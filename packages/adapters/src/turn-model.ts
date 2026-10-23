export const DEFAULT_FAST_MODEL = "gpt-6-luna";
/** A user message at or above this length is treated as real work, not a light turn. */
export const FAST_TURN_MAX_CHARS = 300;

export interface TurnModelInput {
  configured: { provider: string; id: string };
  trigger: string;
  /** The turn answers a bot question (clarifying answer, ask/choice card). */
  answersQuestion: boolean;
  /** Intent of the peer bot message that woke this turn, when any. */
  peerIntent?: string | null;
  userText: string;
  hasAttachments: boolean;
  /** Approved-effect continuation or a resumed checkpoint: a tool loop is still open. */
  pendingToolLoop: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TurnModelChoice {
  model: { provider: string; id: string };
  routed: "fast" | "configured";
  reason: string;
}

/**
 * Per-turn model choice: light turns go to the fast model, everything else keeps the
 * bot's configured model. RAKAZO_FAST_MODEL="" disables; RAKAZO_FAST_MODEL_PROVIDER
 * defaults to the bot's provider.
 */
export function chooseTurnModel(input: TurnModelInput): TurnModelChoice {
  const env = input.env ?? process.env;
  const configured = { model: input.configured, routed: "configured" as const };
  const fastId =
    env.RAKAZO_FAST_MODEL === undefined ? DEFAULT_FAST_MODEL : env.RAKAZO_FAST_MODEL.trim();
  if (!fastId) return { ...configured, reason: "fast_model_disabled" };
  const fastProvider = env.RAKAZO_FAST_MODEL_PROVIDER?.trim() || input.configured.provider;
  if (fastProvider === input.configured.provider && fastId === input.configured.id)
    return { ...configured, reason: "already_fast" };
  const fast = { model: { provider: fastProvider, id: fastId }, routed: "fast" as const };

  if (input.pendingToolLoop) return { ...configured, reason: "pending_tool_loop" };
  if (input.answersQuestion) return { ...fast, reason: "clarifying_answer" };
  if (input.peerIntent === "status" || input.peerIntent === "fyi")
    return { ...fast, reason: "status_turn" };
  if (input.trigger !== "user" && input.trigger !== "messaging")
    return { ...configured, reason: `trigger:${input.trigger}` };
  if (input.hasAttachments) return { ...configured, reason: "attachments" };
  // ponytail: length is the whole heuristic; a short "find 50 candidates" still routes fast.
  if (input.userText.trim().length < FAST_TURN_MAX_CHARS)
    return { ...fast, reason: "short_user_message" };
  return { ...configured, reason: "long_message" };
}
