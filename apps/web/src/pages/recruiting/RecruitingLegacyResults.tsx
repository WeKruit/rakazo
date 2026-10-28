import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button, Card, CardContent, Checkbox } from "@rakazo/ui-web";
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

import type { useRecruitingWorkspace } from "../recruiting/useRecruitingWorkspace";
import { CandidateWindow } from "./CandidateWindow";
export function RecruitingLegacyResults({
  model,
  candidateKeys,
  candidateOffsets,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
  candidateKeys: readonly string[] | undefined;
  candidateOffsets: import("./CandidateWindow").CandidateWindowProps["offsets"];
}) {
  const { t } = useLingui();
  const {
    onBrowseCandidates,
    onDiscussCandidate,
    showDiagnostics,
    presentation,
    snapshot,
    shortlistView,
    candidateView,
    candidateTableDetails,
    selection,
    candidateTrigger,
    candidatePage,
    arrival,
    setCandidateFilters,
    candidateLoading,
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
    <>
      {candidatePage ? (
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
            <CandidateWindow
              key="legacy-cards"
              mode="cards"
              itemKeys={candidateKeys ?? []}
              offsets={candidateOffsets}
              label={t`Saved candidates`}
              cardGridClassName={presentation === "workspace" ? "hire-card-grid" : "grid gap-2"}
              renderRow={(index) => {
                const candidate = candidatePage.items[index]!;
                return (
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
                              data-candidate-name
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
                              onCheckedChange={(checked) => void setShortlist(candidate, !!checked)}
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
                );
              }}
            />
          ) : (
            <CandidateWindow
              key="legacy-table"
              className={presentation === "workspace" ? "hire-table-wrap" : ""}
              mode="table"
              itemKeys={candidateKeys ?? []}
              offsets={candidateOffsets}
              label={t`Saved candidates`}
              tableClassName={
                presentation === "workspace"
                  ? "hire-table w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
                  : "w-full text-left text-sm [&_td]:align-top [&_th]:align-top"
              }
              header={
                <>
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
                </>
              }
              renderRow={(index) => {
                const candidate = candidatePage.items[index]!;
                return (
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
                        data-candidate-name
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
                        <CandidateProfile candidate={candidate} showDiagnostics={showDiagnostics} />
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
                                <p className="whitespace-pre-wrap">{candidate.decisionReason}</p>
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
                );
              }}
            />
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
  );
}
