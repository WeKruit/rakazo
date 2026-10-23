import type { RecruitingCandidate, RecruitingCrmDataOutput } from "@rakazo/contracts";
import { useState } from "react";
import type { RoleCandidateRow } from "./roleCandidates";
import { mergeRoleCandidates, roleCandidateFit } from "./roleCandidates";
import type { RecruitingTabProps } from "./shared";
import { useCrmPages, useRoleCrm } from "./shared";

export type CrmCandidate = Extract<
  RecruitingCrmDataOutput,
  { operation: "candidates" }
>["items"][number];

/** The role's Autumn results as the workbench already reads and validates them. */
export type AutumnCandidatesRead = {
  items: readonly RecruitingCandidate[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
  total: number | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Saved contact lookup email for a result, used to recognise the same CRM contact. */
  email?: (candidate: RecruitingCandidate) => string | null;
  /** False keeps the server's chosen order (a sort other than score). */
  sortByScore: boolean;
  /** False while an Autumn-only filter (shortlist, round, verdict) is active. */
  includeCrm: boolean;
  query?: string;
};

export type RoleCandidate = RoleCandidateRow<RecruitingCandidate, CrmCandidate>;

/**
 * The role's one candidate list. Each source renders as soon as it loads, fails and retries on
 * its own, and the merged rows are what the table shows. This hook is the single place that
 * knows where the rows come from, so a merged server read can replace both reads here.
 */
export function useRoleCandidates(props: RecruitingTabProps & { autumn?: AutumnCandidatesRead }) {
  const { autumn } = props;
  const [reload, setReload] = useState(0);
  const crm = useRoleCrm(props);
  const query = autumn?.query?.trim();
  const crmPages = useCrmPages(
    crm,
    "candidates",
    crm.status === "ready" && (autumn?.includeCrm ?? true)
      ? { crmRoleId: crm.target.crmRoleId, ...(query ? { query } : {}) }
      : null,
    { ...props, reload },
  );
  const crmItems = crmPages.data?.items ?? [];
  const rows = mergeRoleCandidates({
    autumn: (autumn?.items ?? []).map((candidate) => ({
      key: `autumn:${candidate.candidateKey}`,
      name: candidate.name,
      title: candidate.title,
      location: candidate.location,
      email: autumn?.email?.(candidate) ?? null,
      linkedinUrl: candidate.linkedinUrl,
      value: candidate,
    })),
    crm: crmItems.map((person) => ({
      key: `crm:${person.candidateId}`,
      name: person.name,
      title: person.title,
      location: person.location,
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      value: person,
    })),
    fit: (candidate) => roleCandidateFit(candidate.latestSource?.report?.fields),
    sortByScore: autumn?.sortByScore ?? true,
  });
  const crmTotal = crmPages.data?.total ?? null;
  const crmRead = {
    loading: crm.status === "loading" || crmPages.loading,
    failed: crm.status === "failed" || crmPages.failed,
    retry: () => setReload((value) => value + 1),
  };
  const autumnMore = Boolean(autumn?.hasMore);
  const includeCrm = (autumn?.includeCrm ?? true) && crm.status !== "unbound";
  const autumnReady = !autumn || (!autumn.loading && !autumn.failed && autumn.total !== null);
  const crmReady = !includeCrm || (crm.status === "ready" && !!crmPages.data && !crmRead.failed);
  // Separate source totals cannot establish the union: unseen pages may contain overlaps.
  // Keep the source total for a successful single-source read, and count the merged rows
  // only after both included sources have been exhausted.
  const total =
    !autumnReady || !crmReady
      ? null
      : !includeCrm
        ? (autumn?.total ?? null)
        : !autumn
          ? crmTotal
          : !autumnMore && !crmPages.hasMore
            ? rows.length
            : null;
  return {
    crm,
    rows,
    autumn: autumn && { loading: autumn.loading, failed: autumn.failed, retry: autumn.retry },
    crmRead,
    /** Exact displayed-record total only when source and deduplication coverage permit it. */
    total,
    /** Already merged visible records; not an estimate of the complete population. */
    loadedCount: rows.length,
    more: {
      hasMore: autumnMore || crmPages.hasMore,
      loadMore: autumnMore ? autumn!.loadMore : crmPages.loadMore,
      loadingMore: crmPages.loadingMore,
      moreFailed: crmPages.moreFailed,
    },
  };
}
