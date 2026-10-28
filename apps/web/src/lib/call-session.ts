import type { CallOptions } from "./call-session-state.js";
import { callState, newCallState, replaceCallState } from "./call-session-state.js";
import { errorText } from "./user-error.js";

export type { CallExchange, CallPhase, CallState } from "./call-session-state.js";
export { ECHO_GUARD_MS, getSnapshot, subscribe, useCallSession } from "./call-session-state.js";

let engine: typeof import("./call-session-engine.js") | undefined;
let loading: Promise<typeof import("./call-session-engine.js")> | undefined;
let generation = 0;

/** Voice code loads on the actual call action; ownership cancellation stays synchronous. */
export function startCall(call: CallOptions): void {
  const current = ++generation;
  if (engine) {
    engine.startCall(call);
    return;
  }
  replaceCallState(newCallState(call, "thinking"));
  loading ??= import("./call-session-engine.js");
  const request = loading;
  void request
    .then((runtime) => {
      if (generation !== current || !callState) return;
      const initial = {
        muted: callState.muted,
        transcriptOpen: callState.transcriptOpen,
        startedAt: callState.startedAt,
      };
      replaceCallState(null, false);
      engine = runtime;
      runtime.startCall(call, initial);
    })
    .catch((error: unknown) => {
      if (loading === request) loading = undefined;
      if (generation !== current || !callState) return;
      replaceCallState({ ...callState, caption: errorText(error) });
    });
}

export function endCall(): void {
  generation++;
  if (engine) engine.endCall();
  else replaceCallState(null);
}

/** Logout/Space switch cancels pending loading before any voice/network side effect begins. */
export function discardCall(): void {
  generation++;
  if (engine) engine.discardCall();
  else replaceCallState(null);
}

export function toggleMute(): void {
  if (engine) engine.toggleMute();
  else if (callState) replaceCallState({ ...callState, muted: !callState.muted });
}

export function toggleTranscript(): void {
  if (engine) engine.toggleTranscript();
  else if (callState) replaceCallState({ ...callState, transcriptOpen: !callState.transcriptOpen });
}
