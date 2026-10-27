import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ListRecruitingCandidatesInput, Verdict } from "@rakazo/contracts";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
  TabsContent,
} from "@rakazo/ui-web";
import { LayoutGrid, List } from "lucide-react";
import { readRecruitingPanelState } from "../../lib/right-panel-state";
import {
  CandidateAssessment,
  CandidateContactFields,
  CandidateCriteria,
  CandidateDecision,
  CandidateProfile,
  CandidateResearchMatch,
  CandidateSourceRound,
  CONTACT_STATUS_LABELS,
  CrmStatus,
  SourcingCandidateCard,
} from "../recruiting/CandidatePresentation";
import { ContactsTab } from "../recruiting/ContactsTab";
import { RetryNotice } from "../recruiting/RetryNotice";
import { ResearchResults } from "../recruiting/SourceDocuments";
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
    onBrowseCandidates,
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
    shortlistView,
    candidateView,
    filteredShortlistWeek,
    candidateFilters,
    candidateTableDetails,
    selection,
    candidateTrigger,
    candidatePage,
    arrival,
    setCandidateFilters,
    candidateLoading,
    candidateFailed,
    shortlistPending,
    shortlistFailed,
    workspace,
    showInternalAssessments,
    candidateFresh,
    showCrm,
    selectCandidate,
    discussCandidate,
    loadMoreCandidates,
    setShortlist,
  } = model;
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
            <>
              <p className="text-xs text-muted-foreground">
                <Plural value={candidatePage.total} _1="# candidate" other="# candidates" />
              </p>
              {candidatePage.crmTarget ? (
                <p className="text-xs text-muted-foreground">
                  <Trans>Pipeline</Trans> · {candidatePage.crmTarget.target.clientLabel} ·{" "}
                  {candidatePage.crmTarget.target.roleLabel}
                </p>
              ) : null}
              {!candidatePage.items.length ? (
                <div className="space-y-3 text-muted-foreground">
                  <p>
                    {shortlistView ? (
                      candidatePage.counts.shortlisted === 0 ? (
                        <Trans>No shortlisted candidates yet.</Trans>
                      ) : (
                        <Trans>No shortlisted candidates match these filters.</Trans>
                      )
                    ) : (
                      <Trans>No saved candidates</Trans>
                    )}
                  </p>
                  {shortlistView && onBrowseCandidates ? (
                    <>
                      <p>
                        <Trans>Shortlist people from search results to keep them here.</Trans>
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setCandidateFilters(() => readRecruitingPanelState(null).filters);
                          onBrowseCandidates();
                        }}
                      >
                        <Trans>Browse all candidates</Trans>
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : candidateView === "cards" ? (
                <ul className={presentation === "workspace" ? "hire-card-grid" : "grid gap-2"}>
                  {candidatePage.items.map((candidate) => (
                    <li key={candidate.candidateKey} {...arrival(candidate.candidateKey)}>
                      {presentation === "workspace" ? (
                        <SourcingCandidateCard
                          candidate={candidate}
                          selected={selection?.candidateKey === candidate.candidateKey}
                          triggerRef={
                            selection?.candidateKey === candidate.candidateKey
                              ? candidateTrigger
                              : undefined
                          }
                          onOpen={(trigger) => selectCandidate(candidate, trigger)}
                          onShortlist={() => void setShortlist(candidate, !candidate.shortlisted)}
                          shortlistPending={shortlistPending !== null || !candidateFresh}
                          shortlistFailed={shortlistFailed === candidate.candidateKey}
                          onEmailDraft={
                            onDiscussCandidate
                              ? () => discussCandidate(candidate, "email_draft")
                              : undefined
                          }
                        />
                      ) : (
                        <Card
                          size="sm"
                          className={
                            selection?.candidateKey === candidate.candidateKey
                              ? "ring-primary"
                              : undefined
                          }
                        >
                          <CardContent className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <Button
                                ref={
                                  selection?.candidateKey === candidate.candidateKey
                                    ? candidateTrigger
                                    : undefined
                                }
                                variant="link"
                                className="h-auto justify-start whitespace-normal break-all p-0 text-left"
                                aria-haspopup="dialog"
                                aria-pressed={selection?.candidateKey === candidate.candidateKey}
                                onClick={(event) => selectCandidate(candidate, event.currentTarget)}
                              >
                                {candidate.name ??
                                  (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}
                              </Button>
                              <Checkbox
                                aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                checked={candidate.shortlisted}
                                disabled={shortlistPending !== null || !candidateFresh}
                                onCheckedChange={(checked) =>
                                  void setShortlist(candidate, !!checked)
                                }
                              />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {workspace?.role.title}
                              <CandidateDecision decision={candidate.decision} />
                            </p>
                            {candidate.title || candidate.company ? (
                              <p>
                                {[candidate.title, candidate.company].filter(Boolean).join(" · ")}
                              </p>
                            ) : null}
                            {candidate.location ? (
                              <p className="text-muted-foreground">{candidate.location}</p>
                            ) : null}
                            <CandidateProfile
                              candidate={candidate}
                              showDiagnostics={showDiagnostics}
                            />
                            <CandidateResearchMatch
                              candidate={candidate}
                              roleRevisionId={workspace?.revision.id}
                              showDiagnostics={showDiagnostics}
                            />
                            <CandidateAssessment candidate={candidate} />
                            {showCrm ? (
                              <p className="text-xs text-muted-foreground">
                                <Trans>Pipeline</Trans> · <CrmStatus sync={candidate.crm} />
                              </p>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              <Trans>{candidate.discoveryCount} saved discoveries</Trans>
                            </p>
                            {shortlistFailed === candidate.candidateKey ? (
                              <p role="alert" className="text-destructive">
                                <Trans>Could not save shortlist</Trans>
                              </p>
                            ) : null}
                          </CardContent>
                        </Card>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div
                  className={
                    presentation === "workspace"
                      ? "hire-table-wrap overflow-x-auto"
                      : "overflow-x-auto"
                  }
                >
                  <table
                    className={
                      presentation === "workspace"
                        ? "hire-table w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
                        : "w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
                    }
                  >
                    <caption className="sr-only">
                      <Trans>Saved candidates</Trans>
                    </caption>
                    <thead>
                      <tr className="border-b border-border">
                        {[
                          t`Candidate`,
                          ...(presentation !== "workspace" ? [t`Role`] : []),
                          presentation === "workspace" ? t`Current role` : t`Title`,
                          t`Company`,
                          t`Location`,
                          ...(presentation !== "workspace" ? [t`Profile`] : []),
                          t`Research match`,
                          ...(candidateTableDetails ? [t`Criteria`] : []),
                          ...(showInternalAssessments ? [t`Internal assessment`] : []),
                          ...(candidateTableDetails ? [t`Research round`, t`Feedback`] : []),
                          ...(showCrm ? [t`Pipeline`] : []),
                          ...(candidateTableDetails ? [t`Provider status`] : []),
                          ...(presentation !== "workspace" ? [t`Discoveries`] : []),
                          t`Shortlist`,
                        ].map((label) => (
                          <th key={label} scope="col" className="py-2 pe-3 font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {candidatePage.items.map((candidate) => (
                        <tr
                          key={candidate.candidateKey}
                          style={arrival(candidate.candidateKey).style}
                          className={`border-b border-border ${arrival(candidate.candidateKey).className ?? ""}`}
                        >
                          <th scope="row" className="min-w-32 py-2 pe-3">
                            <Button
                              ref={
                                selection?.candidateKey === candidate.candidateKey
                                  ? candidateTrigger
                                  : undefined
                              }
                              variant="link"
                              className="h-auto justify-start whitespace-normal p-0 text-left"
                              aria-haspopup="dialog"
                              aria-pressed={selection?.candidateKey === candidate.candidateKey}
                              onClick={(event) => selectCandidate(candidate, event.currentTarget)}
                            >
                              {candidate.name ??
                                (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}
                            </Button>
                            {presentation === "workspace" ? (
                              <CandidateProfile candidate={candidate} />
                            ) : null}
                          </th>
                          {presentation !== "workspace" ? (
                            <td className="py-2 pe-3">
                              {workspace?.role.title}
                              <CandidateDecision decision={candidate.decision} />
                            </td>
                          ) : null}
                          <td className="py-2 pe-3">{candidate.title ?? "—"}</td>
                          <td className="py-2 pe-3">{candidate.company ?? "—"}</td>
                          <td className="py-2 pe-3">{candidate.location ?? "—"}</td>
                          {presentation !== "workspace" ? (
                            <td className="py-2 pe-3">
                              <CandidateProfile
                                candidate={candidate}
                                showDiagnostics={showDiagnostics}
                              />
                            </td>
                          ) : null}
                          <td className="min-w-48 py-2 pe-3">
                            <CandidateResearchMatch
                              candidate={candidate}
                              roleRevisionId={workspace?.revision.id}
                              showDiagnostics={showDiagnostics}
                              compact
                            />
                          </td>
                          {candidateTableDetails ? (
                            <td className="min-w-48 py-2 pe-3 text-xs">
                              <CandidateCriteria candidate={candidate} />
                            </td>
                          ) : null}
                          {showInternalAssessments ? (
                            <td className="py-2 pe-3">
                              <CandidateAssessment candidate={candidate} />
                            </td>
                          ) : null}
                          {candidateTableDetails ? (
                            <>
                              <td className="py-2 pe-3 text-xs">
                                <CandidateSourceRound
                                  candidate={candidate}
                                  research={snapshot?.research}
                                />
                              </td>
                              <td className="py-2 pe-3 text-xs">
                                {candidate.decision ? (
                                  <>
                                    <CandidateDecision decision={candidate.decision} />
                                    {candidate.decisionReason ? (
                                      <p className="whitespace-pre-wrap">
                                        {candidate.decisionReason}
                                      </p>
                                    ) : null}
                                  </>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </>
                          ) : null}
                          {showCrm ? (
                            <td className="py-2 pe-3 text-xs">
                              <CrmStatus sync={candidate.crm} />
                            </td>
                          ) : null}
                          {candidateTableDetails ? (
                            <td className="py-2 pe-3 text-xs">
                              <CandidateContactFields
                                candidate={candidate}
                                contacts={[]}
                                kind="status"
                                labels={CONTACT_STATUS_LABELS}
                              />
                            </td>
                          ) : null}
                          {presentation !== "workspace" ? (
                            <td className="py-2 pe-3 tabular-nums">{candidate.discoveryCount}</td>
                          ) : null}
                          <td className="py-2">
                            <Checkbox
                              aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                              checked={candidate.shortlisted}
                              disabled={shortlistPending !== null || !candidateFresh}
                              onCheckedChange={(checked) => void setShortlist(candidate, !!checked)}
                            />
                            {shortlistFailed === candidate.candidateKey ? (
                              <p role="alert">
                                <Trans>Could not save shortlist</Trans>
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {candidatePage.nextCursor ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={candidateLoading}
                  onClick={() => void loadMoreCandidates()}
                >
                  <Trans>Load more</Trans>
                </Button>
              ) : null}
            </>
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
