import { Trans, useLingui } from "@lingui/react/macro";
import type { ListRecruitingCandidatesInput, Verdict } from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
  TabsContent,
} from "@rakazo/ui-web";
import type { VirtualItem } from "@tanstack/react-virtual";
import { LayoutGrid, List } from "lucide-react";
import { useMemo, useRef } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";
import { withFeatureMessages } from "../../lib/i18n";
import { ContactsTab } from "../recruiting/ContactsTab";
import { RetryNotice } from "../recruiting/RetryNotice";

const RecruitingLegacyResults = lazyPanel(() =>
  withFeatureMessages(() => import("./RecruitingLegacyResults")).then(
    (m) => m.RecruitingLegacyResults,
  ),
);

const ResearchResults = lazyPanel(() =>
  withFeatureMessages(() => import("./SourceDocuments")).then((m) => m.ResearchResults),
);

import { TabLoading } from "../recruiting/shared";
import type { useRecruitingWorkspace } from "../recruiting/useRecruitingWorkspace";
export function RecruitingEvidenceTab({
  model,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
}) {
  const { t } = useLingui();
  const {
    shortlistWeekFilter,
    onClearShortlistWeekFilter,
    botId,
    groupId,
    readCache,
    readCacheScope,
    refreshSignal,
    onDiscussCandidate,
    showDiagnostics,
    presentation,
    view,
    shortlistFilterId,
    snapshot,
    refresh,
    setFeedbackRefresh,
    setCandidateList,
    contactsView,
    candidateView,
    filteredShortlistWeek,
    candidateFilters,
    selection,
    candidatePage,
    setCandidateFilters,
    candidateLoading,
    candidateFailed,
    shortlistPending,
    shortlistFailed,
    workspace,
    showInternalAssessments,
    candidateFresh,
    selectCandidate,
    discussCandidate,
    loadMoreCandidates,
    setShortlist,
  } = model;
  const candidateKeys = useMemo(
    () => candidatePage?.items.map((item) => item.candidateKey),
    [candidatePage],
  );
  const candidateOffsets = useRef({
    table: { offset: 0, measurements: [] as VirtualItem[] },
    cards: { offset: 0, measurements: [] as VirtualItem[] },
  });
  return (
    <TabsContent value="evidence" className="space-y-4">
      {workspace ? (
        <>
          {showDiagnostics
            ? snapshot?.research.tasks.flatMap((task) =>
                snapshot?.research.actions
                  .filter((action) => action.taskId === task.id && action.outputArtifacts.length)
                  .map((action) => (
                    <ResearchResults
                      key={`${task.roleId}:${action.id}`}
                      task={task}
                      action={action}
                      isCurrent={action.roleRevisionId === workspace?.revision.id}
                    />
                  )),
              )
            : null}
          <div
            className={
              filteredShortlistWeek
                ? "hidden"
                : presentation === "workspace"
                  ? "hire-results-filters flex flex-wrap gap-2"
                  : "flex flex-wrap gap-2"
            }
          >
            <Input
              aria-label={t`Search candidates`}
              placeholder={t`Search candidates`}
              value={candidateFilters.query ?? ""}
              onChange={(event) =>
                setCandidateFilters((current) => ({
                  ...current,
                  query: event.target.value || undefined,
                }))
              }
            />
            {showInternalAssessments ? (
              <>
                <NativeSelect
                  aria-label={t`Internal assessment`}
                  value={candidateFilters.assessmentState ?? "all"}
                  onChange={(event) =>
                    setCandidateFilters((current) => ({
                      ...current,
                      assessmentState:
                        event.target.value === "all"
                          ? undefined
                          : (event.target
                              .value as ListRecruitingCandidatesInput["assessmentState"]),
                    }))
                  }
                >
                  <NativeSelectOption value="all">
                    <Trans>All internal assessments</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="unassessed">
                    <Trans>No internal assessment</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="current">
                    <Trans>Internal assessment: current</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="outdated">
                    <Trans>Internal assessment: outdated</Trans>
                  </NativeSelectOption>
                </NativeSelect>
                <NativeSelect
                  aria-label={t`Internal verdict`}
                  value={candidateFilters.verdict ?? "all"}
                  onChange={(event) =>
                    setCandidateFilters((current) => ({
                      ...current,
                      verdict:
                        event.target.value === "all" ? undefined : (event.target.value as Verdict),
                    }))
                  }
                >
                  <NativeSelectOption value="all">
                    <Trans>All internal verdicts</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="met">
                    <Trans>Internal verdict: met</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="unmet">
                    <Trans>Internal verdict: unmet</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="unknown">
                    <Trans>Internal verdict: unknown</Trans>
                  </NativeSelectOption>
                </NativeSelect>
              </>
            ) : null}
            {candidatePage ? (
              <NativeSelect
                aria-label={t`Candidate sort`}
                value={candidateFilters.sort ?? "score"}
                onChange={(event) => {
                  setCandidateFilters((current) => ({
                    ...current,
                    sort: event.target.value as ListRecruitingCandidatesInput["sort"],
                  }));
                  setCandidateList((current) => ({ ...current, userSort: true }));
                }}
              >
                {candidatePage.sortAvailability.rank ? (
                  <NativeSelectOption value="rank">
                    {showDiagnostics ? <Trans>Autumn rank</Trans> : <Trans>Rank</Trans>}
                  </NativeSelectOption>
                ) : null}
                {candidatePage.sortAvailability.tier ? (
                  <NativeSelectOption value="tier">
                    <Trans>Match tier</Trans>
                  </NativeSelectOption>
                ) : null}
                {candidatePage.sortAvailability.score ? (
                  <NativeSelectOption value="score">
                    <Trans>Match score</Trans>
                  </NativeSelectOption>
                ) : null}
                <NativeSelectOption value="name">
                  <Trans>Name</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="recent">
                  <Trans>Recently discovered</Trans>
                </NativeSelectOption>
              </NativeSelect>
            ) : null}
            <NativeSelect
              aria-label={t`Research round`}
              disabled={!snapshot}
              value={
                candidateFilters.sourceEffectId
                  ? `source:${candidateFilters.sourceEffectId}`
                  : candidateFilters.actionId
                    ? `action:${candidateFilters.actionId}`
                    : "all"
              }
              onChange={(event) => {
                const value = event.target.value;
                setCandidateFilters((current) => ({
                  ...current,
                  actionId: value.startsWith("action:") ? value.slice(7) : undefined,
                  sourceEffectId: value.startsWith("source:") ? value.slice(7) : undefined,
                }));
              }}
            >
              <NativeSelectOption value="all">
                <Trans>All rounds</Trans>
              </NativeSelectOption>
              {snapshot?.research.actions.map((action, index) => (
                <NativeSelectOption key={`action:${action.id}`} value={`action:${action.id}`}>
                  {showDiagnostics ? (
                    <>
                      {action.kind} · {action.id}
                    </>
                  ) : (
                    <Trans>Search update {index + 1}</Trans>
                  )}
                </NativeSelectOption>
              ))}
              {snapshot?.research.observations.map((observation) => (
                <NativeSelectOption
                  key={`source:${observation.effectId}`}
                  value={`source:${observation.effectId}`}
                >
                  <Trans>Saved results</Trans>
                  {" · "}
                  {new Date(observation.observedAt).toLocaleString(undefined, {
                    timeZone: "America/Los_Angeles",
                    timeZoneName: "short",
                  })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {!(presentation === "workspace" && view === "shortlist") ? (
              <label htmlFor={shortlistFilterId} className="flex items-center gap-2">
                <Checkbox
                  id={shortlistFilterId}
                  checked={candidateFilters.shortlisted === true}
                  onCheckedChange={(checked) =>
                    setCandidateFilters((current) => ({
                      ...current,
                      shortlisted: checked ? true : undefined,
                    }))
                  }
                />
                <Trans>Shortlisted only</Trans>
              </label>
            ) : null}
          </div>
          {!contactsView ? (
            <fieldset
              className={
                presentation === "workspace" ? "hire-view-toggle flex gap-1" : "flex gap-1"
              }
              aria-label={t`Saved candidates`}
            >
              <Button
                size="sm"
                variant={candidateView === "cards" ? "secondary" : "ghost"}
                aria-pressed={candidateView === "cards"}
                onClick={() =>
                  setCandidateList((current) => ({ ...current, candidateView: "cards" }))
                }
              >
                {presentation === "workspace" ? <LayoutGrid size={15} aria-hidden /> : null}
                <Trans>Cards</Trans>
              </Button>
              <Button
                size="sm"
                variant={candidateView === "table" ? "secondary" : "ghost"}
                aria-pressed={candidateView === "table"}
                onClick={() =>
                  setCandidateList((current) => ({ ...current, candidateView: "table" }))
                }
              >
                {presentation === "workspace" ? <List size={15} aria-hidden /> : null}
                <Trans>Table</Trans>
              </Button>
            </fieldset>
          ) : null}
          {contactsView ? (
            <ContactsTab
              shortlistWeekFilter={shortlistWeekFilter}
              onClearShortlistWeekFilter={onClearShortlistWeekFilter}
              roleId={workspace.role.id}
              spaceId={workspace.role.spaceId}
              criterionRevision={workspace.revision}
              conversation={groupId ? { groupId } : botId ? { botId } : undefined}
              crmTarget={workspace.crmTarget?.target ?? null}
              refreshSignal={(refreshSignal ?? 0) + refresh}
              readCache={readCache}
              readCacheScope={readCacheScope}
              autumn={{
                items: candidatePage?.items ?? [],
                loading: candidateLoading && !candidatePage,
                failed: candidateFailed,
                retry: () => setFeedbackRefresh((value) => value + 1),
                total: candidatePage?.total ?? null,
                hasMore: Boolean(candidatePage?.nextCursor),
                loadMore: () => void loadMoreCandidates(),
                sortByScore: (candidateFilters.sort ?? "score") === "score",
                includeCrm:
                  !candidateFilters.shortlisted &&
                  !candidateFilters.actionId &&
                  !candidateFilters.sourceEffectId &&
                  !candidateFilters.assessmentState &&
                  !candidateFilters.verdict,
                query: candidateFilters.query,
                selectedKey: selection?.candidateKey,
                ready: candidateFresh && shortlistPending === null,
                shortlistFailedKey: shortlistFailed,
                setShortlist: (candidate, shortlisted) => void setShortlist(candidate, shortlisted),
                sendEmail: onDiscussCandidate
                  ? (candidate) => discussCandidate(candidate, "email_draft")
                  : undefined,
                findEmail: onDiscussCandidate
                  ? (candidate) => discussCandidate(candidate, "contact_lookup")
                  : undefined,
                openEvidence: (candidate, trigger) =>
                  selectCandidate(candidate, trigger as HTMLButtonElement),
              }}
            />
          ) : candidateFailed ? (
            <RetryNotice onRetry={() => setFeedbackRefresh((value) => value + 1)}>
              <Trans>Could not load candidates</Trans>
            </RetryNotice>
          ) : candidateLoading && !candidatePage ? (
            <TabLoading />
          ) : null}
          {!contactsView && candidatePage ? (
            <RecruitingLegacyResults
              model={model}
              candidateKeys={candidateKeys}
              candidateOffsets={candidateOffsets}
            />
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">
          <Trans>No role linked</Trans>
        </p>
      )}
    </TabsContent>
  );
}
