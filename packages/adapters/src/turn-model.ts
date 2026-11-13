export const DEFAULT_FAST_MODEL = "gpt-6-luna";
/** A user message at or above this length is treated as real work, not a light turn. */
export const FAST_TURN_MAX_CHARS = 300;
const ASKS_WHY_OR_HOW_MANY =
  /为什么|为啥|怎么回事|怎么会|什么情况|多少|几个|几位|几封|\bwhy\b|how many|how much|what happened|what went wrong/i;

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
  /** A recruiting role before its first round: clarifying questions and the people searches. */
  recruitingIntake?: boolean;
  /** The bot's settings name its own model or thinking level, which then applies as chosen. */
  botChosen?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TurnModelChoice {
  model: { provider: string; id: string };
  routed: "fast" | "configured";
  reason: string;
  /** Overrides the bot's thinking level for this turn. */
  thinkingLevel?: "low" | "off";
}

/**
 * Per-turn model choice: light turns go to the fast model, everything else keeps the
 * bot's configured model. RAKAZO_FAST_MODEL="" disables; RAKAZO_FAST_MODEL_PROVIDER
 * defaults to the bot's provider.
 */
export function chooseTurnModel(input: TurnModelInput): TurnModelChoice {
  const env = input.env ?? process.env;
  const configured = { model: input.configured, routed: "configured" as const };
  if (input.botChosen) return { ...configured, reason: "bot_setting" };
  const fastId =
    env.RAKAZO_FAST_MODEL === undefined ? DEFAULT_FAST_MODEL : env.RAKAZO_FAST_MODEL.trim();
  if (!fastId) return { ...configured, reason: "fast_model_disabled" };
  const fastProvider = env.RAKAZO_FAST_MODEL_PROVIDER?.trim() || input.configured.provider;
  if (fastProvider === input.configured.provider && fastId === input.configured.id)
    // A bot already on the fast model still opens a role without reasoning.
    return input.recruitingIntake && !input.pendingToolLoop
      ? { ...configured, reason: "recruiting_intake", thinkingLevel: "off" }
      : { ...configured, reason: "already_fast" };
  const fast = { model: { provider: fastProvider, id: fastId }, routed: "fast" as const };

  if (input.pendingToolLoop) return { ...configured, reason: "pending_tool_loop" };
  // An answer turn picks the people, so it keeps the bot's thinking level.
  if (input.answersQuestion) return { ...fast, reason: "clarifying_answer" };
  // The turn that opens a role only reads the JD and asks the first question, so it skips
  // reasoning: the question is the first thing the recruiter waits for.
  if (input.recruitingIntake) return { ...fast, reason: "recruiting_intake", thinkingLevel: "off" };
  if (input.peerIntent === "status" || input.peerIntent === "fyi")
    return { ...fast, reason: "status_turn" };
  if (input.trigger !== "user" && input.trigger !== "messaging")
    return { ...configured, reason: `trigger:${input.trigger}` };
  if (input.hasAttachments) return { ...configured, reason: "attachments" };
  // A short "why did nothing send?" or "how many went out?" needs the agent to check and reason,
  // so it keeps the configured model; other short messages stay on the fast one.
  if (ASKS_WHY_OR_HOW_MANY.test(input.userText)) return { ...configured, reason: "why_question" };
  if (input.userText.trim().length < FAST_TURN_MAX_CHARS)
    return { ...fast, reason: "short_user_message" };
  return { ...configured, reason: "long_message" };
}

export type EffortMode = "fast" | "balanced" | "deep";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A chat's effort mode applied to the turn's thinking level. Fast (the default) caps thinking at
 * low and keeps lower levels; balanced keeps the routed level; deep thinks at high.
 */
export function effortThinkingLevel(
  mode: EffortMode,
  level: ThinkingLevel | null | undefined,
): ThinkingLevel | null | undefined {
  if (mode === "deep") return "high";
  if (mode === "balanced") return level;
  return level === "off" || level === "minimal" || level === "low" ? level : "low";
}

/**
 * The stored mode when the account may choose one; fast otherwise. A bot whose settings name its
 * model or thinking level keeps that level (balanced) unless the chat asks for deep.
 */
export function resolveEffortMode(
  stored: string | null | undefined,
  mayChoose: boolean,
  botChosen = false,
): EffortMode {
  if (botChosen && !(mayChoose && stored === "deep")) return "balanced";
  if (!mayChoose) return "fast";
  return stored === "balanced" || stored === "deep" ? stored : "fast";
}
