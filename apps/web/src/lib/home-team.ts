import type { Group } from "@rakazo/contracts";

/**
 * The team every new account gets before its first role. Until it holds a conversation it is not a
 * role, and a new recruiter saw it as an empty role named "Recruiting".
 */
export function isEmptyHomeTeam(group: Pick<Group, "id" | "preview">): boolean {
  return /^recruiting-[0-9a-f]+$/.test(group.id) && !group.preview.trim();
}
