import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { createContext, useContext } from "react";

export type HandoffSource = { groupId: string; name: string };

/** The conversation a handoff came from, named as the recruiter knows it: Kruit or the role. */
export function handoffSourceFor(
  groups: readonly Pick<Group, "id" | "name" | "threadId">[],
  threadId: string,
): HandoffSource | undefined {
  const group = groups.find((candidate) => candidate.threadId === threadId);
  if (!group) return undefined;
  return {
    groupId: group.id,
    name: group.id.startsWith("recruiting-global-") ? RECRUITING_GLOBAL_AGENT_NAME : group.name,
  };
}

export const HandoffSourceContext = createContext<(threadId: string) => HandoffSource | undefined>(
  () => undefined,
);

export const useHandoffSource = () => useContext(HandoffSourceContext);
