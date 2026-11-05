import type { Bot, GroupMember } from "@rakazo/contracts";
import { useCallback } from "react";
import { useSameContent } from "../../lib/use-same-content";
import { memberName } from "./group-members";

/**
 * Name and color lookups for chat messages. Leaves out status, which changes with every run in
 * the account, so settled messages keep the same lookups and skip re-rendering.
 */
export function useTranscriptLookups(
  bots: readonly Pick<Bot, "id" | "name" | "color" | "spawnKey">[],
  members: readonly GroupMember[] | undefined,
) {
  const people = useSameContent(members?.map(({ botId, name, color }) => ({ botId, name, color })));
  const agents = useSameContent(
    bots.map(({ id, name, color, spawnKey }) => ({ id, name, color, spawnKey })),
  );
  const resolveBot = useCallback(
    (botId: string) =>
      agents.find((candidate) => candidate.id === botId) ??
      people?.find((member) => member.botId === botId),
    [agents, people],
  );
  const resolveMemberName = useCallback(
    (botId: string | undefined) => memberName(people, botId),
    [people],
  );
  return { resolveBot, resolveMemberName };
}
