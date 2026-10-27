import { Trans } from "@lingui/react/macro";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { clearRecruitingReads } from "../../lib/recruiting-read-cache";
import { CandidateFeedbackForm, FeedbackHistory } from "./CandidateFeedback";
import {
  CandidateDecision,
  CandidateProfile,
  CandidateResearchMatch,
  CrmDetails,
} from "./CandidatePresentation";
import { CriteriaExpression } from "./CriteriaEditor";
import { CandidateSources, Sources } from "./SourceDocuments";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";
import { VerdictLabel } from "./VerdictLabel";

export function CandidateDetailDialog({
  model,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
}) {
  const {
    threadId,
    readCache,
    readCacheScope,
    refreshSignal,
    onDiscussCandidate,
    onCandidateFeedback,
    candidateFeedbackRecipients,
    showDiagnostics,
    presentation,
    t,
    snapshot,
    setRefresh,
    feedbackRefresh,
    setFeedbackRefresh,
    candidateDetailOpen,
    selection,
    candidateTrigger,
    candidateClose,
    candidateHandoff,
    candidatePage,
    setCandidateDetailOpen,
    selectedEvidence,
    evidenceFailed,
    candidateValidation,
    denyAccess,
    workspace,
    selected,
    assessment,
    candidateFresh,
    selectedCrm,
    selectedCrmTarget,
    revealCandidateMessage,
  } = model;
  return (
    <Dialog
      open={candidateDetailOpen && !!selection}
      onOpenChange={setCandidateDetailOpen}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const handoff = candidateHandoff.current;
        if (!handoff) return;
        // Let the popup unmount before the native chat callback takes focus.
        queueMicrotask(() => {
          if (candidateHandoff.current !== handoff) return;
          candidateHandoff.current = null;
          handoff();
        });
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={candidateClose}
        data-product-view={presentation === "workspace" ? "recruiting" : undefined}
        finalFocus={candidateHandoff.current ? false : candidateTrigger}
        className={
          presentation === "workspace"
            ? "hire-profile-drawer inset-y-0 right-0 left-auto top-0 h-dvh max-h-dvh translate-x-0 translate-y-0 overflow-y-auto rounded-none text-sm leading-relaxed sm:max-w-2xl"
            : "max-h-[85dvh] overflow-y-auto text-base leading-relaxed sm:max-w-2xl"
        }
      >
        {selection ? (
          <div className="hire-candidate-body space-y-3">
            <div className="hire-candidate-header flex items-start justify-between gap-3">
              <DialogTitle className="break-words">
                {selection.name ??
                  (showDiagnostics ? selection.candidateKey : t`Unnamed candidate`)}
                <CandidateDecision decision={selection.decision} />
              </DialogTitle>
              <DialogClose
                ref={candidateClose}
                aria-label={t`Close`}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <X size={16} aria-hidden />
              </DialogClose>
            </div>
            {selection.title || selection.company || selection.location ? (
              <p className="text-muted-foreground">
                {[selection.title, selection.company, selection.location]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
            <CandidateProfile candidate={selection} showDiagnostics={showDiagnostics} />
            <CandidateResearchMatch
              candidate={selection}
              roleRevisionId={workspace?.revision.id}
              showDiagnostics={showDiagnostics}
            />
            <div className="hire-candidate-actions">
              {onDiscussCandidate && workspace ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    candidateHandoff.current = () =>
                      onDiscussCandidate({
                        threadId,
                        roleTitle: workspace.role.title,
                        name: selection.name,
                        title: selection.title,
                        company: selection.company,
                        linkedinUrl: selection.linkedinUrl,
                        resumeUrl: selection.resumeUrl,
                      });
                    setCandidateDetailOpen(false);
                  }}
                >
                  <Trans>Discuss candidate</Trans>
                </Button>
              ) : null}
              {onCandidateFeedback && workspace && candidateDetailOpen ? (
                <CandidateFeedbackForm
                  key={`${threadId}:${workspace.role.id}:${workspace.revision.id}:${selection.candidateKey}`}
                  candidate={{
                    threadId,
                    roleTitle: workspace.role.title,
                    roleVersion: workspace.revision.revision,
                    roleId: workspace.role.id,
                    roleRevisionId: workspace.revision.id,
                    candidateKey: selection.candidateKey,
                    candidateRevision: selection.revision,
                    name: selection.name,
                    title: selection.title,
                    company: selection.company,
                    linkedinUrl: selection.linkedinUrl,
                    resumeUrl: selection.resumeUrl,
                  }}
                  onSend={(...args) =>
                    candidateFresh &&
                    (!readCache || candidateValidation.current === readCache.epoch)
                      ? onCandidateFeedback(...args)
                      : Promise.resolve(false)
                  }
                  disabled={!candidateFresh}
                  recipients={candidateFeedbackRecipients}
                  onAccessError={denyAccess}
                  onRecorded={() => {
                    clearRecruitingReads(readCache, readCacheScope);
                    setRefresh((value) => value + 1);
                    setFeedbackRefresh((value) => value + 1);
                  }}
                />
              ) : null}
            </div>
            {workspace ? (
              <FeedbackHistory
                key={`feedback:${workspace.role.id}:${selection.candidateKey}`}
                roleId={workspace.role.id}
                candidateKey={selection.candidateKey}
                refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
                collapsed
              />
            ) : null}
            {selectedCrmTarget ? (
              <section aria-label={t`Candidate pipeline`}>
                <CrmDetails
                  sync={selectedCrm}
                  target={selectedCrmTarget}
                  showDiagnostics={showDiagnostics}
                />
              </section>
            ) : null}
            {selection.latestAssessment && evidenceFailed ? (
              <p role="alert">
                <Trans>Could not load assessment</Trans>
              </p>
            ) : selection.latestAssessment && !selectedEvidence ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : selection.latestAssessment && !selected ? (
              <p role="alert">
                <Trans>Assessment unavailable</Trans>
              </p>
            ) : null}
            {workspace && snapshot ? (
              <CandidateSources
                key={`${selection.roleId}:${selection.candidateKey}`}
                candidate={selection}
                research={snapshot.research}
                refreshSignal={candidateFresh ? candidatePage : null}
                roleRevisionId={workspace.revision.id}
                onAccessError={denyAccess}
                showDiagnostics={showDiagnostics}
              />
            ) : null}
          </div>
        ) : null}
        {assessment && selected ? (
          <section
            key={`${assessment.roleId}:${assessment.candidateKey}:${assessment.version}`}
            aria-label={showDiagnostics ? assessment.candidateKey : t`Candidate assessment`}
            className="space-y-4 border-t border-border pt-4"
          >
            <h3 className="font-medium">
              {showDiagnostics
                ? assessment.candidateKey
                : (selection?.name ?? t`Unnamed candidate`)}
            </h3>
            <p className="text-xs text-muted-foreground">
              <Trans>Internal assessment</Trans> · <Trans>Role</Trans> ·{" "}
              <Trans>Version {selected.roleRevision.revision}</Trans>
            </p>
            <p className="flex items-center gap-2">
              <span>
                <Trans>Hard criteria</Trans>
              </span>
              <VerdictLabel verdict={assessment.judgments.hardGate} />
            </p>
            {assessment.judgments.employment.map((employment) => {
              const count =
                employment.upperMonths === employment.lowerMonths
                  ? String(employment.lowerMonths)
                  : `${employment.lowerMonths}–${employment.upperMonths ?? "?"}`;
              const cutoff = `${employment.cutoff.year}-${String(employment.cutoff.month).padStart(2, "0")}-${String(employment.cutoff.day).padStart(2, "0")}`;
              return (
                <div key={employment.atomId} className="space-y-1">
                  <p>{employment.qualificationDefinition}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      <Trans>{count} months</Trans> · ≥ {employment.minimumMonths} · {cutoff}
                    </span>
                    <VerdictLabel verdict={employment.verdict} />
                  </p>
                </div>
              );
            })}
            {assessment.judgments.criteria.map((judgment) => {
              const criterion = selected.roleRevision.criteria.find(
                (item) => item.id === judgment.criterionId,
              );
              const facts = assessment.facts.filter((fact) => judgment.factIds.includes(fact.id));
              const sourceIds = new Set([
                ...facts.flatMap((fact) => fact.sourceRefIds),
                ...judgment.evidence,
              ]);
              return (
                <details key={judgment.criterionId} open className="space-y-2">
                  <summary className="cursor-pointer">
                    <span className="me-2">
                      {criterion?.expression.kind === "atom"
                        ? criterion.expression.statement
                        : t`Criterion`}
                    </span>
                    <VerdictLabel verdict={judgment.verdict} />
                    {criterion ? (
                      <span className="ms-2 text-xs text-muted-foreground">
                        {criterion.priority === "hard" ? (
                          <Trans>Hard criteria</Trans>
                        ) : (
                          <Trans>Preferred criteria</Trans>
                        )}
                      </span>
                    ) : null}
                  </summary>
                  {criterion && criterion.expression.kind !== "atom" ? (
                    <CriteriaExpression expression={criterion.expression} />
                  ) : null}
                  {facts.map((fact) => (
                    <p key={fact.id}>{fact.statement}</p>
                  ))}
                  <Sources
                    sourceTarget={{
                      kind: "assessment",
                      roleId: assessment.roleId,
                      candidateKey: assessment.candidateKey,
                      version: assessment.version,
                    }}
                    sources={assessment.sourceRefs.filter((source) => sourceIds.has(source.id))}
                    messageTargets={selected.sourceMessageTargets}
                    onRevealMessage={revealCandidateMessage}
                    showDiagnostics={showDiagnostics}
                  />
                  {judgment.missing.map((question) => (
                    <p key={question} className="text-muted-foreground">
                      {question}
                    </p>
                  ))}
                </details>
              );
            })}
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Saved facts</Trans>
              </summary>
              <ul className="mt-2 space-y-3">
                {assessment.facts.map((fact) => (
                  <li key={fact.id} className="space-y-2">
                    <p>{fact.statement}</p>
                    <Sources
                      sourceTarget={{
                        kind: "assessment",
                        roleId: assessment.roleId,
                        candidateKey: assessment.candidateKey,
                        version: assessment.version,
                      }}
                      sources={assessment.sourceRefs.filter((source) =>
                        fact.sourceRefIds.includes(source.id),
                      )}
                      messageTargets={selected.sourceMessageTargets}
                      onRevealMessage={revealCandidateMessage}
                      showDiagnostics={showDiagnostics}
                    />
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Sources</Trans>
              </summary>
              <div className="mt-2">
                <Sources
                  sourceTarget={{
                    kind: "assessment",
                    roleId: assessment.roleId,
                    candidateKey: assessment.candidateKey,
                    version: assessment.version,
                  }}
                  showDiagnostics={showDiagnostics}
                  sources={assessment.sourceRefs}
                  messageTargets={selected.sourceMessageTargets}
                  onRevealMessage={revealCandidateMessage}
                />
              </div>
            </details>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
