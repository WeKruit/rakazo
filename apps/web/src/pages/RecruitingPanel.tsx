import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type {
  Artifact,
  ArtifactWithContent,
  EditRecruitingCriteriaInput,
  ListRecruitingCandidatesInput,
  ListRecruitingCandidatesOutput,
  MemoryDocument,
  MemoryRevision,
  ReadRecruitingSourceInput,
  RecruitingArtifactRef,
  RecruitingAssessmentSourceRef,
  RecruitingCandidate,
  RecruitingCandidateFeedbackSelection,
  RecruitingCandidateReport,
  RecruitingCriterionExpression,
  RecruitingCrmCandidateSync,
  RecruitingCrmTarget,
  RecruitingEmploymentDay,
  RecruitingEmploymentRule,
  RecruitingFeedbackRecord,
  RecruitingResearchAction,
  RecruitingResearchReadArtifact,
  RecruitingResearchTask,
  RecruitingRoleRevision,
  RecruitingSourceRef,
  Verdict,
} from "@rakazo/contracts";
import { RecruitingEmploymentDaySchema, RecruitingEmploymentRuleSchema } from "@rakazo/contracts";
import {
  readRecruitingJsonString,
  readRecruitingResearchReadArtifact,
  recruitingBriefClarifications,
  validateRecruitingTextSelection,
  verifyRecruitingArtifactBytes,
} from "@rakazo/core";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@rakazo/ui-web";
import { Check, CircleHelp, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { Shimmer } from "../components/ai/primitives";
import { decodeArtifactBase64 } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import type { RecruitingPanelState } from "../lib/right-panel-state";
import {
  readRecruitingPanelState,
  rightPanelStorageKey,
  writeRecruitingPanelState,
} from "../lib/right-panel-state";
import { rpc } from "../lib/rpc";

export type CandidateDiscussionContext = Pick<
  RecruitingCandidate,
  "name" | "title" | "company" | "linkedinUrl" | "resumeUrl"
> & {
  threadId: string;
  roleTitle: string;
  roleVersion?: number;
  roleId?: string;
  roleRevisionId?: string;
  candidateKey?: string;
  candidateRevision?: number;
};

export type CandidateFeedback = {
  choice: RecruitingCandidateFeedbackSelection["choice"];
  reason: string;
  recipientBotId?: string;
};

type Props = {
  threadId: string;
  botId?: string;
  refreshSignal?: number;
  onClose: () => void;
  showDiagnostics?: boolean;
  tab?: RecruitingPanelState["tab"];
  onTabChange?: (tab: RecruitingPanelState["tab"]) => void;
  onRevealMessage?: (target: { botId?: string; groupId?: string; messageId: string }) => void;
  onDiscussCandidate?: (candidate: CandidateDiscussionContext) => void;
  candidateFeedbackRecipients?: { id: string; name: string }[];
  onCandidateFeedback?: (
    candidate: CandidateDiscussionContext,
    feedback: CandidateFeedback,
    clientNonce: string,
  ) => Promise<boolean>;
};
type SourceReadTarget =
  | Omit<Extract<ReadRecruitingSourceInput, { kind: "role" }>, "sourceRefId">
  | Omit<Extract<ReadRecruitingSourceInput, { kind: "assessment" }>, "sourceRefId">;
type SourceContent = Awaited<ReturnType<typeof rpc.recruiting.readSource>>;
type Snapshot = {
  workspace: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
  assessments: Awaited<ReturnType<typeof rpc.recruiting.listAssessments>>;
  research: Awaited<ReturnType<typeof rpc.recruiting.listResearch>>;
  questions: Awaited<ReturnType<typeof rpc.recruiting.listQuestions>>["questions"];
  documents: MemoryDocument[];
};

function CandidateFeedbackForm({
  candidate,
  recipients,
  onSend,
  onAccessError,
  onRecorded,
}: {
  candidate: CandidateDiscussionContext;
  recipients: Props["candidateFeedbackRecipients"];
  onSend: NonNullable<Props["onCandidateFeedback"]>;
  onAccessError: (error: unknown) => void;
  onRecorded: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<CandidateFeedback["choice"] | "">("");
  const [reason, setReason] = useState("");
  const [recipientBotId, setRecipientBotId] = useState(recipients?.[0]?.id);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState(false);
  const reasonRequired = choice === "good_example" || choice === "not_fit";
  const scope = useRef({ active: true, busy: false, generation: 0 });
  const attempt = useRef<
    (CandidateFeedback & { candidate: CandidateDiscussionContext; clientNonce: string }) | null
  >(null);
  const recipientUnavailable =
    recipients !== undefined && !recipients.some((member) => member.id === recipientBotId);
  useEffect(() => {
    if (!recipientUnavailable) return;
    scope.current.generation++;
    setSent(false);
    setFailed(false);
  }, [recipientUnavailable]);
  useEffect(() => {
    scope.current.active = true;
    return () => {
      scope.current.active = false;
      scope.current.generation++;
    };
  }, []);
  function edited() {
    scope.current.generation++;
    setSent(false);
    setFailed(false);
  }
  async function submit() {
    if (scope.current.busy || recipientUnavailable || !choice || (reasonRequired && !reason.trim()))
      return;
    const generation = scope.current.generation;
    if (
      attempt.current?.choice !== choice ||
      attempt.current.reason !== reason ||
      attempt.current.recipientBotId !== recipientBotId
    )
      attempt.current = {
        candidate,
        choice,
        reason,
        ...(recipientBotId ? { recipientBotId } : {}),
        clientNonce: crypto.randomUUID(),
      };
    const submission = attempt.current;
    scope.current.busy = true;
    setPending(true);
    setFailed(false);
    setSent(false);
    try {
      const { candidate: originalCandidate, clientNonce, ...feedback } = submission;
      const accepted = await onSend(originalCandidate, feedback, clientNonce);
      if (!scope.current.active) return;
      if (accepted) {
        attempt.current = null;
        onRecorded();
      }
      if (scope.current.generation !== generation) return;
      if (accepted) {
        setChoice("");
        setReason("");
        setSent(true);
      } else setFailed(true);
    } catch (error) {
      if (!scope.current.active) return;
      onAccessError(error);
      if (scope.current.generation === generation) setFailed(true);
    } finally {
      scope.current.busy = false;
      if (scope.current.active) setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Trans>Give feedback</Trans>
      </Button>
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {recipients && recipients.length > 1 ? (
            <NativeSelect
              className="[&_select]:text-base"
              aria-label={t`Send to`}
              aria-invalid={recipientUnavailable || undefined}
              required
              value={recipientBotId ?? ""}
              onChange={(event) => {
                edited();
                setRecipientBotId(event.target.value);
              }}
            >
              {recipientUnavailable ? (
                <NativeSelectOption value={recipientBotId ?? ""} disabled>
                  <Trans>Selected recipient unavailable</Trans>
                </NativeSelectOption>
              ) : null}
              {recipients.map((member) => (
                <NativeSelectOption key={member.id} value={member.id}>
                  {member.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : recipientUnavailable ? (
            <p role="alert">
              <Trans>Selected recipient unavailable</Trans>
            </p>
          ) : null}
          <NativeSelect
            className="[&_select]:text-base"
            aria-label={t`Feedback`}
            required
            value={choice}
            onChange={(event) => {
              edited();
              setChoice(event.target.value as CandidateFeedback["choice"] | "");
            }}
          >
            <NativeSelectOption value="">
              <Trans>Choose feedback</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="good_example">
              <Trans>Good example</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="not_fit">
              <Trans>Not a fit</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="skip">
              <Trans>Skip for now</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="hold">
              <Trans>Pause consideration</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="pass">
              <Trans>Stop considering</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="resume">
              <Trans>Resume consideration</Trans>
            </NativeSelectOption>
          </NativeSelect>
          <Textarea
            className="text-base md:text-base"
            aria-label={t`Reason`}
            placeholder={t`Reason`}
            required={reasonRequired}
            value={reason}
            onChange={(event) => {
              edited();
              setReason(event.target.value);
            }}
          />
          <Button
            size="sm"
            type="submit"
            disabled={
              pending || recipientUnavailable || !choice || (reasonRequired && !reason.trim())
            }
          >
            {pending ? <Trans>Sending…</Trans> : <Trans>Send feedback</Trans>}
          </Button>
          {failed ? (
            <p role="alert">
              <Trans>Could not confirm feedback. Try again.</Trans>
            </p>
          ) : null}
        </form>
      ) : null}
      {sent ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Feedback sent</Trans>
        </p>
      ) : null}
    </div>
  );
}

function FeedbackHistory({
  roleId,
  candidateKey,
  refreshSignal,
  onAccessError,
}: {
  roleId: string;
  candidateKey?: string;
  refreshSignal?: number;
  onAccessError: (error: unknown) => void;
}) {
  const [records, setRecords] = useState<RecruitingFeedbackRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const read = useCallback(
    async (before?: string) => {
      const current = ++generation.current;
      setPending(true);
      setFailed(false);
      try {
        const result = await rpc.recruiting.listFeedback({
          roleId,
          ...(candidateKey ? { candidateKey } : {}),
          limit: 20,
          ...(before ? { before } : {}),
        });
        if (current !== generation.current) return;
        setRecords((previous) => (before ? [...previous, ...result.feedback] : result.feedback));
        setCursor(result.nextCursor);
      } catch (error) {
        if (current !== generation.current) return;
        onAccessError(error);
        setFailed(true);
      } finally {
        if (current === generation.current) setPending(false);
      }
    },
    [roleId, candidateKey, onAccessError],
  );
  useEffect(() => {
    setRecords([]);
    setCursor(null);
    void read();
    return () => {
      generation.current++;
    };
  }, [read, refreshSignal]);
  if (!records.length && !failed) return null;
  return (
    <section className="space-y-2">
      <h4 className="font-medium">
        <Trans>Feedback history</Trans>
      </h4>
      {records.map((record) => (
        <div key={record.id} className="space-y-1 border-l pl-3">
          <p className="text-sm text-muted-foreground">
            {record.choice === "good_example" ? (
              <Trans>Good example</Trans>
            ) : record.choice === "not_fit" ? (
              <Trans>Not a fit</Trans>
            ) : record.choice === "skip" ? (
              <Trans>Skip for now</Trans>
            ) : record.choice === "hold" ? (
              <Trans>Pause consideration</Trans>
            ) : record.choice === "pass" ? (
              <Trans>Stop considering</Trans>
            ) : record.choice === "resume" ? (
              <Trans>Resume consideration</Trans>
            ) : null}
            {record.choice ? " · " : null}
            <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time>
            {record.feedback.target !== "preference" ? (
              <>
                {" "}
                · <Trans>Role version {record.feedback.expectedRoleRevision}</Trans>
              </>
            ) : null}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{record.source.quote}</p>
        </div>
      ))}
      {failed ? (
        <p role="alert">
          <Trans>Could not load feedback</Trans>
        </p>
      ) : null}
      {cursor || failed ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void read(cursor ?? undefined)}
        >
          {failed ? <Trans>Retry</Trans> : <Trans>More</Trans>}
        </Button>
      ) : null}
    </section>
  );
}

function CandidateDecision({ decision }: Pick<RecruitingCandidate, "decision">) {
  if (!decision) return null;
  return (
    <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">
      {" · "}
      {decision === "hold" ? (
        <Trans>On hold</Trans>
      ) : decision === "pass" ? (
        <Trans>Not pursuing</Trans>
      ) : (
        <Trans>Consideration resumed</Trans>
      )}
    </span>
  );
}

function CandidateCounts({ counts }: { counts: ListRecruitingCandidatesOutput["counts"] }) {
  const { t } = useLingui();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3" aria-label={t`Saved candidate totals`}>
      {[
        [<Trans key="source">Saved source rows</Trans>, counts.sourceRows],
        [<Trans key="candidates">Candidates</Trans>, counts.candidates],
        [<Trans key="identified">Identified profiles</Trans>, counts.identifiedCandidates],
        [<Trans key="shortlist">Shortlist</Trans>, counts.shortlisted],
      ].map(([label, value], index) => (
        <div key={index}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CandidateProfile({
  candidate,
  showDiagnostics = false,
}: {
  candidate: RecruitingCandidate;
  showDiagnostics?: boolean;
}) {
  const resumeStatus = candidate.latestSource?.report?.fields
    .find((field) => field.label === "Resume status")
    ?.value?.trim();
  return (
    <div className="space-y-1 text-xs">
      {!candidate.name ? (
        <p className="text-muted-foreground">
          <Trans>Name missing</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {candidate.linkedinUrl ? (
          <a className="underline" href={candidate.linkedinUrl} target="_blank" rel="noreferrer">
            <Trans>LinkedIn</Trans>
          </a>
        ) : (
          <span className="text-muted-foreground">
            <Trans>LinkedIn missing</Trans>
          </span>
        )}
        {candidate.resumeUrl ? (
          <a className="underline" href={candidate.resumeUrl} target="_blank" rel="noreferrer">
            <Trans>Resume</Trans>
            {resumeStatus ? ` (${resumeStatus})` : null}
          </a>
        ) : (
          <span className="text-muted-foreground">
            {resumeStatus ? (
              <>
                <Trans>Resume</Trans>: {resumeStatus}
              </>
            ) : (
              <Trans>Resume missing</Trans>
            )}
          </span>
        )}
      </div>
      {candidate.discoveryCount || candidate.issues.length || candidate.evidenceUrls?.length ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>Profile details</Trans>
          </summary>
          {candidate.discoveryCount ? (
            <p>{showDiagnostics ? "provider_report" : <Trans>Research findings</Trans>}</p>
          ) : null}
          {showDiagnostics ? candidate.issues.map((issue) => <p key={issue}>{issue}</p>) : null}
          {candidate.evidenceUrls?.map((url) => (
            <a
              key={url}
              className="block break-all underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {showDiagnostics ? url : new URL(url).hostname}
            </a>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function CandidateResearchMatch({
  candidate,
  roleRevisionId,
  compact = false,
}: {
  candidate: RecruitingCandidate;
  roleRevisionId?: string;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const source = candidate.latestSource;
  const hasHigherRank = source?.report?.fields.some((field) =>
    ["Updated rank", "Overall rank", "Rank"].includes(field.label),
  );
  const fields = source?.report?.fields.filter(
    (field) =>
      [
        "Rank",
        "Updated rank",
        "Overall rank",
        "Original pool rank",
        "Batch rank",
        "Recommendation",
        "Match judgment",
        "Fit reasons",
        "Score",
        "Match score",
        "Match tier",
        "Grade",
      ].includes(field.label) &&
      (!compact || field.label !== "Fit reasons") &&
      (field.label !== "Batch rank" || !hasHigherRank),
  );
  fields?.sort((a, b) => Number(a.label === "Fit reasons") - Number(b.label === "Fit reasons"));
  const hasMatchRating = fields?.some((field) =>
    ["Score", "Match score", "Match tier", "Grade"].includes(field.label),
  );
  return (
    <dl aria-label={t`Research match`} className="space-y-1 text-xs">
      <dt className="text-muted-foreground">
        <Trans>Research match</Trans>
      </dt>
      <dd>
        {source && roleRevisionId && source.roleRevisionId !== roleRevisionId ? (
          <p className="text-muted-foreground">
            <Trans>Saved before latest role update</Trans>
          </p>
        ) : null}
        {source && !source.report ? (
          <p className="text-muted-foreground">
            <Trans>Source unavailable</Trans>
          </p>
        ) : (
          <>
            {!hasMatchRating ? (
              <p className="text-muted-foreground">
                <Trans>Score / tier not returned</Trans>
              </p>
            ) : null}
            {fields?.length ? (
              <dl>
                {fields.map((field) => (
                  <div key={field.label} className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd
                      className={`wrap-anywhere ${
                        compact
                          ? ["Recommendation", "Match judgment"].includes(field.label)
                            ? "line-clamp-2"
                            : ""
                          : "whitespace-pre-wrap text-base"
                      }`}
                    >
                      {field.value ?? <Trans>Unknown</Trans>}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}
      </dd>
    </dl>
  );
}

function CandidateAssessment({ candidate }: { candidate: RecruitingCandidate }) {
  const assessment = candidate.latestAssessment;
  return assessment ? (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        <Trans>Internal assessment</Trans> · <Trans>Version {assessment.version}</Trans> ·{" "}
        {assessment.isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
      </span>
      <VerdictLabel verdict={assessment.hardGate} />
    </div>
  ) : null;
}

function ResearchActionStatus({ action }: { action: RecruitingResearchAction }) {
  return (
    <>
      {action.kind === "create" ? <Trans>New search</Trans> : <Trans>Search follow-up</Trans>}
      {" · "}
      {action.deliveryState === "prepared" ? (
        <Trans>Prepared</Trans>
      ) : action.deliveryState === "sending" ? (
        <Trans>Submitting</Trans>
      ) : action.deliveryState === "accepted" ? (
        <Trans>Submitted</Trans>
      ) : action.deliveryState === "rejected" ? (
        <Trans>Not accepted</Trans>
      ) : action.deliveryState === "superseded" ? (
        <Trans>Replaced</Trans>
      ) : (
        <Trans>Outcome unknown</Trans>
      )}
    </>
  );
}

function CrmStatus({ sync }: { sync: RecruitingCrmCandidateSync | null }) {
  if (!sync) return <Trans>Sync not confirmed</Trans>;
  switch (sync.status) {
    case "pending":
      return <Trans>Pending approval</Trans>;
    case "approved":
      return <Trans>Approved</Trans>;
    case "syncing":
      return <Trans>Syncing</Trans>;
    case "synced":
      return sync.receipt ? <Trans>Synced</Trans> : <Trans>Outcome unknown</Trans>;
    case "unknown":
      return <Trans>Outcome unknown</Trans>;
    case "denied":
      return <Trans>Denied</Trans>;
    case "stopped":
      return <Trans>Stopped</Trans>;
  }
}

function CrmDetails({
  sync,
  target,
  showDiagnostics = false,
}: {
  sync: RecruitingCrmCandidateSync | null;
  target: RecruitingCrmTarget;
  showDiagnostics?: boolean;
}) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        {target.clientLabel} · {target.roleLabel}
      </p>
      <p>
        <Trans>CRM</Trans> · <CrmStatus sync={sync} />
      </p>
      {showDiagnostics && sync?.status === "synced" && sync.receipt ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>CRM receipt</Trans>
          </summary>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(sync.receipt, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function CandidateReport({ report }: { report: RecruitingCandidateReport }) {
  const fieldUrls = new Set(report.fields.flatMap((field) => field.sourceUrls));
  return (
    <div className="space-y-3 break-words font-sans text-base leading-relaxed">
      <dl className="space-y-3">
        {report.fields.map((field, index) => (
          <div key={index}>
            <dt className="font-medium">{field.label}</dt>
            <dd className="space-y-1">
              <p className="whitespace-pre-wrap">{field.value ?? <Trans>Unknown</Trans>}</p>
              {field.evidence ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{field.evidence}</p>
              ) : null}
              {field.reasoning ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{field.reasoning}</p>
              ) : null}
              {field.sourceUrls.map((url) => (
                <a
                  key={url}
                  className="block break-all underline"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {new URL(url).hostname}
                </a>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {report.sourceUrls
        .filter((url) => !fieldUrls.has(url))
        .map((url) => (
          <a
            key={url}
            className="block break-all underline"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {new URL(url).hostname}
          </a>
        ))}
    </div>
  );
}

function CandidateSources({
  candidate,
  research,
  refreshSignal,
  roleRevisionId,
  onAccessError,
  showDiagnostics = false,
}: {
  candidate: RecruitingCandidate;
  research: Snapshot["research"];
  refreshSignal: ListRecruitingCandidatesOutput | null;
  roleRevisionId: string;
  onAccessError: (error: unknown) => void;
  showDiagnostics?: boolean;
}) {
  const { t } = useLingui();
  const [page, setPage] = useState<Awaited<
    ReturnType<typeof rpc.recruiting.listCandidateSources>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const scope = useRef({ active: true, busy: false, generation: 0 });
  useEffect(() => {
    scope.current.active = refreshSignal !== null;
    scope.current.busy = false;
    const generation = ++scope.current.generation;
    setLoading(refreshSignal !== null);
    setFailed(false);
    if (!refreshSignal) return;
    void rpc.recruiting
      .listCandidateSources({
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        limit: 20,
      })
      .then((value) => {
        if (scope.current.active && generation === scope.current.generation) setPage(value);
      })
      .catch((error: unknown) => {
        if (scope.current.active && generation === scope.current.generation) {
          onAccessError(error);
          setFailed(true);
        }
      })
      .finally(() => {
        if (scope.current.active && generation === scope.current.generation) setLoading(false);
      });
    return () => {
      scope.current.active = false;
    };
  }, [candidate.roleId, candidate.candidateKey, refreshSignal, onAccessError]);
  async function more() {
    if (!page?.nextCursor || !scope.current.active || scope.current.busy) return;
    const generation = scope.current.generation;
    scope.current.busy = true;
    setLoading(true);
    setFailed(false);
    try {
      const value = await rpc.recruiting.listCandidateSources({
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        limit: 20,
        cursor: page.nextCursor,
      });
      if (scope.current.active && generation === scope.current.generation)
        setPage((current) =>
          current ? { ...value, items: current.items.concat(value.items) } : value,
        );
    } catch (error) {
      if (scope.current.active && generation === scope.current.generation) {
        onAccessError(error);
        setFailed(true);
      }
    } finally {
      if (scope.current.active && generation === scope.current.generation) {
        scope.current.busy = false;
        setLoading(false);
      }
    }
  }
  return (
    <section aria-label={t`Saved candidate sources`} className="space-y-3">
      <h4 className="font-medium">
        <Trans>Saved candidate sources</Trans>
      </h4>
      {failed ? (
        <p role="alert">
          <Trans>Could not load candidate sources</Trans>
        </p>
      ) : null}
      {loading ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {page && !page.items.length ? (
        <p className="text-muted-foreground">
          <Trans>No saved discovery sources</Trans>
        </p>
      ) : null}
      {page?.items.map((source, index) => {
        const { crmImports, ...discovery } = source;
        const task = research.tasks.find((item) => item.id === source.taskId);
        const action = research.actions.find(
          (item) => item.id === source.actionId && item.taskId === source.taskId,
        );
        return (
          <div
            key={`${source.artifactRef.artifactId}:${source.rowIndex}:${source.effectId}`}
            className="space-y-2 border-s border-border ps-3"
          >
            {source.roleRevisionId !== roleRevisionId ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Saved before latest role update</Trans>
              </p>
            ) : null}
            {showDiagnostics ? (
              <p className="text-xs text-muted-foreground">
                provider_report{action ? ` · ${action.kind}` : ""} · {source.observedAt}
              </p>
            ) : (
              <details open={index === 0} className="space-y-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <Trans>Research findings</Trans>
                  {" · "}
                  <time dateTime={source.observedAt}>
                    {new Date(source.observedAt).toLocaleString(undefined, {
                      timeZone: "America/Los_Angeles",
                      timeZoneName: "short",
                    })}
                  </time>
                </summary>
                {source.report ? (
                  <CandidateReport report={source.report} />
                ) : (
                  <p className="text-muted-foreground">
                    <Trans>Source unavailable</Trans>
                  </p>
                )}
              </details>
            )}
            {showDiagnostics ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <Trans>Discovery details</Trans>
                </summary>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(discovery, null, 2)}
                </pre>
                {crmImports.map((sync) => (
                  <CrmDetails
                    key={sync.effectId}
                    sync={sync}
                    target={sync.target}
                    showDiagnostics={showDiagnostics}
                  />
                ))}
              </details>
            ) : (
              crmImports.map((sync) => (
                <CrmDetails key={sync.effectId} sync={sync} target={sync.target} />
              ))
            )}
            {showDiagnostics ? (
              <ArtifactReference
                reference={source.artifactRef}
                label={t`Source Artifact`}
                showDiagnostics
              />
            ) : null}
            {showDiagnostics && task && action ? (
              <ResearchResults
                task={task}
                action={{ ...action, outputArtifacts: [source.artifactRef] }}
                isCurrent={source.roleRevisionId === roleRevisionId}
              />
            ) : null}
          </div>
        );
      })}
      {page?.nextCursor ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loading || !refreshSignal}
          onClick={() => void more()}
        >
          <Trans>More sources</Trans>
        </Button>
      ) : null}
    </section>
  );
}

function ResearchResults({
  task,
  action,
  isCurrent,
}: {
  task: RecruitingResearchTask;
  action: RecruitingResearchAction;
  isCurrent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sourceKey = JSON.stringify([
    task.id,
    task.roleId,
    task.providerTaskId,
    action.id,
    action.taskId,
    action.roleRevisionId,
    action.outputArtifacts,
  ]);
  const source = useRef({ task, action });
  source.current = { task, action };
  const [state, setState] = useState<{
    key: string;
    results?: {
      artifact: ArtifactWithContent;
      reference: RecruitingArtifactRef;
      snapshot: RecruitingResearchReadArtifact;
    }[];
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    const { task, action } = source.current;
    let cancelled = false;
    setState(null);
    // ponytail: load only an expanded action; batch Artifact reads if saved output history grows.
    void Promise.all(
      action.outputArtifacts.map(async (reference) => {
        const artifact = await rpc.artifacts.getById({
          artifactId: reference.artifactId,
          includeDiagnostics: true,
        });
        if (artifact.id !== reference.artifactId) throw new Error("Result Artifact changed");
        const snapshot = await readRecruitingResearchReadArtifact(
          decodeArtifactBase64(artifact.contentBase64),
          { task, action, artifact: reference },
        );
        return { artifact, reference, snapshot };
      }),
    )
      .then((results) => {
        if (!cancelled)
          setState({
            key: sourceKey,
            results: results.filter(
              ({ snapshot }) =>
                snapshot.operation === "rows" && snapshot.observation.deliveryState === "accepted",
            ),
          });
      })
      .catch(() => {
        if (!cancelled) setState({ key: sourceKey, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceKey]);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="space-y-3"
      data-research-action={action.id}
    >
      <summary className="cursor-pointer">
        <Trans>Raw search results</Trans> · {action.kind} · <Trans>Role</Trans> ·{" "}
        {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
      </summary>
      {open ? (
        !state || state.key !== sourceKey ? (
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        ) : state.failed ? (
          <p role="alert">
            <Trans>Could not load search results</Trans>
          </p>
        ) : !state.results?.length ? (
          <p className="text-muted-foreground">
            <Trans>No saved result rows</Trans>
          </p>
        ) : (
          state.results.map(({ artifact, reference, snapshot: result }) => {
            const rows = result.observation.rows!;
            const records = rows.map((row) =>
              row !== null && typeof row === "object" && !Array.isArray(row)
                ? (row as Record<string, unknown>)
                : null,
            );
            const columns = [...new Set(records.flatMap((row) => (row ? Object.keys(row) : [])))];
            const target = artifact.groupId
              ? { groupId: artifact.groupId }
              : artifact.botId
                ? { botId: artifact.botId }
                : null;
            return (
              <section
                key={`${reference.artifactId}:${reference.sha256}`}
                aria-label={reference.artifactId}
                className="space-y-2 border-s border-border ps-3"
              >
                <p className="text-xs text-muted-foreground">
                  <Trans>Research findings</Trans>
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    <Trans>Details</Trans>
                  </summary>
                  <pre className="whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(
                      {
                        taskId: task.id,
                        providerTaskId: task.providerTaskId,
                        actionId: action.id,
                        roleRevisionId: action.roleRevisionId,
                        actionRunId: action.runId,
                        artifact: reference,
                        capturedByRunId: artifact.runId,
                        capturedAt: artifact.createdAt,
                        effectId: result.effectId,
                        request: result.request,
                        ...(result.observation.nextCursor === undefined
                          ? {}
                          : { nextCursor: result.observation.nextCursor }),
                        ...(result.observation.outputId === undefined
                          ? {}
                          : { outputId: result.observation.outputId }),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {rows.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <caption className="sr-only">
                        <Trans>Raw search results</Trans>
                      </caption>
                      <thead>
                        <tr>
                          {columns.length ? (
                            columns.map((column) => (
                              <th key={column} scope="col" className="py-2 pe-3 font-medium">
                                {column}
                              </th>
                            ))
                          ) : (
                            <th scope="col" className="py-2 pe-3 font-medium">
                              <Trans>Raw value</Trans>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={index} className="border-t border-border">
                            {records[index] && columns.length ? (
                              columns.map((column) => (
                                <td key={column} className="py-2 pe-3 align-top">
                                  <pre className="whitespace-pre-wrap break-words">
                                    {Object.hasOwn(records[index]!, column)
                                      ? JSON.stringify(records[index]![column], null, 2)
                                      : ""}
                                  </pre>
                                </td>
                              ))
                            ) : (
                              <td colSpan={columns.length || 1} className="py-2 pe-3 align-top">
                                <pre className="whitespace-pre-wrap break-words">
                                  {JSON.stringify(row, null, 2)}
                                </pre>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    <Trans>No saved result rows</Trans>
                  </p>
                )}
                {target ? (
                  <ArtifactFileCard
                    target={{ ...target, includeDiagnostics: true }}
                    artifactId={artifact.id}
                    name={artifact.name}
                    mimeType={artifact.mimeType}
                    size={artifact.size}
                  />
                ) : null}
              </section>
            );
          })
        )
      ) : null}
    </details>
  );
}

function CriteriaExpression({ expression }: { expression: RecruitingCriterionExpression }) {
  if (expression.kind === "atom")
    return <p className="whitespace-pre-wrap">{expression.statement}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {expression.kind === "all" ? (
          <Trans>All of</Trans>
        ) : expression.kind === "any" ? (
          <Trans>Any of</Trans>
        ) : (
          <Trans>Must not</Trans>
        )}
      </p>
      <ul className="space-y-2 border-s border-border ps-3">
        {(expression.kind === "not" ? [expression.item] : expression.items).map((item, index) => (
          <li key={index}>
            <CriteriaExpression expression={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function expressionAtoms(
  expression: RecruitingCriterionExpression,
): EditRecruitingCriteriaInput["criteria"][number]["atoms"] {
  if (expression.kind === "atom")
    return [
      expression.employmentRule
        ? { atomId: expression.id, employmentRule: expression.employmentRule }
        : { atomId: expression.id, statement: expression.statement },
    ];
  if (expression.kind === "not") return expressionAtoms(expression.item);
  return [
    ...new Map(
      expression.items.flatMap(expressionAtoms).map((atom) => [atom.atomId, atom]),
    ).values(),
  ];
}

function criteriaDraft(revision: RecruitingRoleRevision): EditRecruitingCriteriaInput["criteria"] {
  return revision.criteria.map((criterion) => ({
    criterionId: criterion.id,
    priority: criterion.priority,
    atoms: expressionAtoms(criterion.expression),
  }));
}

type CriteriaEdit = {
  roleId: string;
  revision: RecruitingRoleRevision;
  criteria: EditRecruitingCriteriaInput["criteria"];
  searchFilters: NonNullable<EditRecruitingCriteriaInput["searchFilters"]>;
};

function searchFilterDraft(revision: RecruitingRoleRevision): CriteriaEdit["searchFilters"] {
  return (revision.brief?.searchFilters ?? []).map(({ id, statement, mode }) => ({
    id,
    statement,
    mode,
  }));
}

function employmentDateValue(date: RecruitingEmploymentDay): string {
  return RecruitingEmploymentDaySchema.safeParse(date).success
    ? `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    : "";
}

function EmploymentRuleSummary({ rule }: { rule: RecruitingEmploymentRule }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <Trans>Minimum {rule.minimumMonths} complete calendar months</Trans> ·{" "}
        {rule.qualificationDefinition}
      </p>
      <p>
        <Trans>Count through</Trans> ·{" "}
        {rule.cutoff.kind === "fixed" ? (
          employmentDateValue(rule.cutoff.date)
        ) : (
          <Trans>Assessment date</Trans>
        )}
      </p>
    </div>
  );
}

function CriteriaExpressionFields({
  expression,
  atoms,
  onChange,
}: {
  expression: RecruitingCriterionExpression;
  atoms: EditRecruitingCriteriaInput["criteria"][number]["atoms"];
  onChange: (atom: EditRecruitingCriteriaInput["criteria"][number]["atoms"][number]) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  if (expression.kind === "atom") {
    const atom = atoms.find((atom) => atom.atomId === expression.id)!;
    if ("employmentRule" in atom) {
      const rule = atom.employmentRule;
      return (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">
            <Trans>Employment rule</Trans>
          </legend>
          <label htmlFor={`${fieldId}-months`} className="block space-y-1">
            <span>
              <Trans>Minimum complete calendar months</Trans>
            </span>
            <Input
              id={`${fieldId}-months`}
              type="number"
              min={0}
              step={1}
              aria-invalid={!Number.isSafeInteger(rule.minimumMonths) || rule.minimumMonths < 0}
              aria-label={t`Minimum complete calendar months`}
              value={Number.isNaN(rule.minimumMonths) ? "" : rule.minimumMonths}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: { ...rule, minimumMonths: event.target.valueAsNumber },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-qualification`} className="block space-y-1">
            <span>
              <Trans>Qualifying work</Trans>
            </span>
            <Textarea
              id={`${fieldId}-qualification`}
              aria-label={t`Qualifying work`}
              value={rule.qualificationDefinition}
              aria-invalid={!rule.qualificationDefinition.trim()}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: { ...rule, qualificationDefinition: event.target.value },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-cutoff`} className="block space-y-1">
            <span>
              <Trans>Count through</Trans>
            </span>
            <NativeSelect
              id={`${fieldId}-cutoff`}
              aria-label={t`Count through`}
              value={rule.cutoff.kind}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: {
                    ...rule,
                    cutoff:
                      event.target.value === "assessment_date"
                        ? { kind: "assessment_date" }
                        : { kind: "fixed", date: { precision: "day", year: 0, month: 0, day: 0 } },
                  },
                })
              }
            >
              <NativeSelectOption value="assessment_date">
                <Trans>Assessment date</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="fixed">
                <Trans>Fixed date</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </label>
          {rule.cutoff.kind === "fixed" ? (
            <label htmlFor={`${fieldId}-date`} className="block space-y-1">
              <span>
                <Trans>Cutoff date</Trans>
              </span>
              <Input
                id={`${fieldId}-date`}
                type="date"
                aria-label={t`Cutoff date`}
                value={employmentDateValue(rule.cutoff.date)}
                aria-invalid={!employmentDateValue(rule.cutoff.date)}
                onChange={(event) => {
                  const [year = 0, month = 0, day = 0] = event.target.value.split("-").map(Number);
                  onChange({
                    ...atom,
                    employmentRule: {
                      ...rule,
                      cutoff: { kind: "fixed", date: { precision: "day", year, month, day } },
                    },
                  });
                }}
              />
            </label>
          ) : null}
        </fieldset>
      );
    }
    const statement = atom.statement;
    return (
      <Textarea
        aria-label={t`Statement`}
        value={statement}
        aria-invalid={!statement.trim()}
        onChange={(event) => onChange({ ...atom, statement: event.target.value })}
      />
    );
  }
  return (
    <fieldset className="space-y-2 border-s border-border ps-3">
      <legend className="text-xs text-muted-foreground">
        {expression.kind === "all" ? (
          <Trans>AND</Trans>
        ) : expression.kind === "any" ? (
          <Trans>OR</Trans>
        ) : (
          <Trans>NOT</Trans>
        )}
      </legend>
      {(expression.kind === "not" ? [expression.item] : expression.items).map((item, index) => (
        <CriteriaExpressionFields key={index} expression={item} atoms={atoms} onChange={onChange} />
      ))}
    </fieldset>
  );
}

function ArtifactReference({
  reference,
  label,
  source,
  showDiagnostics = false,
  sourceRequest,
}: {
  reference: RecruitingArtifactRef;
  label: string;
  source?: RecruitingSourceRef | RecruitingAssessmentSourceRef;
  showDiagnostics?: boolean;
  sourceRequest?: ReadRecruitingSourceInput;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const sourceKey = JSON.stringify([reference, source, showDiagnostics, sourceRequest]);
  const currentSource = useRef({ reference, source, sourceRequest });
  currentSource.current = { reference, source, sourceRequest };
  const [state, setState] = useState<{
    key: string;
    artifact?: Artifact;
    excerpt?: SourceContent;
    unavailable?: boolean;
    failed?: boolean;
  } | null>(null);
  const current = state?.key === sourceKey ? state : null;
  const artifact = current?.artifact;
  useEffect(() => {
    if (!open || artifact || current?.excerpt) return;
    const { reference, source, sourceRequest } = currentSource.current;
    let cancelled = false;
    setState(null);
    if (!showDiagnostics) {
      if (!sourceRequest) {
        setState({ key: sourceKey, unavailable: true });
        return;
      }
      void rpc.recruiting.readSource(sourceRequest).then(
        (excerpt) => {
          if (!cancelled) setState({ key: sourceKey, excerpt });
        },
        () => {
          if (!cancelled) setState({ key: sourceKey, failed: true });
        },
      );
      return () => {
        cancelled = true;
      };
    }
    void rpc.artifacts
      .getById({ artifactId: reference.artifactId, includeDiagnostics: showDiagnostics })
      .then(async (value) => {
        if (value.id !== reference.artifactId) throw new Error("Source Artifact changed");
        const bytes = decodeArtifactBase64(value.contentBase64);
        if (bytes.byteLength !== value.size) throw new Error("Source Artifact size changed");
        await verifyRecruitingArtifactBytes(bytes, reference.sha256);
        let excerpt: Extract<SourceContent, { kind: "text" }> | undefined;
        let unavailable = false;
        if (source?.readState === "read" && source.quote) {
          try {
            const selection = "selection" in source ? source.selection : undefined;
            // ponytail: legacy role sources attest only native text; other strings need a typed path.
            if (
              source.anchor.kind !== "artifact" ||
              selection?.kind === "message_text" ||
              (!selection && source.anchor.locator !== "text")
            )
              throw new Error("Source text unavailable");
            const json = value.mimeType === "application/json" || value.mimeType.endsWith("+json");
            const path =
              selection?.kind === "artifact_json_string"
                ? selection.path
                : !selection && json
                  ? ["text"]
                  : undefined;
            if (path ? !json : !value.mimeType.startsWith("text/") || json)
              throw new Error("Source text unavailable");
            const text = path
              ? readRecruitingJsonString(bytes, path)
              : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const start = selection?.start ?? text.indexOf(source.quote);
            const end = selection?.end ?? start + source.quote.length;
            validateRecruitingTextSelection(text, start, end, source.quote);
            excerpt = { kind: "text", text, start, end };
          } catch {
            unavailable = true;
          }
        }
        if (!cancelled) setState({ key: sourceKey, artifact: value, excerpt, unavailable });
      })
      .catch(() => {
        if (!cancelled) setState({ key: sourceKey, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, artifact, sourceKey, current?.excerpt, showDiagnostics]);
  const target = artifact?.groupId
    ? { groupId: artifact.groupId }
    : artifact?.botId
      ? { botId: artifact.botId }
      : null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="py-1">
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      {open ? (
        <div className="mt-2 space-y-1">
          {!showDiagnostics ? (
            !current ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : current.failed ? (
              <p role="alert">
                <Trans>Source unavailable</Trans>
              </p>
            ) : null
          ) : artifact && target ? (
            <ArtifactFileCard
              target={{ ...target, includeDiagnostics: true }}
              artifactId={reference.artifactId}
              name={artifact.name}
              mimeType={artifact.mimeType}
              size={artifact.size}
            />
          ) : current?.failed || artifact ? (
            <p role="alert">
              <Trans>Source unavailable</Trans>
            </p>
          ) : (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          )}
          {current?.excerpt?.kind === "report" ? (
            <CandidateReport report={current.excerpt.report} />
          ) : current?.excerpt?.kind === "text" ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                <Trans>Source text</Trans>
              </p>
              <pre
                role="document"
                aria-label={t`Source text`}
                className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed"
              >
                {current.excerpt.text.slice(0, current.excerpt.start)}
                <mark className="bg-accent text-accent-foreground">
                  {current.excerpt.text.slice(current.excerpt.start, current.excerpt.end)}
                </mark>
                {current.excerpt.text.slice(current.excerpt.end)}
              </pre>
            </div>
          ) : current?.unavailable ? (
            <p role="alert">
              <Trans>Source unavailable</Trans>
            </p>
          ) : null}
          {showDiagnostics ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <Trans>Details</Trans>
              </summary>
              <p className="break-all">{reference.artifactId}</p>
              <p className="break-all">SHA-256 {reference.sha256}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function Sources({
  sources,
  messageTargets,
  onRevealMessage,
  showDiagnostics = false,
  sourceTarget,
}: {
  sources: readonly (RecruitingSourceRef | RecruitingAssessmentSourceRef)[];
  messageTargets?: Snapshot["assessments"][number]["sourceMessageTargets"];
  onRevealMessage?: Props["onRevealMessage"];
  showDiagnostics?: boolean;
  sourceTarget?: SourceReadTarget;
}) {
  const { t } = useLingui();
  const byMessageId = new Map(messageTargets?.map((target) => [target.messageId, target]));
  return (
    <ul className="space-y-2 text-sm">
      {sources.map((source) => {
        const message =
          source.anchor.kind === "message" ? byMessageId.get(source.anchor.messageId) : undefined;
        return (
          <li key={source.id} className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {showDiagnostics ? (
                <>
                  {source.kind} · {source.readState}
                </>
              ) : (
                <>
                  {source.kind === "provider_report" ? (
                    <Trans>Research findings</Trans>
                  ) : source.kind === "original_material" ? (
                    <Trans>Original source</Trans>
                  ) : source.kind === "candidate_statement" ? (
                    <Trans>Candidate statement</Trans>
                  ) : (
                    <Trans>Recruiter verified</Trans>
                  )}
                  {" · "}
                  {source.readState === "read" ? (
                    <Trans>Reviewed</Trans>
                  ) : source.readState === "unread" ? (
                    <Trans>Not reviewed</Trans>
                  ) : (
                    <Trans>Unavailable</Trans>
                  )}
                </>
              )}
            </p>
            {source.anchor.kind === "message" ? (
              <div>
                {onRevealMessage && message ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto justify-start whitespace-normal p-0 text-left"
                    onClick={() =>
                      onRevealMessage({ ...message.target, messageId: message.messageId })
                    }
                  >
                    <Trans>Message</Trans>
                  </Button>
                ) : (
                  <p>
                    <Trans>Message</Trans>
                  </p>
                )}
              </div>
            ) : (
              <ArtifactReference
                reference={source.anchor.artifact}
                key={`${source.anchor.artifact.artifactId}:${source.anchor.artifact.sha256}`}
                label={showDiagnostics ? source.anchor.locator : t`Source`}
                source={source}
                showDiagnostics={showDiagnostics}
                sourceRequest={
                  sourceTarget ? { ...sourceTarget, sourceRefId: source.id } : undefined
                }
              />
            )}
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="block break-all underline underline-offset-4"
              >
                {showDiagnostics ? source.url : new URL(source.url).hostname}
              </a>
            ) : null}
            {source.quote && (showDiagnostics || source.anchor.kind === "message") ? (
              <blockquote className="border-s-2 border-border ps-3 whitespace-pre-wrap">
                {source.quote}
              </blockquote>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function MemoryDocumentView({
  document,
  showDiagnostics = false,
}: {
  document: MemoryDocument;
  showDiagnostics?: boolean;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<MemoryRevision[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!showHistory || history) return;
    let cancelled = false;
    setFailed(false);
    void rpc.memory
      .history({ documentId: document.id })
      .then((value) => {
        if (!cancelled) setHistory(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showHistory, history, document.id]);
  return (
    <details className="border-b border-border py-3">
      <summary className="cursor-pointer break-words">
        {document.path}
        <span className="ms-2 text-xs text-muted-foreground">
          {document.scope} · <Trans>Revision {document.revision}</Trans>
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {showDiagnostics && document.botId ? (
          <p className="text-xs text-muted-foreground">{document.botId}</p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{document.content}</p>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          <Trans>History</Trans>
        </Button>
        {showHistory ? (
          <div className="space-y-3 border-s border-border ps-3">
            {failed ? (
              <p role="alert">
                <Trans>Could not load history</Trans>
              </p>
            ) : !history ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : history.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No saved history</Trans>
              </p>
            ) : (
              history.map((entry) => (
                <div key={entry.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    <Trans>Revision {entry.revision}</Trans> · {entry.createdAt}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                  {showDiagnostics && entry.sourceThreadId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      <Trans>Thread</Trans> · {entry.sourceThreadId}
                    </p>
                  ) : null}
                  {showDiagnostics && entry.sourceRunId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      <Trans>Run</Trans> · {entry.sourceRunId}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function VerdictLabel({ verdict }: { verdict: Verdict }) {
  const Icon = verdict === "met" ? Check : verdict === "unmet" ? X : CircleHelp;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${verdict === "unmet" ? "text-destructive" : "text-muted-foreground"}`}
    >
      <Icon size={14} aria-hidden />
      {verdict === "met" ? (
        <Trans>Met</Trans>
      ) : verdict === "unmet" ? (
        <Trans>Unmet</Trans>
      ) : (
        <Trans>Unknown</Trans>
      )}
    </span>
  );
}

// Reset all fetched records when navigation changes the source thread, even before its reads finish.
export function RecruitingPanel(props: Props) {
  const userId = authClient.useSession().data?.user.id;
  return (
    <RecruitingWorkspace
      key={`${userId}:${props.threadId}:${props.botId ?? "group"}`}
      {...props}
      userId={userId}
    />
  );
}

function RecruitingWorkspace({
  userId,
  threadId,
  botId,
  refreshSignal,
  onClose,
  onRevealMessage,
  onDiscussCandidate,
  onCandidateFeedback,
  candidateFeedbackRecipients,
  showDiagnostics = false,
  tab,
  onTabChange,
}: Props & { userId?: string }) {
  const { t } = useLingui();
  const shortlistFilterId = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Pick<Snapshot, "workspace"> | null>(
    null,
  );
  const [refresh, setRefresh] = useState(0);
  const [feedbackRefresh, setFeedbackRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmationFailed, setConfirmationFailed] = useState(false);
  const [candidateList, setCandidateList] = useState(() => readRecruitingPanelState(null));
  const activeTab = tab ?? candidateList.tab;
  const requestedTab = useRef(tab);
  requestedTab.current = tab;
  useEffect(() => {
    if (tab) setCandidateList((current) => (current.tab === tab ? current : { ...current, tab }));
  }, [tab]);
  useEffect(() => {
    if (workspaceSnapshot) onTabChange?.(activeTab);
  }, [activeTab, workspaceSnapshot, onTabChange]);
  const [candidateStorageKey, setCandidateStorageKey] = useState<string | null>(null);
  const tabsList = useRef<HTMLDivElement>(null);
  const {
    candidateView,
    filters: candidateFilters,
    detailOpen: candidateDetailOpen,
  } = candidateList;
  const [selection, setSelection] = useState<RecruitingCandidate | null>(null);
  const candidateTrigger = useRef<HTMLButtonElement>(null);
  const candidateClose = useRef<HTMLButtonElement>(null);
  const candidateHandoff = useRef<(() => void) | null>(null);
  const [candidatePage, setCandidatePage] = useState<ListRecruitingCandidatesOutput | null>(null);
  function setCandidateFilters(
    update: (current: RecruitingPanelState["filters"]) => RecruitingPanelState["filters"],
  ) {
    candidateGeneration.current++;
    setCandidatePage(null);
    setCandidateList((current) => ({ ...current, filters: update(current.filters), pageCount: 1 }));
  }
  function setCandidateDetailOpen(detailOpen: boolean) {
    setCandidateList((current) => ({ ...current, detailOpen }));
  }
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateFailed, setCandidateFailed] = useState(false);
  const [shortlistPending, setShortlistPending] = useState<string | null>(null);
  const [shortlistFailed, setShortlistFailed] = useState<string | null>(null);
  const shortlistMutation = useRef<object | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<{
    key: string;
    value: Awaited<ReturnType<typeof rpc.recruiting.getAssessment>>;
  } | null>(null);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const candidateGeneration = useRef(0);
  const loadingMore = useRef(false);
  const readEpoch = useRef(0);
  const denyAccess = useCallback((error: unknown) => {
    console.error(
      "Recruiting request failed",
      JSON.stringify({
        name: error instanceof Error ? error.name : undefined,
        code: error instanceof ORPCError ? error.code : undefined,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    if (
      !(error instanceof ORPCError) ||
      !["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
    )
      return;
    readEpoch.current++;
    candidateGeneration.current++;
    setSnapshot(null);
    setWorkspaceSnapshot(null);
    setCandidatePage(null);
    setSelection(null);
    setCandidateList((current) => ({ ...current, selectedCandidateKey: null, detailOpen: false }));
    candidateHandoff.current = null;
    setSelectedEvidence(null);
    setCriteriaEdit(null);
    shortlistMutation.current = null;
    setShortlistPending(null);
    setFailed(true);
    editScope.current.roleId = null;
    editScope.current.generation++;
  }, []);
  const [criteriaEdit, setCriteriaEdit] = useState<CriteriaEdit | null>(null);
  const [savingCriteria, setSavingCriteria] = useState(false);
  const [criteriaFailed, setCriteriaFailed] = useState(false);
  const editScope = useRef({ active: true, roleId: null as string | null, generation: 0 });
  useEffect(() => {
    editScope.current.active = true;
    return () => {
      editScope.current.active = false;
      editScope.current.generation++;
      candidateHandoff.current = null;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const epoch = readEpoch.current;
    setLoading(true);
    setFailed(false);
    const updateEditScope = (workspace: Snapshot["workspace"]) => {
      const roleId = workspace?.role.id ?? null;
      if (editScope.current.roleId === roleId) return;
      const changingRole = editScope.current.roleId !== null;
      editScope.current.roleId = roleId;
      editScope.current.generation++;
      candidateGeneration.current++;
      setCriteriaEdit(null);
      setSavingCriteria(false);
      setCriteriaFailed(false);
      const key =
        userId && workspace
          ? `${rightPanelStorageKey(userId, workspace.role.spaceId, botId ? "bot" : "group", threadId)}:recruiting:${roleId}`
          : null;
      setCandidateStorageKey(key);
      const saved = readRecruitingPanelState(key);
      setCandidateList((current) => ({
        ...saved,
        tab: requestedTab.current ?? (changingRole ? current.tab : saved.tab),
      }));
      setCandidatePage(null);
      setSelection(null);
      candidateHandoff.current = null;
      setSelectedEvidence(null);
      shortlistMutation.current = null;
      setShortlistPending(null);
      setShortlistFailed(null);
    };
    const onReadError = (error: unknown): never => {
      if (!cancelled && epoch === readEpoch.current) denyAccess(error);
      throw error;
    };
    async function load() {
      try {
        let workspace = await rpc.recruiting.getWorkspace({ threadId }).catch(onReadError);
        while (!cancelled && epoch === readEpoch.current) {
          updateEditScope(workspace);
          setSnapshot((current) =>
            current?.workspace?.role.id !== workspace?.role.id ||
            current?.workspace?.revision.id !== workspace?.revision.id
              ? null
              : current,
          );
          setWorkspaceSnapshot({ workspace });
          const [assessments, research, questions, documents] = await Promise.all([
            workspace
              ? rpc.recruiting.listAssessments({ roleId: workspace.role.id }).catch(onReadError)
              : Promise.resolve([]),
            workspace
              ? rpc.recruiting.listResearch({ roleId: workspace.role.id }).catch(onReadError)
              : Promise.resolve({ tasks: [], actions: [], observations: [] }),
            workspace
              ? rpc.recruiting
                  .listQuestions({ threadId, roleId: workspace.role.id })
                  .catch(onReadError)
              : Promise.resolve({ questions: [] }),
            Promise.all([
              rpc.memory.list({ scope: "user" }).catch(onReadError),
              ...(botId ? [rpc.memory.list({ scope: "bot", botId }).catch(onReadError)] : []),
            ]).then((lists) => lists.flat()),
          ]);
          if (cancelled || epoch !== readEpoch.current) return;
          const verified = await rpc.recruiting.getWorkspace({ threadId }).catch(onReadError);
          if (cancelled || epoch !== readEpoch.current) return;
          if (
            workspace?.role.id !== verified?.role.id ||
            workspace?.revision.id !== verified?.revision.id
          ) {
            workspace = verified;
            continue;
          }
          setSnapshot({
            workspace,
            assessments,
            research,
            questions: questions.questions,
            documents,
          });
          return;
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, threadId, botId, refresh, refreshSignal, denyAccess]);
  const workspace = workspaceSnapshot?.workspace;
  const criteria = workspace?.revision.criteria ?? [];
  const brief = workspace?.revision.brief;
  const briefClarifications = brief ? recruitingBriefClarifications(brief) : [];
  const briefFieldLabels: Record<string, string> = {
    salary_range: t`Salary range`,
    location: t`Location`,
    company_deck: t`Company deck`,
  };
  const unphrasedBriefFields = (brief?.fields ?? []).filter(
    (field) =>
      briefClarifications.some(({ fieldKey }) => fieldKey === field.key) &&
      !Object.hasOwn(briefFieldLabels, field.key) &&
      !brief?.questions.some(
        (question) => question.fieldKey === field.key && !question.answeredBySourceRefId,
      ),
  );
  const roleQuestions = [
    ...new Set([
      ...briefClarifications.flatMap(({ fieldKey, question }) => {
        const saved = brief?.questions.find(
          (item) => item.fieldKey === fieldKey && !item.answeredBySourceRefId,
        );
        if (saved) return [saved.question];
        if (fieldKey === "salary_range") return [t`What salary range may be stated in outreach?`];
        if (fieldKey === "location") return [t`What location or remote work scope applies?`];
        if (fieldKey === "company_deck") return [t`Is a company deck available?`];
        // ponytail: arbitrary keys have no display label; only saved prose identifies the question.
        return showDiagnostics ? [question] : [];
      }),
      ...(workspace?.revision.definitionQuestions ?? []),
      ...criteria.flatMap((criterion) => criterion.definitionQuestions),
    ]),
  ];
  const roleSources = [
    ...new Map(
      [
        ...(workspace?.revision.sourceRefs ?? []),
        ...criteria.flatMap((criterion) => criterion.sourceRefs),
      ].map((source) => [source.id, source]),
    ).values(),
  ];
  const assessments = snapshot?.assessments ?? [];
  const showInternalAssessments = showDiagnostics || assessments.length > 0;
  const retainInternalAssessmentFilters = showInternalAssessments || !snapshot;
  const candidateRequestFilters = useMemo(() => {
    if (
      retainInternalAssessmentFilters ||
      (candidateFilters.assessmentState === undefined && candidateFilters.verdict === undefined)
    )
      return candidateFilters;
    const { assessmentState: _, verdict: __, ...filters } = candidateFilters;
    return filters;
  }, [candidateFilters, retainInternalAssessmentFilters]);
  const selectedKey =
    selection && selection.roleId === workspace?.role.id
      ? JSON.stringify([
          selection.roleId,
          selection.candidateKey,
          selection.latestAssessment?.version,
        ])
      : null;
  const selected = selectedEvidence?.key === selectedKey ? selectedEvidence.value : null;
  const assessment = selected?.assessment;
  const roleId = workspace?.role.id;
  const roleRevisionId = workspace?.revision.id;
  useEffect(() => {
    const list = tabsList.current;
    const selectedTab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !selectedTab) return;
    const listBounds = list.getBoundingClientRect();
    const tabBounds = selectedTab.getBoundingClientRect();
    const left =
      tabBounds.left < listBounds.left
        ? tabBounds.left - listBounds.left
        : Math.max(0, tabBounds.right - listBounds.right);
    if (left) list.scrollBy({ left });
  }, [activeTab, roleId]);
  useEffect(() => {
    if (candidateStorageKey) writeRecruitingPanelState(candidateStorageKey, candidateList);
  }, [candidateStorageKey, candidateList]);
  const showCrm = Boolean(
    candidatePage?.crmTarget || candidatePage?.items.some((item) => item.crm),
  );
  const selectedPageCandidate = candidatePage?.items.find(
    (item) => item.candidateKey === selection?.candidateKey,
  );
  const selectedCrm = selectedPageCandidate?.crm ?? null;
  const selectedCrmTarget = selectedPageCandidate
    ? (selectedCrm?.target ?? candidatePage?.crmTarget?.target)
    : undefined;
  const candidateQuery = useRef({ ...candidateList, roleRevisionId, selection });
  candidateQuery.current = {
    ...candidateList,
    filters: candidateRequestFilters,
    roleRevisionId,
    selection,
  };
  const resetUnavailableCandidateSort = useCallback(
    (page: ListRecruitingCandidatesOutput, filters: RecruitingPanelState["filters"]) => {
      const sort = filters.sort ?? "rank";
      if (
        (sort === "rank" || sort === "tier" || sort === "score") &&
        !page.sortAvailability[sort]
      ) {
        setCandidatePage(null);
        setCandidateList((current) => ({
          ...current,
          filters: { ...current.filters, sort: "name" },
          pageCount: 1,
        }));
        return true;
      }
      return false;
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const generation = ++candidateGeneration.current;
    const epoch = readEpoch.current;
    const isCurrent = () =>
      !cancelled && generation === candidateGeneration.current && epoch === readEpoch.current;
    loadingMore.current = false;
    setCandidateLoading(!!roleId);
    setCandidateFailed(false);
    setCandidatePage(null);
    if (!roleId) return;
    const query = candidateQuery.current;
    void (async () => {
      let page = await rpc.recruiting.listCandidates({
        roleId,
        limit: 30,
        ...candidateRequestFilters,
      });
      if (!isCurrent()) return;
      if (page.roleId !== roleId || page.roleRevisionId !== roleRevisionId) {
        setRefresh((value) => value + 1);
        return;
      }
      if (resetUnavailableCandidateSort(page, candidateRequestFilters)) return;
      const verified = await rpc.recruiting.getWorkspace({ threadId });
      if (!isCurrent()) return;
      if (verified?.role.id !== roleId || verified?.revision.id !== roleRevisionId) {
        setRefresh((value) => value + 1);
        return;
      }
      setCandidatePage(page);
      setCandidateList((current) => ({ ...current, pageCount: 1 }));
      let pageCount = 1;
      // ponytail: replay only the saved page depth with fresh cursors; never cache candidate records.
      for (let index = 1; index < query.pageCount && page.nextCursor; index++) {
        if (!isCurrent()) return;
        const next = await rpc.recruiting.listCandidates({
          roleId,
          limit: 30,
          ...candidateRequestFilters,
          cursor: page.nextCursor,
        });
        if (!isCurrent()) return;
        if (
          next.roleId !== roleId ||
          next.roleRevisionId !== roleRevisionId ||
          next.crmTarget?.bindingEffectId !== page.crmTarget?.bindingEffectId
        ) {
          setCandidatePage(null);
          setRefresh((value) => value + 1);
          return;
        }
        if (resetUnavailableCandidateSort(next, candidateRequestFilters)) return;
        page = { ...next, items: page.items.concat(next.items) };
        pageCount++;
        setCandidatePage(page);
        setCandidateList((current) => ({ ...current, pageCount }));
      }
      const selectedCandidateKey = candidateQuery.current.selectedCandidateKey;
      const { sourceEffectId, actionId } = candidateRequestFilters;
      const explicitSource = sourceEffectId !== undefined || actionId !== undefined;
      let restored = page.items.find((item) => item.candidateKey === selectedCandidateKey);
      if (
        !restored &&
        selectedCandidateKey &&
        (!candidateQuery.current.selection || explicitSource)
      ) {
        let cursor: string | undefined;
        do {
          const selectedPage = await rpc.recruiting.listCandidates({
            roleId,
            limit: 30,
            query: selectedCandidateKey,
            ...(sourceEffectId !== undefined ? { sourceEffectId } : {}),
            ...(actionId !== undefined ? { actionId } : {}),
            ...(cursor ? { cursor } : {}),
          });
          if (!isCurrent()) return;
          if (selectedPage.roleId !== roleId || selectedPage.roleRevisionId !== roleRevisionId) {
            setRefresh((value) => value + 1);
            return;
          }
          restored = selectedPage.items.find((item) => item.candidateKey === selectedCandidateKey);
          cursor = selectedPage.nextCursor ?? undefined;
        } while (!restored && cursor);
      }
      setSelection((current) =>
        current?.roleId === roleId
          ? (page.items.find((item) => item.candidateKey === current.candidateKey) ??
            (current.candidateKey === selectedCandidateKey
              ? (restored ?? (explicitSource ? null : current))
              : current))
          : (restored ?? null),
      );
    })()
      .catch((error: unknown) => {
        if (cancelled || generation !== candidateGeneration.current || epoch !== readEpoch.current)
          return;
        denyAccess(error);
        if (generation === candidateGeneration.current && epoch === readEpoch.current)
          setCandidateFailed(true);
      })
      .finally(() => {
        if (!cancelled && generation === candidateGeneration.current && epoch === readEpoch.current)
          setCandidateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    roleId,
    roleRevisionId,
    candidateRequestFilters,
    feedbackRefresh,
    workspaceSnapshot,
    threadId,
    denyAccess,
    resetUnavailableCandidateSort,
  ]);
  useEffect(() => {
    let cancelled = false;
    const epoch = readEpoch.current;
    setSelectedEvidence(null);
    setEvidenceFailed(false);
    if (!selection || !selectedKey || !selection.latestAssessment) return;
    void rpc.recruiting
      .getAssessment({
        roleId: selection.roleId,
        candidateKey: selection.candidateKey,
        version: selection.latestAssessment.version,
      })
      .then((value) => {
        if (!cancelled && epoch === readEpoch.current)
          setSelectedEvidence({ key: selectedKey, value });
      })
      .catch((error: unknown) => {
        if (!cancelled && epoch === readEpoch.current) {
          denyAccess(error);
          setEvidenceFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, snapshot, denyAccess]);
  function selectCandidate(candidate: RecruitingCandidate, trigger: HTMLButtonElement) {
    candidateHandoff.current = null;
    candidateTrigger.current = trigger;
    setSelection(candidate);
    setCandidateList((current) => ({
      ...current,
      selectedCandidateKey: candidate.candidateKey,
      detailOpen: true,
    }));
  }
  const revealCandidateMessage: Props["onRevealMessage"] = onRevealMessage
    ? (target) => {
        candidateHandoff.current = () => onRevealMessage(target);
        setCandidateDetailOpen(false);
      }
    : undefined;
  async function loadMoreCandidates() {
    if (!candidatePage?.nextCursor || !roleId || loadingMore.current) return;
    const generation = candidateGeneration.current;
    const epoch = readEpoch.current;
    loadingMore.current = true;
    setCandidateLoading(true);
    setCandidateFailed(false);
    try {
      const page = await rpc.recruiting.listCandidates({
        roleId,
        limit: 30,
        ...candidateRequestFilters,
        cursor: candidatePage.nextCursor,
      });
      if (generation !== candidateGeneration.current || epoch !== readEpoch.current) return;
      if (
        page.roleId !== roleId ||
        page.roleRevisionId !== roleRevisionId ||
        page.crmTarget?.bindingEffectId !== candidatePage.crmTarget?.bindingEffectId
      ) {
        setCandidatePage(null);
        setRefresh((value) => value + 1);
        return;
      }
      if (resetUnavailableCandidateSort(page, candidateRequestFilters)) return;
      setCandidatePage((current) =>
        current ? { ...page, items: current.items.concat(page.items) } : page,
      );
      setCandidateList((current) => ({ ...current, pageCount: current.pageCount + 1 }));
    } catch (error) {
      if (generation === candidateGeneration.current && epoch === readEpoch.current) {
        denyAccess(error);
        setCandidateFailed(true);
      }
    } finally {
      if (generation === candidateGeneration.current && epoch === readEpoch.current) {
        loadingMore.current = false;
        setCandidateLoading(false);
      }
    }
  }
  async function setShortlist(candidate: RecruitingCandidate, shortlisted: boolean) {
    if (shortlistMutation.current) return;
    const mutation = {};
    shortlistMutation.current = mutation;
    const roleGeneration = editScope.current.generation;
    const epoch = readEpoch.current;
    const isCurrent = () =>
      shortlistMutation.current === mutation &&
      editScope.current.active &&
      editScope.current.generation === roleGeneration &&
      editScope.current.roleId === candidate.roleId &&
      epoch === readEpoch.current;
    setShortlistPending(candidate.candidateKey);
    setShortlistFailed(null);
    try {
      const saved = await rpc.recruiting.setCandidateShortlist({
        threadId,
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        expectedRevision: candidate.revision,
        shortlisted,
      });
      if (!isCurrent()) return;
      if (
        saved.roleId !== candidate.roleId ||
        saved.candidateKey !== candidate.candidateKey ||
        saved.shortlisted !== shortlisted
      )
        throw new Error("Shortlist receipt does not match the submitted candidate");
      setCandidatePage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.candidateKey === saved.candidateKey ? { ...item, ...saved } : item,
              ),
            }
          : current,
      );
      setSelection((current) =>
        current?.candidateKey === saved.candidateKey ? { ...current, ...saved } : current,
      );
      // Counts and active filters are authoritative after the saved human change.
      const generation = ++candidateGeneration.current;
      const query = candidateQuery.current;
      loadingMore.current = false;
      setCandidateLoading(true);
      try {
        const page = await rpc.recruiting.listCandidates({
          roleId: candidate.roleId,
          limit: 30,
          ...query.filters,
        });
        if (isCurrent() && generation === candidateGeneration.current) {
          if (page.roleId !== candidate.roleId || page.roleRevisionId !== query.roleRevisionId)
            setRefresh((value) => value + 1);
          else if (!resetUnavailableCandidateSort(page, query.filters)) {
            setCandidatePage(page);
            setCandidateList((current) => ({ ...current, pageCount: 1 }));
            setCandidateFailed(false);
          }
        }
      } catch (error) {
        if (isCurrent()) {
          denyAccess(error);
          if (epoch === readEpoch.current && generation === candidateGeneration.current)
            setCandidateFailed(true);
        }
      } finally {
        if (isCurrent() && generation === candidateGeneration.current) setCandidateLoading(false);
      }
    } catch (error) {
      if (isCurrent()) {
        denyAccess(error);
        setShortlistFailed(candidate.candidateKey);
      }
    } finally {
      if (isCurrent()) {
        shortlistMutation.current = null;
        setShortlistPending(null);
      }
    }
  }
  const normalizedCriteria =
    criteriaEdit?.criteria.map((criterion) => ({
      ...criterion,
      atoms: criterion.atoms.map((atom) =>
        "employmentRule" in atom
          ? {
              ...atom,
              employmentRule: {
                ...atom.employmentRule,
                qualificationDefinition: atom.employmentRule.qualificationDefinition.trim(),
              },
            }
          : { ...atom, statement: atom.statement.trim() },
      ),
    })) ?? [];
  const originalCriteria = criteriaEdit ? criteriaDraft(criteriaEdit.revision) : [];
  const criteriaChanges = normalizedCriteria.filter(
    (criterion, index) =>
      JSON.stringify(criteriaEdit?.criteria[index]) !== JSON.stringify(originalCriteria[index]) &&
      JSON.stringify(criterion) !== JSON.stringify(originalCriteria[index]),
  );
  const searchFiltersChanged = Boolean(
    criteriaEdit &&
      JSON.stringify(criteriaEdit.searchFilters) !==
        JSON.stringify(searchFilterDraft(criteriaEdit.revision)),
  );
  const invalidSearchFilters =
    criteriaEdit?.searchFilters.some((filter) => !filter.statement.trim()) ?? false;
  const invalidCriteria = normalizedCriteria.some((criterion) =>
    criterion.atoms.some((atom) =>
      "employmentRule" in atom
        ? !RecruitingEmploymentRuleSchema.safeParse(atom.employmentRule).success
        : !atom.statement,
    ),
  );
  async function saveCriteria() {
    if (
      !criteriaEdit ||
      savingCriteria ||
      invalidCriteria ||
      invalidSearchFilters ||
      (!criteriaChanges.length && !searchFiltersChanged)
    )
      return;
    const submitted = criteriaEdit;
    const generation = editScope.current.generation;
    const isCurrent = () =>
      editScope.current.active &&
      editScope.current.generation === generation &&
      editScope.current.roleId === submitted.roleId;
    setSavingCriteria(true);
    setCriteriaFailed(false);
    try {
      const saved = await rpc.recruiting.editCriteria({
        threadId,
        roleId: submitted.roleId,
        expectedRevision: submitted.revision.revision,
        criteria: criteriaChanges.length ? criteriaChanges : originalCriteria,
        ...(searchFiltersChanged ? { searchFilters: submitted.searchFilters } : {}),
      });
      if (!isCurrent()) return;
      setCriteriaEdit((current) =>
        current === submitted ? null : current ? { ...current, revision: saved.revision } : null,
      );
      setRefresh((value) => value + 1);
    } catch {
      if (isCurrent()) setCriteriaFailed(true);
    } finally {
      if (isCurrent()) setSavingCriteria(false);
    }
  }
  return (
    <section aria-label={t`Recruiting`} className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium">
          <Trans>Recruiting</Trans>
        </h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Refresh`}
            disabled={candidateLoading || (loading && !workspaceSnapshot)}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
            <X size={16} aria-hidden />
          </Button>
        </div>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not load recruiting</Trans>
        </p>
      ) : null}
      {loading &&
      (!workspaceSnapshot || ["dashboard", "missing", "memory", "activity"].includes(activeTab)) ? (
        <div role="status" className="text-muted-foreground">
          <Shimmer>
            <Trans>Loading…</Trans>
          </Shimmer>
        </div>
      ) : null}
      {workspaceSnapshot ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = value as RecruitingPanelState["tab"];
            setCandidateList((current) => ({ ...current, tab }));
            onTabChange?.(tab);
          }}
          className="gap-4"
        >
          <TabsList
            ref={tabsList}
            variant="line"
            aria-label={t`Recruiting views`}
            className="no-scrollbar w-full overflow-x-auto justify-start"
          >
            <TabsTrigger value="role">
              <Trans>Role</Trans>
            </TabsTrigger>
            <TabsTrigger value="dashboard">
              <Trans>Dashboard</Trans>
            </TabsTrigger>
            <TabsTrigger value="evidence">
              <Trans>Evidence</Trans>
            </TabsTrigger>
            <TabsTrigger value="missing">
              <Trans>Missing info</Trans>
            </TabsTrigger>
            <TabsTrigger value="memory">
              <Trans>Memory</Trans>
            </TabsTrigger>
            <TabsTrigger value="activity">
              <Trans>Activity</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard" className="space-y-4">
            {workspace ? <h3 className="font-medium">{workspace.role.title}</h3> : null}
            {candidateFailed ? (
              <p role="alert">
                <Trans>Could not load candidates</Trans>
              </p>
            ) : candidatePage ? (
              <CandidateCounts counts={candidatePage.counts} />
            ) : candidateLoading ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : null}
            <h3 className="font-medium">
              <Trans>Research history</Trans>
            </h3>
            {snapshot &&
            !snapshot.research.tasks.length &&
            !snapshot.research.observations.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved research</Trans>
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-2 border-s border-border ps-3">
                  <p>
                    {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>} · {task.state}
                  </p>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-1">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <p className="break-all text-xs">
                              {action.id} · {action.roleRevisionId}
                            </p>
                            {action.receiptArtifact ? (
                              <ArtifactReference
                                reference={action.receiptArtifact}
                                label={t`Receipt`}
                                showDiagnostics
                              />
                            ) : null}
                          </details>
                        ) : null}
                      </div>
                    ))}
                </div>
              ))
            )}
            {snapshot?.research.observations.length ? (
              <ul aria-label={t`Saved research results`} className="space-y-3">
                {snapshot?.research.observations.map((observation) => (
                  <li key={observation.effectId} className="space-y-1 border-s border-border ps-3">
                    <p>
                      {observation.rowCount === null ? (
                        <Trans>Saved results</Trans>
                      ) : (
                        <Trans>{observation.rowCount} saved source rows</Trans>
                      )}
                      {" · "}
                      <time dateTime={observation.observedAt}>
                        {new Date(observation.observedAt).toLocaleString(undefined, {
                          timeZone: "America/Los_Angeles",
                          timeZoneName: "short",
                        })}
                      </time>
                    </p>
                    {showDiagnostics ? (
                      <ArtifactReference
                        reference={observation.artifactRef}
                        label={t`Source Artifact`}
                        showDiagnostics
                      />
                    ) : null}
                    {showDiagnostics ? (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">
                          <Trans>Details</Trans>
                        </summary>
                        <dl className="break-all text-xs">
                          <dt>
                            <Trans>Provider task</Trans>
                          </dt>
                          <dd>{observation.providerTaskId}</dd>
                          <dt>
                            <Trans>Run</Trans>
                          </dt>
                          <dd>{observation.runId}</dd>
                          <dt>
                            <Trans>Role revision</Trans>
                          </dt>
                          <dd>{observation.roleRevisionId}</dd>
                        </dl>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </TabsContent>
          <TabsContent key={workspace?.role.id} value="role" className="space-y-5">
            {workspace ? (
              <>
                {candidatePage ? <CandidateCounts counts={candidatePage.counts} /> : null}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium" dir="auto">
                      {workspace.role.title}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Version {workspace.revision.revision}</Trans>
                    </p>
                  </div>
                  {!criteriaEdit && criteria.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setCriteriaFailed(false);
                        setCriteriaEdit({
                          roleId: workspace.role.id,
                          revision: workspace.revision,
                          criteria: criteriaDraft(workspace.revision),
                          searchFilters: searchFilterDraft(workspace.revision),
                        });
                      }}
                    >
                      <Trans>Edit criteria</Trans>
                    </Button>
                  ) : null}
                </div>
                {workspace.revision.brief ? (
                  <div className="space-y-2">
                    <ul className="space-y-3 text-base leading-relaxed">
                      {workspace.revision.brief.fields
                        .filter((field) => field.value !== null)
                        .map((field) => (
                          <li key={field.key} className="space-y-1">
                            {Object.hasOwn(briefFieldLabels, field.key) ? (
                              <p className="text-xs text-muted-foreground">
                                {briefFieldLabels[field.key]}
                              </p>
                            ) : null}
                            <p className="whitespace-pre-wrap">{field.value}</p>
                            {field.state !== "known" ? (
                              <p className="text-xs text-muted-foreground">
                                {field.state === "conflict" ? (
                                  <Trans>Conflicting information</Trans>
                                ) : (
                                  <Trans>Unknown</Trans>
                                )}
                              </p>
                            ) : null}
                            {field.origin === "inferred" ? (
                              <p className="text-xs text-muted-foreground">
                                <Trans>Assumption</Trans>
                              </p>
                            ) : null}
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                <Trans>Sources</Trans>
                              </summary>
                              <div className="mt-2 space-y-2 text-sm">
                                {showDiagnostics ? <p>{field.key}</p> : null}
                                <p>
                                  {field.origin === "user_instruction" ? (
                                    <Trans>User instruction</Trans>
                                  ) : field.origin === "jd" ? (
                                    <Trans>JD</Trans>
                                  ) : field.origin === "hm" ? (
                                    <Trans>Hiring manager</Trans>
                                  ) : (
                                    <Trans>Assumption</Trans>
                                  )}
                                </p>
                                <Sources
                                  sourceTarget={{
                                    kind: "role",
                                    threadId,
                                    roleRevisionId: workspace.revision.id,
                                  }}
                                  showDiagnostics={showDiagnostics}
                                  sources={roleSources.filter((source) =>
                                    field.sourceRefIds.includes(source.id),
                                  )}
                                />
                              </div>
                            </details>
                          </li>
                        ))}
                    </ul>
                    {showDiagnostics &&
                    workspace.revision.brief.fields.some((field) => field.value === null) ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          <Trans>Details</Trans>
                        </summary>
                        <dl>
                          {workspace.revision.brief.fields
                            .filter((field) => field.value === null)
                            .map((field) => (
                              <div key={field.key}>
                                <dt>{field.key}</dt>
                                <dd>
                                  {field.state} · {field.origin}
                                </dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                    ) : null}
                    {workspace.revision.brief.confirmation?.revision ===
                    workspace.revision.revision ? (
                      <p>
                        <Trans>Brief confirmed</Trans>
                      </p>
                    ) : (
                      <Button
                        disabled={
                          confirming ||
                          briefClarifications.length > 0 ||
                          workspace.revision.criteria.some(
                            (criterion) =>
                              criterion.priority === "hard" &&
                              criterion.definitionQuestions.length > 0,
                          )
                        }
                        onClick={async () => {
                          setConfirming(true);
                          setConfirmationFailed(false);
                          try {
                            await rpc.recruiting.confirmBrief({
                              threadId,
                              roleId: workspace.role.id,
                              expectedRevision: workspace.revision.revision,
                            });
                            setRefresh((value) => value + 1);
                          } catch {
                            setConfirmationFailed(true);
                          } finally {
                            setConfirming(false);
                          }
                        }}
                      >
                        <Trans>Confirm brief</Trans>
                      </Button>
                    )}
                    {confirmationFailed ? (
                      <p role="alert">
                        <Trans>
                          Brief changed or could not be confirmed. Refresh and review it.
                        </Trans>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {workspace.revision.brief ? (
                  <section aria-label={t`Search filters`} className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-medium">
                        <Trans>Search filters</Trans>
                      </h4>
                      {!criteriaEdit ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCriteriaFailed(false);
                            setCriteriaEdit({
                              roleId: workspace.role.id,
                              revision: workspace.revision,
                              criteria: criteriaDraft(workspace.revision),
                              searchFilters: searchFilterDraft(workspace.revision),
                            });
                          }}
                        >
                          <Trans>Edit search filters</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Guide retrieval; qualification criteria stay unchanged.</Trans>
                    </p>
                    {criteriaEdit?.roleId === workspace.role.id ? (
                      <>
                        {criteriaEdit.searchFilters.map((filter, index) => (
                          <fieldset key={filter.id} className="space-y-2">
                            <legend className="sr-only">
                              <Trans>Search filter {index + 1}</Trans>
                            </legend>
                            <div className="flex items-start gap-2">
                              <NativeSelect
                                aria-label={t`Search filter mode`}
                                size="sm"
                                value={filter.mode}
                                onChange={(event) => {
                                  const mode = event.target.value as typeof filter.mode;
                                  setCriteriaEdit((current) =>
                                    current
                                      ? {
                                          ...current,
                                          searchFilters: current.searchFilters.map((item) =>
                                            item.id === filter.id ? { ...item, mode } : item,
                                          ),
                                        }
                                      : null,
                                  );
                                }}
                              >
                                <NativeSelectOption value="include">
                                  <Trans>Include</Trans>
                                </NativeSelectOption>
                                <NativeSelectOption value="exclude">
                                  <Trans>Exclude</Trans>
                                </NativeSelectOption>
                                <NativeSelectOption value="prefer">
                                  <Trans>Prefer</Trans>
                                </NativeSelectOption>
                              </NativeSelect>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t`Remove filter`}
                                onClick={() =>
                                  setCriteriaEdit((current) =>
                                    current
                                      ? {
                                          ...current,
                                          searchFilters: current.searchFilters.filter(
                                            (item) => item.id !== filter.id,
                                          ),
                                        }
                                      : null,
                                  )
                                }
                              >
                                <X size={14} aria-hidden />
                              </Button>
                            </div>
                            <Textarea
                              aria-label={t`Search filter`}
                              value={filter.statement}
                              aria-invalid={!filter.statement.trim()}
                              onChange={(event) => {
                                const statement = event.target.value;
                                setCriteriaEdit((current) =>
                                  current
                                    ? {
                                        ...current,
                                        searchFilters: current.searchFilters.map((item) =>
                                          item.id === filter.id ? { ...item, statement } : item,
                                        ),
                                      }
                                    : null,
                                );
                              }}
                            />
                          </fieldset>
                        ))}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setCriteriaEdit((current) =>
                              current
                                ? {
                                    ...current,
                                    searchFilters: [
                                      ...current.searchFilters,
                                      { id: crypto.randomUUID(), statement: "", mode: "include" },
                                    ],
                                  }
                                : null,
                            )
                          }
                        >
                          <Trans>Add filter</Trans>
                        </Button>
                      </>
                    ) : workspace.revision.brief.searchFilters.length ? (
                      <ul className="space-y-3">
                        {workspace.revision.brief.searchFilters.map((filter) => (
                          <li key={filter.id} className="space-y-1">
                            <p>
                              {filter.mode === "include" ? (
                                <Trans>Include</Trans>
                              ) : filter.mode === "exclude" ? (
                                <Trans>Exclude</Trans>
                              ) : (
                                <Trans>Prefer</Trans>
                              )}{" "}
                              · {filter.statement}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {filter.origin === "user_instruction" ? (
                                <Trans>User instruction</Trans>
                              ) : filter.origin === "jd" ? (
                                <Trans>JD</Trans>
                              ) : filter.origin === "hm" ? (
                                <Trans>Hiring manager</Trans>
                              ) : (
                                <Trans>Assumption</Trans>
                              )}
                            </p>
                            {filter.sourceRefIds.length ? (
                              <details>
                                <summary className="cursor-pointer text-xs text-muted-foreground">
                                  <Trans>Sources</Trans>
                                </summary>
                                <Sources
                                  sourceTarget={{
                                    kind: "role",
                                    threadId,
                                    roleRevisionId: workspace.revision.id,
                                  }}
                                  showDiagnostics={showDiagnostics}
                                  sources={[
                                    ...new Map(
                                      [
                                        ...workspace.revision.sourceRefs,
                                        ...workspace.revision.criteria.flatMap(
                                          (criterion) => criterion.sourceRefs,
                                        ),
                                      ].map((ref) => [ref.id, ref]),
                                    ).values(),
                                  ].filter((ref) => filter.sourceRefIds.includes(ref.id))}
                                />
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">
                        <Trans>No additional search filters</Trans>
                      </p>
                    )}
                  </section>
                ) : null}
                {criteriaEdit?.roleId === workspace.role.id ? (
                  <div className="space-y-4">
                    {criteriaEdit.revision.criteria.map((criterion, index) => {
                      const draft = criteriaEdit.criteria[index]!;
                      return (
                        <fieldset key={criterion.id} className="space-y-2">
                          <legend className="sr-only">
                            <Trans>Criterion {index + 1}</Trans>
                          </legend>
                          <NativeSelect
                            aria-label={t`Priority`}
                            size="sm"
                            value={draft.priority}
                            onChange={(event) => {
                              const priority = event.target.value === "hard" ? "hard" : "preferred";
                              setCriteriaEdit((current) =>
                                current
                                  ? {
                                      ...current,
                                      criteria: current.criteria.map((item) =>
                                        item.criterionId === criterion.id
                                          ? { ...item, priority }
                                          : item,
                                      ),
                                    }
                                  : null,
                              );
                            }}
                          >
                            <NativeSelectOption value="hard">
                              <Trans>Hard</Trans>
                            </NativeSelectOption>
                            <NativeSelectOption value="preferred">
                              <Trans>Preferred</Trans>
                            </NativeSelectOption>
                          </NativeSelect>
                          <CriteriaExpressionFields
                            expression={criterion.expression}
                            atoms={draft.atoms}
                            onChange={(changedAtom) => {
                              setCriteriaEdit((current) =>
                                current
                                  ? {
                                      ...current,
                                      criteria: current.criteria.map((item) => ({
                                        ...item,
                                        atoms: item.atoms.map((atom) =>
                                          atom.atomId === changedAtom.atomId ? changedAtom : atom,
                                        ),
                                      })),
                                    }
                                  : null,
                              );
                            }}
                          />
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Sources</Trans>
                            </summary>
                            <div className="mt-2">
                              <Sources
                                sourceTarget={{
                                  kind: "role",
                                  threadId,
                                  roleRevisionId: workspace.revision.id,
                                }}
                                showDiagnostics={showDiagnostics}
                                sources={criterion.sourceRefs}
                              />
                            </div>
                          </details>
                          {criterion.definitionQuestions.map((question) => (
                            <p key={question} className="text-muted-foreground">
                              {question}
                            </p>
                          ))}
                        </fieldset>
                      );
                    })}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={
                          savingCriteria ||
                          invalidCriteria ||
                          invalidSearchFilters ||
                          (!criteriaChanges.length && !searchFiltersChanged)
                        }
                        aria-busy={savingCriteria}
                        onClick={() => void saveCriteria()}
                      >
                        <Trans>Save</Trans>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingCriteria}
                        onClick={() => {
                          setCriteriaEdit(null);
                          setCriteriaFailed(false);
                        }}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                    {criteriaFailed ? (
                      <p role="alert" className="text-destructive">
                        <Trans>Changes could not be saved.</Trans>
                      </p>
                    ) : null}
                  </div>
                ) : (
                  (["hard", "preferred"] as const).map((priority) => (
                    <div key={priority} className="space-y-2">
                      <h4 className="font-medium">
                        {priority === "hard" ? (
                          <Trans>Hard criteria</Trans>
                        ) : (
                          <Trans>Preferred criteria</Trans>
                        )}
                      </h4>
                      <ul className="space-y-3">
                        {criteria
                          .filter((criterion) => criterion.priority === priority)
                          .map((criterion) => (
                            <li key={criterion.id} className="space-y-2">
                              <CriteriaExpression expression={criterion.expression} />
                              {expressionAtoms(criterion.expression).map((atom) =>
                                "employmentRule" in atom ? (
                                  <EmploymentRuleSummary
                                    key={atom.atomId}
                                    rule={atom.employmentRule}
                                  />
                                ) : null,
                              )}
                              <details>
                                <summary className="cursor-pointer text-xs text-muted-foreground">
                                  <Trans>Sources</Trans>
                                </summary>
                                <div className="mt-2">
                                  <Sources
                                    sourceTarget={{
                                      kind: "role",
                                      threadId,
                                      roleRevisionId: workspace.revision.id,
                                    }}
                                    showDiagnostics={showDiagnostics}
                                    sources={criterion.sourceRefs}
                                  />
                                </div>
                              </details>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))
                )}
                {workspace.revision.preferences.length ? (
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      <Trans>Preferences</Trans>
                    </h4>
                    <ul className="space-y-1">
                      {workspace.revision.preferences.map((preference) => (
                        <li key={preference}>{preference}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    <Trans>Role sources</Trans>
                  </summary>
                  <div className="mt-2">
                    <Sources
                      sourceTarget={{
                        kind: "role",
                        threadId,
                        roleRevisionId: workspace.revision.id,
                      }}
                      sources={workspace.revision.sourceRefs}
                      showDiagnostics={showDiagnostics}
                    />
                  </div>
                </details>
              </>
            ) : (
              <p className="text-muted-foreground">
                <Trans>No role linked</Trans>
              </p>
            )}
          </TabsContent>
          <TabsContent value="evidence" className="space-y-4">
            {workspace ? (
              <>
                {showDiagnostics
                  ? snapshot?.research.tasks.flatMap((task) =>
                      snapshot?.research.actions
                        .filter(
                          (action) => action.taskId === task.id && action.outputArtifacts.length,
                        )
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
                <div className="flex flex-wrap gap-2">
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
                              event.target.value === "all"
                                ? undefined
                                : (event.target.value as Verdict),
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
                      value={candidateFilters.sort ?? "rank"}
                      onChange={(event) =>
                        setCandidateFilters((current) => ({
                          ...current,
                          sort: event.target.value as ListRecruitingCandidatesInput["sort"],
                        }))
                      }
                    >
                      {candidatePage.sortAvailability.rank ? (
                        <NativeSelectOption value="rank">
                          <Trans>Autumn rank</Trans>
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
                </div>
                <fieldset className="flex gap-1" aria-label={t`Saved candidates`}>
                  <Button
                    size="sm"
                    variant={candidateView === "cards" ? "secondary" : "ghost"}
                    aria-pressed={candidateView === "cards"}
                    onClick={() =>
                      setCandidateList((current) => ({ ...current, candidateView: "cards" }))
                    }
                  >
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
                    <Trans>Table</Trans>
                  </Button>
                </fieldset>
                {candidateFailed ? (
                  <p role="alert" className="text-destructive">
                    <Trans>Could not load candidates</Trans>
                  </p>
                ) : null}
                {candidateLoading ? (
                  <p role="status">
                    <Trans>Loading…</Trans>
                  </p>
                ) : null}
                {candidatePage ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      <Plural value={candidatePage.total} _1="# candidate" other="# candidates" />
                    </p>
                    {candidatePage.crmTarget ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>CRM</Trans> · {candidatePage.crmTarget.target.clientLabel} ·{" "}
                        {candidatePage.crmTarget.target.roleLabel}
                      </p>
                    ) : null}
                    {!candidatePage.items.length ? (
                      <p className="text-muted-foreground">
                        <Trans>No saved candidates</Trans>
                      </p>
                    ) : candidateView === "cards" ? (
                      <ul className="grid gap-2">
                        {candidatePage.items.map((candidate) => (
                          <li key={candidate.candidateKey}>
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
                                    aria-pressed={
                                      selection?.candidateKey === candidate.candidateKey
                                    }
                                    onClick={(event) =>
                                      selectCandidate(candidate, event.currentTarget)
                                    }
                                  >
                                    {candidate.name ??
                                      (showDiagnostics
                                        ? candidate.candidateKey
                                        : t`Unnamed candidate`)}
                                  </Button>
                                  <Checkbox
                                    aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                    checked={candidate.shortlisted}
                                    disabled={shortlistPending !== null}
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
                                    {[candidate.title, candidate.company]
                                      .filter(Boolean)
                                      .join(" · ")}
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
                                />
                                <CandidateAssessment candidate={candidate} />
                                {showCrm ? (
                                  <p className="text-xs text-muted-foreground">
                                    <Trans>CRM</Trans> · <CrmStatus sync={candidate.crm} />
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
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm [&_td]:align-top [&_th]:align-top">
                          <caption className="sr-only">
                            <Trans>Saved candidates</Trans>
                          </caption>
                          <thead>
                            <tr className="border-b border-border">
                              {[
                                t`Candidate`,
                                t`Role`,
                                t`Title`,
                                t`Company`,
                                t`Location`,
                                t`Profile`,
                                t`Research match`,
                                ...(showInternalAssessments ? [t`Internal assessment`] : []),
                                ...(showCrm ? [t`CRM`] : []),
                                t`Discoveries`,
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
                              <tr key={candidate.candidateKey} className="border-b border-border">
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
                                    aria-pressed={
                                      selection?.candidateKey === candidate.candidateKey
                                    }
                                    onClick={(event) =>
                                      selectCandidate(candidate, event.currentTarget)
                                    }
                                  >
                                    {candidate.name ??
                                      (showDiagnostics
                                        ? candidate.candidateKey
                                        : t`Unnamed candidate`)}
                                  </Button>
                                </th>
                                <td className="py-2 pe-3">
                                  {workspace?.role.title}
                                  <CandidateDecision decision={candidate.decision} />
                                </td>
                                <td className="py-2 pe-3">{candidate.title ?? "—"}</td>
                                <td className="py-2 pe-3">{candidate.company ?? "—"}</td>
                                <td className="py-2 pe-3">{candidate.location ?? "—"}</td>
                                <td className="py-2 pe-3">
                                  <CandidateProfile
                                    candidate={candidate}
                                    showDiagnostics={showDiagnostics}
                                  />
                                </td>
                                <td className="min-w-48 py-2 pe-3">
                                  <CandidateResearchMatch
                                    candidate={candidate}
                                    roleRevisionId={workspace?.revision.id}
                                    compact
                                  />
                                </td>
                                {showInternalAssessments ? (
                                  <td className="py-2 pe-3">
                                    <CandidateAssessment candidate={candidate} />
                                  </td>
                                ) : null}
                                {showCrm ? (
                                  <td className="py-2 pe-3 text-xs">
                                    <CrmStatus sync={candidate.crm} />
                                  </td>
                                ) : null}
                                <td className="py-2 pe-3 tabular-nums">
                                  {candidate.discoveryCount}
                                </td>
                                <td className="py-2">
                                  <Checkbox
                                    aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                    checked={candidate.shortlisted}
                                    disabled={shortlistPending !== null}
                                    onCheckedChange={(checked) =>
                                      void setShortlist(candidate, !!checked)
                                    }
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
          <TabsContent value="missing" className="space-y-5">
            {snapshot?.questions.map((question) => {
              const candidateKey =
                question.target.kind === "candidate" ? question.target.candidateKey : null;
              const target = question.groupId
                ? { groupId: question.groupId }
                : { botId: question.botId };
              return (
                <div
                  key={`${question.effectId}:${question.messageId}:${question.askIndex}`}
                  className="space-y-2 [&>div]:max-w-full"
                >
                  <p className="text-xs text-muted-foreground">
                    {question.target.kind === "candidate" ? (
                      <>
                        {showDiagnostics
                          ? question.target.candidateKey
                          : (candidatePage?.items.find(
                              (candidate) => candidate.candidateKey === candidateKey,
                            )?.name ?? t`Candidate question`)}{" "}
                        ·{" "}
                      </>
                    ) : null}
                    {question.isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                  </p>
                  <AskCard
                    block={question.block}
                    canAnswer={question.canAnswer}
                    onAnswer={async (answer) => {
                      await rpc.threads.answer({
                        ...target,
                        runId: question.runId,
                        messageId: question.messageId,
                        answer,
                      });
                      setRefresh((value) => value + 1);
                    }}
                  />
                  {onRevealMessage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRevealMessage({ ...target, messageId: question.messageId })}
                    >
                      <Trans>Open original question</Trans>
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Role definition</Trans>
              </h3>
              {roleQuestions.map((question, index) => (
                <p key={`${index}:${question}`}>{question}</p>
              ))}
              {unphrasedBriefFields.length && workspace ? (
                <>
                  <p role="status">
                    <Trans>Role details needing clarification: {unphrasedBriefFields.length}</Trans>
                  </p>
                  <ul className="space-y-3">
                    {unphrasedBriefFields.map((field) => (
                      <li key={field.key} className="space-y-1">
                        <p>
                          {field.state === "conflict" ? (
                            <Trans>Conflicting information</Trans>
                          ) : field.state === "missing" ? (
                            <Trans>Missing info</Trans>
                          ) : (
                            <Trans>Assumption</Trans>
                          )}
                        </p>
                        {field.value !== null ? (
                          <p className="whitespace-pre-wrap">{field.value}</p>
                        ) : null}
                        {field.sourceRefIds.length ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Sources</Trans>
                            </summary>
                            <div className="mt-2">
                              <Sources
                                sourceTarget={{
                                  kind: "role",
                                  threadId,
                                  roleRevisionId: workspace.revision.id,
                                }}
                                showDiagnostics={showDiagnostics}
                                sources={roleSources.filter((source) =>
                                  field.sourceRefIds.includes(source.id),
                                )}
                              />
                            </div>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    <Trans>Ask an agent to clarify in chat.</Trans>
                  </p>
                </>
              ) : null}
              {snapshot && !roleQuestions.length && !unphrasedBriefFields.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved questions</Trans>
                </p>
              ) : null}
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">
                <Trans>Candidate facts</Trans>
              </h3>
              {!snapshot ? null : !assessments.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved assessments</Trans>
                </p>
              ) : (
                assessments.map(({ assessment, isCurrent }) => (
                  <div
                    key={`${assessment.candidateKey}:${assessment.version}`}
                    className="space-y-1"
                  >
                    <p className="text-xs text-muted-foreground">
                      {showDiagnostics
                        ? assessment.candidateKey
                        : (candidatePage?.items.find(
                            (candidate) => candidate.candidateKey === assessment.candidateKey,
                          )?.name ?? t`Unnamed candidate`)}{" "}
                      · {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                    </p>
                    {[
                      ...assessment.questions,
                      ...assessment.judgments.criteria.flatMap((judgment) => judgment.missing),
                    ].map((question, index) => (
                      <p key={`${index}:${question}`}>{question}</p>
                    ))}
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="memory" className="space-y-3">
            <div className="text-xs text-muted-foreground">
              <p>{botId ? <Trans>User and bot memory</Trans> : <Trans>User memory</Trans>}</p>
              {!botId ? (
                <p>
                  <Trans>Group bot memory is not included</Trans>
                </p>
              ) : null}
            </div>
            {snapshot?.documents.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No saved memory in these scopes</Trans>
              </p>
            ) : (
              snapshot?.documents.map((document) => (
                <MemoryDocumentView
                  key={`${document.id}:${document.revision}`}
                  document={document}
                  showDiagnostics={showDiagnostics}
                />
              ))
            )}
          </TabsContent>
          <TabsContent value="activity" className="space-y-5">
            {workspace ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                onAccessError={denyAccess}
              />
            ) : null}
            {snapshot?.research.tasks.length === 0 ? (
              <p className="text-muted-foreground">
                {snapshot?.research.observations.length ? (
                  <Trans>Results saved</Trans>
                ) : (
                  <Trans>No research activity</Trans>
                )}
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-3">
                  <div>
                    <h3 className="font-medium">
                      {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {task.state}{" "}
                      {showDiagnostics && task.providerTaskId ? `· ${task.providerTaskId}` : ""}
                    </p>
                  </div>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-2 border-s border-border ps-3">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <div className="space-y-1 break-all text-xs text-muted-foreground">
                              <p>{action.id}</p>
                              <p>{action.roleRevisionId}</p>
                              <p>{action.runId}</p>
                              <p>{action.sourceMessageId}</p>
                              {action.usage?.map((usage, index) => (
                                <p key={`${index}:${usage.unit}`}>
                                  {usage.scope} · {usage.amount} {usage.unit}
                                </p>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {action.recallScope ? (
                          <p className="whitespace-pre-wrap">{action.recallScope}</p>
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`request:${action.requestArtifact.artifactId}:${action.requestArtifact.sha256}`}
                            reference={action.requestArtifact}
                            label={t`Request`}
                          />
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`context:${action.contextArtifact.artifactId}:${action.contextArtifact.sha256}`}
                            reference={action.contextArtifact}
                            label={t`Context`}
                          />
                        ) : null}
                        {showDiagnostics && action.receiptArtifact ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`receipt:${action.receiptArtifact.artifactId}:${action.receiptArtifact.sha256}`}
                            reference={action.receiptArtifact}
                            label={t`Receipt`}
                          />
                        ) : null}
                        {showDiagnostics
                          ? action.outputArtifacts.map((reference) => (
                              <ArtifactReference
                                showDiagnostics
                                key={`${reference.artifactId}:${reference.sha256}`}
                                reference={reference}
                                label={t`Output`}
                              />
                            ))
                          : null}
                      </div>
                    ))}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      ) : null}
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
          finalFocus={candidateHandoff.current ? false : candidateTrigger}
          className="max-h-[85dvh] overflow-y-auto text-base leading-relaxed sm:max-w-2xl"
        >
          {selection ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
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
              {selection.title || selection.company ? (
                <p className="text-muted-foreground">
                  {[selection.title, selection.company].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              <CandidateProfile candidate={selection} showDiagnostics={showDiagnostics} />
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
                  onSend={onCandidateFeedback}
                  recipients={candidateFeedbackRecipients}
                  onAccessError={denyAccess}
                  onRecorded={() => setFeedbackRefresh((value) => value + 1)}
                />
              ) : null}
              {workspace ? (
                <FeedbackHistory
                  key={`feedback:${workspace.role.id}:${selection.candidateKey}`}
                  roleId={workspace.role.id}
                  candidateKey={selection.candidateKey}
                  refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                  onAccessError={denyAccess}
                />
              ) : null}
              {selectedCrmTarget ? (
                <section aria-label={t`Candidate CRM`}>
                  <CrmDetails
                    sync={selectedCrm}
                    target={selectedCrmTarget}
                    showDiagnostics={showDiagnostics}
                  />
                </section>
              ) : null}
              <CandidateResearchMatch
                candidate={selection}
                roleRevisionId={workspace?.revision.id}
              />
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
                  refreshSignal={candidatePage}
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
    </section>
  );
}
