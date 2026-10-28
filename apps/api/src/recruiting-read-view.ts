import { ORPCError } from "@orpc/server";
import type { Actor, ReadRecruitingViewInput } from "@rakazo/contracts";
import {
  getRecruitingWorkspace,
  listRecruitingCandidates,
  listRecruitingResearch,
} from "./recruiting.js";

/**
 * Keep the UI's post-read authorization/binding check in the same response as its data.
 * The existing reads retain their transactions. This is a validated view, not a serializable
 * snapshot, and never authorizes a later mutation (which keeps its existing fresh checks).
 */
export async function readRecruitingView(
  deps: Parameters<typeof listRecruitingCandidates>[0],
  actor: Actor,
  input: ReadRecruitingViewInput,
  stillAuthorized?: () => Promise<boolean>,
) {
  const readWorkspace = async () => {
    const workspace = await getRecruitingWorkspace(deps.prisma, actor, {
      threadId: input.threadId,
    });
    // Combining RPCs must not lose the session recheck previously performed by each request.
    if (stillAuthorized && !(await stillAuthorized())) throw new ORPCError("UNAUTHORIZED");
    return workspace;
  };
  const matches = (workspace: Awaited<ReturnType<typeof getRecruitingWorkspace>>) =>
    workspace?.role.id === input.roleId && workspace.revision.id === input.roleRevisionId;
  const initial = await readWorkspace();
  if (!matches(initial))
    return input.kind === "candidates"
      ? { kind: "candidates" as const, workspace: initial, data: null }
      : { kind: "research" as const, workspace: initial, data: null };
  if (input.kind === "candidates") {
    const data = await listRecruitingCandidates(deps, actor, {
      ...input.query,
      roleId: input.roleId,
    });
    const workspace = await readWorkspace();
    return {
      kind: "candidates" as const,
      workspace,
      data:
        matches(workspace) &&
        data.roleId === input.roleId &&
        data.roleRevisionId === input.roleRevisionId
          ? data
          : null,
    };
  }
  const data = await listRecruitingResearch(deps.prisma, actor, {
    roleId: input.roleId,
    offset: input.offset ?? 0,
  });
  const workspace = await readWorkspace();
  return {
    kind: "research" as const,
    workspace,
    data:
      matches(workspace) && data.tasks.every((task) => task.roleId === input.roleId) ? data : null,
  };
}
