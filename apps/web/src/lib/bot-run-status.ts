import type { Bot, ProductEvent } from "@rakazo/contracts";
import { isBackgroundRunTrigger, isRunTerminalEvent } from "@rakazo/core";

/** The sidebar status a run event implies, or null when the event says nothing about it. */
export function botStatusFromRunEvent(
  event: Pick<ProductEvent, "type" | "payload">,
): string | null {
  if (event.type === "run.started") {
    return isBackgroundRunTrigger(event.payload.trigger as string | undefined) ? null : "running";
  }
  if (event.type === "run.requeued") {
    const status = event.payload.status;
    return status === "queued" || status === "waiting_takeover" ? status : null;
  }
  if (event.type === "run.waiting_input") return "waiting_input";
  if (event.type === "computer.takeover.requested") return "waiting_takeover";
  if (isRunTerminalEvent(event)) return "idle";
  return null;
}

export function applyBotStatus<T extends Pick<Bot, "id" | "status">>(
  bots: T[],
  botId: string,
  status: string,
): T[] {
  const bot = bots.find((candidate) => candidate.id === botId);
  if (!bot || bot.status === status) return bots;
  return bots.map((candidate) => (candidate.id === botId ? { ...candidate, status } : candidate));
}

export type BotStatusMessage = { botId: string; status: string };

/**
 * Tabs of the same signed-in user share run status, so a page that is not showing the bot
 * (or is in the background) updates its sidebar without polling. Scoped by user and space;
 * nothing but ids and status crosses the channel.
 */
export function openBotStatusChannel(
  scope: { userId: string; spaceId: string },
  onStatus: (message: BotStatusMessage) => void,
): { post: (message: BotStatusMessage) => void; close: () => void } {
  if (typeof BroadcastChannel === "undefined") return { post: () => {}, close: () => {} };
  const channel = new BroadcastChannel(`rakazo.bot-status:${scope.userId}:${scope.spaceId}`);
  channel.onmessage = (message: MessageEvent<unknown>) => {
    const data = message.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as BotStatusMessage).botId === "string" &&
      typeof (data as BotStatusMessage).status === "string"
    )
      onStatus(data as BotStatusMessage);
  };
  return {
    post: (message) => channel.postMessage({ botId: message.botId, status: message.status }),
    close: () => channel.close(),
  };
}
