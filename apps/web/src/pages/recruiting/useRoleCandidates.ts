import type { RecruitingCandidate, RecruitingCrmDataOutput } from "@rakazo/contracts";
import { useMemo, useState } from "react";
import type { RoleCandidateRow } from "./roleCandidates";
import { isRecordId, mergeRoleCandidates, roleCandidateFit } from "./roleCandidates";
import type { RecruitingTabProps } from "./shared";
import { useCrmPages, useRoleCrm } from "./shared";

export type CrmCandidate = Extract<
  RecruitingCrmDataOutput,
  { operation: "candidates" }
>["items"][number];

/** The role's search results as the workbench already reads and validates them. */
export type SourcedCandidatesRead = {
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
  /** False while a search-only filter (shortlist, round, verdict) is active. */
  includeCrm: boolean;
  query?: string;
};

export type RoleCandidate = RoleCandidateRow<RecruitingCandidate, CrmCandidate>;

/**
 * The role's one candidate list. Each source renders as soon as it loads, fails and retries on
 * its own, and the merged rows are what the table shows. This hook is the single place that
 * knows where the rows come from, so a merged server read can replace both reads here.
 */
export function useRoleCandidates(props: RecruitingTabProps & { sourced?: SourcedCandidatesRead }) {
  const { sourced } = props;
  const [reload, setReload] = useState(0);
  const crm = useRoleCrm(props);
  const query = sourced?.query?.trim();
  const crmPages = useCrmPages(
    crm,
    "candidates",
    crm.status === "ready" && (sourced?.includeCrm ?? true)
      ? { crmRoleId: crm.target.crmRoleId, ...(query ? { query } : {}) }
      : null,
    { ...props, reload },
  );
  const crmData = crmPages.data;
  const sourcedItems = sourced?.items;
  // Saved results already carry the role-wide server order, established before pagination.
  const sortByScore = false;
  // The email lookup is a new function on every parent render; its answers are what matter.
  const emails = (sourcedItems ?? []).map((candidate) => sourced?.email?.(candidate) ?? null);
  const emailKey = emails.join("\n");
  // Merged rows keep their identity across renders, so the table and its per-row profile
  // parsing do not redo work when only the open person or a tab changes.
  const rows = useMemo(
    () =>
      mergeRoleCandidates({
        sourced: (sourcedItems ?? []).map((candidate, index) => ({
          key: `sourced:${candidate.candidateKey}`,
          name: candidate.name,
          title: candidate.title,
          location: candidate.location,
          email: emails[index] ?? null,
          linkedinUrl: candidate.linkedinUrl,
          value: candidate,
        })),
        crm: (crmData?.items ?? []).map((person) => ({
          key: `crm:${person.candidateId}`,
          name: person.name,
          title: person.title,
          location: person.location,
          email: person.email,
          linkedinUrl: person.linkedinUrl,
          // Some imported records hold an internal company id where the name belongs.
          value: isRecordId(person.company) ? { ...person, company: null } : person,
        })),
        fit: (candidate) => roleCandidateFit(candidate.latestSource?.report?.fields),
        sortByScore,
      }),
    [sourcedItems, crmData, sortByScore, emailKey],
  );
  const crmTotal = crmData?.total ?? null;
  const crmRead = {
    loading: crm.status === "loading" || crmPages.loading,
    failed: crm.status === "failed" || crmPages.failed,
    retry: () => setReload((value) => value + 1),
  };
  const sourcedMore = Boolean(sourced?.hasMore);
  const includeCrm = (sourced?.includeCrm ?? true) && crm.status !== "unbound";
  const sourcedReady = !sourced || (!sourced.loading && !sourced.failed && sourced.total !== null);
  const crmReady = !includeCrm || (crm.status === "ready" && !!crmPages.data && !crmRead.failed);
  // Separate source totals cannot establish the union: unseen pages may contain overlaps.
  // Keep the source total for a successful single-source read, and count the merged rows
  // only after both included sources have been exhausted.
  const total =
    !sourcedReady || !crmReady
      ? null
      : !includeCrm
        ? (sourced?.total ?? null)
        : !sourced
          ? crmTotal
          : !sourcedMore && !crmPages.hasMore
            ? rows.length
            : null;
  return {
    crm,
    rows,
    sourced: sourced && { loading: sourced.loading, failed: sourced.failed, retry: sourced.retry },
    crmRead,
    /** Exact displayed-record total only when source and deduplication coverage permit it. */
    total,
    /** Already merged visible records; not an estimate of the complete population. */
    loadedCount: rows.length,
    more: {
      hasMore: sourcedMore || crmPages.hasMore,
      loadMore: sourcedMore ? sourced!.loadMore : crmPages.loadMore,
      loadingMore: crmPages.loadingMore,
      moreFailed: crmPages.moreFailed,
    },
  };
}
