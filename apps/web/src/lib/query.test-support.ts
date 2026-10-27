import { notifyManager } from "@tanstack/react-query";

// React's async act drains microtasks; keep Query observer notifications within that boundary.
// Production retains TanStack's default scheduler. Fake latency timers still control transport.
notifyManager.setScheduler((notify) => {
  void Promise.resolve().then(notify);
});

import type { ReadRecruitingViewInput } from "@rakazo/contracts";
import type { rpc } from "./rpc";

/** RPC boundary fixture: keeps the existing late-binding/revision tests observable. */
export function recruitingReadViewFixture(
  api: Pick<typeof rpc.recruiting, "getWorkspace" | "listCandidates" | "listResearch">,
) {
  return async (input: ReadRecruitingViewInput, options?: { signal?: AbortSignal }) => {
    const data =
      input.kind === "candidates"
        ? await api.listCandidates({ ...input.query, roleId: input.roleId }, options)
        : await api.listResearch({ roleId: input.roleId });
    const workspace = await api.getWorkspace({ threadId: input.threadId });
    const current =
      workspace?.role.id === input.roleId && workspace.revision.id === input.roleRevisionId;
    return { kind: input.kind, workspace, data: current ? data : null };
  };
}
