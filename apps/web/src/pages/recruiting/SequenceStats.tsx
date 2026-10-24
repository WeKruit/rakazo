import { useLingui } from "@lingui/react/macro";
import type {
  RecruitingCrmDataOutput,
  RecruitingSequenceLeadStatus,
  RecruitingSequenceStatus,
} from "@rakazo/contracts";
import type { RecruitingTabProps, RoleCrm } from "./shared";
import { formatDate, useCrmData, useRoleCrm } from "./shared";

export type SequenceStat = Extract<
  RecruitingCrmDataOutput,
  { operation: "sequenceStats" }
>["items"][number];
type Scope = Pick<RecruitingTabProps, "spaceId" | "readCache" | "readCacheScope"> & {
  refreshSignal?: number;
};

/** Saved sequence numbers for up to 100 listed people, keyed by CRM candidate id. */
export function useSequenceStats(crm: RoleCrm, candidateIds: readonly string[], scope: Scope) {
  const ids = [...new Set(candidateIds)].sort().slice(0, 100);
  const read = useCrmData(crm, "sequenceStats", ids.length ? { candidateIds: ids } : null, scope);
  return new Map((read.data?.items ?? []).map((item) => [item.candidateId, item]));
}

export function useSequenceLabels() {
  const { t } = useLingui();
  const person: Record<RecruitingSequenceLeadStatus, string> = {
    active: t`In progress`,
    paused: t`Paused`,
    completed: t`Finished`,
    bounced: t`Bounced`,
    unsubscribed: t`Unsubscribed`,
    skipped: t`Skipped`,
  };
  const sequence: Record<RecruitingSequenceStatus, string> = {
    draft: t`Draft`,
    active: t`In progress`,
    paused: t`Paused`,
    completed: t`Finished`,
    stopped: t`Stopped`,
  };
  return {
    person,
    sequence,
    status: t`Sequence status`,
    opened: t`Opened`,
    replied: t`Replied`,
    lastContacted: t`Last contacted`,
    opens: (opens: number) => t`Opened ${opens}`,
    replies: (replied: number) => t`Replied ${replied}`,
  };
}
type Labels = ReturnType<typeof useSequenceLabels>;

/** Opens, replies, last contact and sequence state, as definition rows. */
export function sequenceFacts(stat: SequenceStat | undefined, labels: Labels) {
  if (!stat) return [];
  return [
    stat.status ? { label: labels.status, value: labels.person[stat.status] } : null,
    stat.opens !== null ? { label: labels.opened, value: String(stat.opens) } : null,
    stat.replies !== null ? { label: labels.replied, value: String(stat.replies) } : null,
    stat.lastContactAt
      ? { label: labels.lastContacted, value: formatDate(stat.lastContactAt) }
      : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
}

/** A compact one-line summary for list rows: state, opens and replies. */
export function sequenceLine(stat: SequenceStat, labels: Labels) {
  const opens = stat.opens;
  const replies = stat.replies;
  return [
    stat.status ? labels.person[stat.status] : null,
    opens !== null ? labels.opens(opens) : null,
    replies !== null ? labels.replies(replies) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One person's saved sequence facts, read through the role's own CRM source. */
export function usePersonSequenceFacts(
  role: Pick<RecruitingTabProps, "roleId" | "spaceId" | "conversation">,
  candidateId: string | null,
) {
  const labels = useSequenceLabels();
  const crm = useRoleCrm(role);
  const stats = useSequenceStats(crm, candidateId ? [candidateId] : [], role);
  return sequenceFacts(candidateId ? stats.get(candidateId) : undefined, labels);
}
