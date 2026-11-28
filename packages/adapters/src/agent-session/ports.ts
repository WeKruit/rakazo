/**
 * TEMPORARY integration shim (plan 2026-11-28-pi-agent-harness, Task 8). The worker depends on
 * this shape; the integration step binds the real `runSessionHost(deps, sessionId, signal)` from
 * agent-session/session-host.ts in apps/worker/src/index.ts and deletes this file.
 */

/** `runSessionHost(deps, sessionId, signal)` (plan Task 4) with its deps already bound. */
export type DriveSession = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<"released" | "not_owner">;

/** Stand-in until the session host lands: a `session.drive` job fails and is retried. */
export const sessionHostNotIntegrated: DriveSession = async () => {
  throw new Error("Session host is not integrated yet");
};
