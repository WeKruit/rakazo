import { useSyncExternalStore } from "react";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export interface CallState {
  userId: string;
  spaceId: string;
  botId: string;
  botName: string;
  botColor: string;
  startedAt: number;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  exchanges: CallExchange[];
}

export type CallOptions = {
  userId: string;
  spaceId: string;
  botId: string;
  botName: string;
  botColor?: string;
  transcribe?: boolean;
};
/** Quiet gap between the last audio frame and reopening the microphone. */
export const ECHO_GUARD_MS = 600;
export let callState: CallState | null = null;
const watchers = new Set<() => void>();
export function emit() {
  for (const watcher of [...watchers]) watcher();
}
export function replaceCallState(next: CallState | null, notify = true) {
  callState = next;
  if (notify) emit();
}
export function subscribe(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
export function getSnapshot(
  userId: string | undefined,
  spaceId: string | undefined,
): CallState | null {
  return callState?.userId === userId && callState?.spaceId === spaceId ? callState : null;
}
export function useCallSession(userId: string | undefined, spaceId: string | undefined) {
  const read = () => getSnapshot(userId, spaceId);
  return useSyncExternalStore(subscribe, read, read);
}
export function newCallState(call: CallOptions, phase: CallPhase = "listening"): CallState {
  return {
    userId: call.userId,
    spaceId: call.spaceId,
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    startedAt: Date.now(),
    phase,
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
}
