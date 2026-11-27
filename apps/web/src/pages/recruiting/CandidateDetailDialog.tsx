import { Trans, useLingui } from "@lingui/react/macro";
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
import { CandidateSources } from "./SourceDocuments";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";

export function CandidateDetailDialog({
  model,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
}) {
  const { t } = useLingui();
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
    candidateValidation,
    denyAccess,
    workspace,
    candidateFresh,
    selectedCrm,
    selectedCrmTarget,
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
      </DialogContent>
    </Dialog>
  );
}
