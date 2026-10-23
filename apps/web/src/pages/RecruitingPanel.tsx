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
  RecruitingCorrespondence,
  RecruitingCriterionExpression,
  RecruitingCrmCandidateSync,
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
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
  recruitingGateLabels,
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
import {
  ArrowRight,
  Bookmark,
  BriefcaseBusiness,
  Building2,
  Check,
  CircleHelp,
  LayoutGrid,
  List,
  Mail,
  MapPin,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArtifactFileCard, SourceText } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { Shimmer } from "../components/ai/primitives";
import { decodeArtifactBase64 } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { retryTransientRead } from "../lib/read-retry";
import type { RecruitingReadCache } from "../lib/recruiting-read-cache";
import { clearRecruitingReads, rememberRecruitingRead } from "../lib/recruiting-read-cache";
import type { RecruitingPanelState } from "../lib/right-panel-state";
import {
  readRecruitingPanelState,
  rightPanelStorageKey,
  writeRecruitingPanelState,
} from "../lib/right-panel-state";
import { rpc } from "../lib/rpc";
import { CorrespondenceEmails } from "./RecruitingCorrespondence";
import type { RecruitingInboxEmail, RecruitingTabProps } from "./recruiting";
import { InboxWithReply, InterviewTab, SequenceTab } from "./recruiting";
import { ContactsTab } from "./recruiting/ContactsTab";
import type { RecruitingDetailPerson } from "./recruiting/detail";
import { useRecruitingDetail } from "./recruiting/detail";
import { RetryNotice } from "./recruiting/RetryNotice";
import { TabLoading, tabCacheSlot, useKeyedRead } from "./recruiting/shared";
import type { RecruitingWorkspaceView } from "./shell/RecruitingNavigation";

export type CrmBrowseSelection = Pick<
  Extract<RecruitingCrmDataInput, { operation: "candidates" }>,
  "serverId" | "serverRevision" | "organizationId" | "crmRoleId"
>;

export type CrmReplyDraftContext = {
  threadId: string;
  candidateId: string;
  candidateName?: string;
  candidateEmail?: string | null;
  email: {
    sender: string | null;
    recipients: string[];
    subject: string | null;
    date: string | null;
  };
  source: { serverId: string; serverRevision: number; organizationId: string };
  crmRoleId?: string;
};

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
  intent?: "email_draft" | "contact_lookup";
};

export type CandidateFeedback = {
  choice: RecruitingCandidateFeedbackSelection["choice"];
  reason: string;
  recipientBotId?: string;
};

type Props = {
  /** The thread is this CRM role's own conversation, so its agent results share the workbench. */
  roleConversation?: boolean;
  /** The role conversation's own Sequence, Inbox or Interview view, shown above its CRM history. */
  correspondence?: ReactNode;
  crmBrowse?: {
    selection: CrmBrowseSelection;
    view: RecruitingWorkspaceView;
    candidateId?: string;
    onSelectCandidate: (id: string, view?: RecruitingWorkspaceView) => void;
    onStartRecruiting?: (description: string) => void;
    onDraftReply?: (context: CrmReplyDraftContext) => void;
  };
  threadId: string;
  botId?: string;
  groupId?: string;
  readCache?: RecruitingReadCache;
  readCacheScope?: string;
  refreshSignal?: number;
  onClose: () => void;
  onBrowseCandidates?: () => void;
  showDiagnostics?: boolean;
  presentation?: "panel" | "workspace";
  summary?: "brief" | "feedback";
  view?: "results" | "shortlist" | "contacts";
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
  disabled = false,
}: {
  candidate: CandidateDiscussionContext;
  recipients: Props["candidateFeedbackRecipients"];
  onSend: NonNullable<Props["onCandidateFeedback"]>;
  onAccessError: (error: unknown) => void;
  onRecorded: () => void;
  disabled?: boolean;
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
    if (
      disabled ||
      scope.current.busy ||
      recipientUnavailable ||
      !choice ||
      (reasonRequired && !reason.trim())
    )
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
    <div className="hire-candidate-feedback space-y-2">
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
              disabled ||
              pending ||
              recipientUnavailable ||
              !choice ||
              (reasonRequired && !reason.trim())
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
  showEmpty = false,
  collapsed = false,
  readCache,
  readCacheScope,
}: {
  roleId: string;
  candidateKey?: string;
  refreshSignal?: number;
  onAccessError: (error: unknown) => void;
  showEmpty?: boolean;
  collapsed?: boolean;
  readCache?: RecruitingReadCache;
  readCacheScope?: string;
}) {
  const cacheKey = readCacheScope
    ? `${readCacheScope}:feedback:${JSON.stringify([roleId, candidateKey])}`
    : undefined;
  const cached = cacheKey
    ? (readCache?.entries.get(cacheKey) as
        | Awaited<ReturnType<typeof rpc.recruiting.listFeedback>>
        | undefined)
    : undefined;
  const [records, setRecords] = useState<RecruitingFeedbackRecord[]>(cached?.feedback ?? []);
  const [cursor, setCursor] = useState<string | null>(cached?.nextCursor ?? null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const displayedFeedbackScope = useRef(cacheKey);
  const read = useCallback(
    async (before?: string) => {
      const current = ++generation.current;
      const cacheEpoch = readCache?.epoch;
      setPending(true);
      setFailed(false);
      try {
        const result = await rpc.recruiting.listFeedback({
          roleId,
          ...(candidateKey ? { candidateKey } : {}),
          limit: 20,
          ...(before ? { before } : {}),
        });
        if (current !== generation.current || (readCache && cacheEpoch !== readCache.epoch)) return;
        if (!before) rememberRecruitingRead(readCache, cacheKey, result, cacheEpoch);
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
    [roleId, candidateKey, onAccessError, readCache, cacheKey],
  );
  useEffect(() => {
    if (cached || !readCache || displayedFeedbackScope.current !== cacheKey) {
      setRecords(cached?.feedback ?? []);
      setCursor(cached?.nextCursor ?? null);
    }
    displayedFeedbackScope.current = cacheKey;
    void read();
    return () => {
      generation.current++;
    };
  }, [read, refreshSignal]);
  if (!records.length && !failed && !showEmpty) return null;
  const Container = collapsed ? "details" : "section";
  const Heading = collapsed ? "summary" : "h4";
  return (
    <Container className="hire-candidate-feedback-history space-y-2">
      <Heading className={collapsed ? "cursor-pointer font-medium" : "font-medium"}>
        <Trans>Feedback history</Trans>
      </Heading>
      {showEmpty && !records.length && !failed ? (
        <p role={pending ? "status" : undefined} className="text-sm text-muted-foreground">
          {pending ? <Trans>Loading…</Trans> : <Trans>No saved feedback yet.</Trans>}
        </p>
      ) : null}
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
    </Container>
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

function CandidateResumeStatus({ value }: { value: string }) {
  switch (value.trim().toLowerCase()) {
    case "not_checked":
      return <Trans>Not checked</Trans>;
    case "inaccessible":
      return <Trans>Could not access</Trans>;
    case "available":
      return <Trans>Available</Trans>;
    case "missing":
      return <Trans>Missing</Trans>;
    case "unknown":
      return <Trans>Unknown</Trans>;
    default:
      return value;
  }
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
            {resumeStatus ? (
              <>
                {" "}
                ({showDiagnostics ? resumeStatus : <CandidateResumeStatus value={resumeStatus} />})
              </>
            ) : null}
          </a>
        ) : (
          <span className="text-muted-foreground">
            {resumeStatus ? (
              <>
                <Trans>Resume</Trans>:{" "}
                {showDiagnostics ? resumeStatus : <CandidateResumeStatus value={resumeStatus} />}
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

function recruitingMatchSummaryText(value: string): string {
  // ponytail: ambiguous codes may name companies/products; translate only explicit gate expressions.
  return value.replace(
    /https?:\/\/\S+|\bnot qualification,\s*not G[0-4](?=$|[.,;:!?)]|\s+gate\b)|\b(?:playbook\s+)?gate\s+G[0-4]\b/gi,
    (expression) =>
      /^https?:\/\//i.test(expression)
        ? expression
        : expression.replace(
            /\bG[0-4]\b/gi,
            (gate) => recruitingGateLabels[gate.toUpperCase() as keyof typeof recruitingGateLabels],
          ),
  );
}

function CandidateReportValue({
  label,
  value,
  providerStatus,
  compact = false,
  showDiagnostics = false,
}: Pick<RecruitingCandidateReport["fields"][number], "label" | "value" | "providerStatus"> & {
  compact?: boolean;
  showDiagnostics?: boolean;
}) {
  const { t } = useLingui();
  if (providerStatus)
    return (
      <VerdictLabel
        verdict={
          providerStatus === "match" ? "met" : providerStatus === "miss" ? "unmet" : "unknown"
        }
        label={
          providerStatus === "match"
            ? t`Match`
            : providerStatus === "miss"
              ? t`Does not match`
              : t`Unclear`
        }
      />
    );
  if (label === "Resume status" && value !== null && !showDiagnostics)
    return (
      <p className={compact ? "line-clamp-2" : "whitespace-pre-wrap"}>
        <CandidateResumeStatus value={value} />
      </p>
    );
  if (
    value === null ||
    value.length <= 240 ||
    !["Recommendation", "Match judgment", "Fit reasons"].includes(label)
  )
    return (
      <p className={compact ? "line-clamp-2" : "whitespace-pre-wrap"}>
        {value ?? <Trans>Unknown</Trans>}
      </p>
    );
  return (
    <details className="group/summary">
      <summary aria-label={`${label}: ${t`Details`}`} className="cursor-pointer">
        <span className="line-clamp-2 whitespace-pre-wrap group-open/summary:hidden">{value}</span>
        <span className="text-xs text-muted-foreground">
          <Trans>Details</Trans>
        </span>
      </summary>
      <p className="whitespace-pre-wrap">{value}</p>
    </details>
  );
}

function CandidateResearchMatch({
  candidate,
  roleRevisionId,
  showDiagnostics,
  compact = false,
}: {
  candidate: RecruitingCandidate;
  roleRevisionId?: string;
  showDiagnostics: boolean;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const source = candidate.latestSource;
  const hasHigherRank = source?.report?.fields.some((field) =>
    ["Updated rank", "Overall rank", "Rank"].includes(field.label),
  );
  const fields = source?.report?.fields.filter(
    (field) =>
      ([
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
      ].includes(field.label) ||
        (!compact && field.providerStatus !== undefined)) &&
      (!compact || field.label !== "Fit reasons") &&
      (field.label !== "Batch rank" || !hasHigherRank),
  );
  fields?.sort((a, b) => Number(a.label === "Fit reasons") - Number(b.label === "Fit reasons"));
  const hasMatchRating = fields?.some((field) =>
    ["Score", "Match score", "Match tier", "Grade"].includes(field.label),
  );
  return (
    <dl aria-label={t`Research match`} className="hire-candidate-match space-y-1 text-xs">
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
                  <div
                    key={field.label}
                    className={`flex flex-wrap gap-x-2 ${field.providerStatus ? "hire-candidate-criterion" : ""}`}
                  >
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd
                      className={`wrap-anywhere ${
                        compact
                          ? showDiagnostics &&
                            ["Recommendation", "Match judgment"].includes(field.label)
                            ? "line-clamp-2"
                            : ""
                          : "whitespace-pre-wrap text-base"
                      }`}
                    >
                      {field.providerStatus ? (
                        <CandidateReportValue
                          label={field.label}
                          value={field.value}
                          providerStatus={field.providerStatus}
                          compact={compact}
                        />
                      ) : field.value === null ? (
                        <Trans>Unknown</Trans>
                      ) : showDiagnostics ||
                        !["Recommendation", "Match judgment", "Fit reasons"].includes(
                          field.label,
                        ) ? (
                        field.value
                      ) : (
                        <CandidateReportValue
                          label={field.label}
                          value={recruitingMatchSummaryText(field.value)}
                          compact={compact}
                        />
                      )}
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

function SourcingCandidateCard({
  candidate,
  selected,
  triggerRef,
  onOpen,
  onShortlist,
  shortlistPending,
  shortlistFailed,
  onEmailDraft,
}: {
  candidate: RecruitingCandidate;
  selected: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  onOpen: (trigger: HTMLButtonElement) => void;
  onShortlist: () => void;
  shortlistPending: boolean;
  shortlistFailed: boolean;
  onEmailDraft?: () => void;
}) {
  const { t } = useLingui();
  const name = candidate.name ?? t`Unnamed candidate`;
  const fields = candidate.latestSource?.report?.fields ?? [];
  const match = ["Match tier", "Grade", "Match score", "Score"]
    .map((label) => fields.find((field) => field.label === label && field.value !== null))
    .find(Boolean);
  const summary = ["Fit reasons", "Recommendation", "Match judgment"]
    .map((label) => fields.find((field) => field.label === label && field.value))
    .find(Boolean);
  const employer = fields.find((field) =>
    ["Company context", "Employer context", "Employer description", "Company description"].includes(
      field.label,
    ),
  );
  return (
    <article className="hire-candidate-card" data-selected={selected || undefined}>
      <div className="hire-card-top">
        <Checkbox
          aria-label={t`Shortlist ${name}`}
          checked={candidate.shortlisted}
          disabled={shortlistPending}
          onCheckedChange={onShortlist}
        />
        <button
          type="button"
          ref={triggerRef}
          className="hire-candidate-identity"
          aria-haspopup="dialog"
          aria-pressed={selected}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <span className="hire-avatar" aria-hidden>
            {name
              .split(/\s+/u)
              .slice(0, 2)
              .map((part) => Array.from(part)[0])
              .join("")}
          </span>
          <span>
            <strong>{name}</strong>
            <small>
              <MapPin size={12} aria-hidden />
              {candidate.location ?? t`Location not returned`}
            </small>
          </span>
        </button>
        {match ? (
          <span className="hire-match-score">
            {match.label}: {match.value}
          </span>
        ) : null}
      </div>
      <div className="hire-card-history">
        <span>
          <BriefcaseBusiness size={16} aria-hidden />
          <strong>
            {[candidate.title, candidate.company].filter(Boolean).join(" · ") ||
              t`Current role not returned`}
          </strong>
        </span>
      </div>
      {summary ? (
        <div className="hire-card-evidence">
          <Sparkles size={14} aria-hidden />
          <div>
            <p>{recruitingMatchSummaryText(summary.value!)}</p>
            {summary.sourceUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {new URL(url).hostname}
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {employer ? (
        <div className="hire-peer-evidence">
          <Building2 size={14} aria-hidden />
          <div>
            <strong>{employer.label}</strong>
            <p>{employer.value ?? t`Unknown`}</p>
            {employer.sourceUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {new URL(url).hostname}
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <CandidateProfile candidate={candidate} />
      {shortlistFailed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not save shortlist</Trans>
        </p>
      ) : null}
      <div className="hire-card-actions">
        <button
          type="button"
          disabled={shortlistPending}
          onClick={onShortlist}
          aria-label={
            candidate.shortlisted ? t`Remove ${name} from shortlist` : t`Add ${name} to shortlist`
          }
        >
          <Bookmark size={16} aria-hidden fill={candidate.shortlisted ? "currentColor" : "none"} />
          {candidate.shortlisted ? <Trans>Shortlisted</Trans> : <Trans>Shortlist</Trans>}
        </button>
        {onEmailDraft ? (
          <button type="button" onClick={onEmailDraft}>
            <Mail size={15} aria-hidden />
            <Trans>Email draft</Trans>
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t`View ${name}`}
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </article>
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
        <Trans>Pipeline</Trans> · <CrmStatus sync={sync} />
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

function CandidateReport({
  report,
  showDiagnostics = false,
  condensed = false,
}: {
  report: RecruitingCandidateReport;
  showDiagnostics?: boolean;
  condensed?: boolean;
}) {
  const fieldUrls = new Set(report.fields.flatMap((field) => field.sourceUrls));
  const fields = condensed
    ? report.fields.toSorted((a, b) => Number(!!b.providerStatus) - Number(!!a.providerStatus))
    : report.fields;
  const FieldList = condensed ? "div" : "dl";
  return (
    <div
      className={`hire-candidate-report space-y-3 break-words font-sans ${condensed ? "text-xs leading-normal" : "text-base leading-relaxed"}`}
    >
      <FieldList className="space-y-3">
        {fields.map((field, index) => {
          const content = (
            <div key={index} className="space-y-1">
              {!condensed || !field.providerStatus ? (
                <CandidateReportValue
                  label={field.label}
                  value={field.value}
                  providerStatus={field.providerStatus}
                  showDiagnostics={showDiagnostics}
                />
              ) : null}
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
            </div>
          );
          return condensed ? (
            <details key={index} className="hire-candidate-finding">
              <summary className="cursor-pointer">
                <span className="hire-candidate-finding-heading">
                  <span className="font-medium">{field.label}</span>
                  {field.providerStatus ? (
                    <CandidateReportValue
                      label={field.label}
                      value={field.value}
                      providerStatus={field.providerStatus}
                    />
                  ) : null}
                </span>
              </summary>
              {content}
            </details>
          ) : (
            <div key={index}>
              <dt className="font-medium">{field.label}</dt>
              <dd>{content}</dd>
            </div>
          );
        })}
      </FieldList>
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

const CONTACT_STATUS_LABELS = [
  "email status",
  "email verification",
  "email verification status",
  "contact status",
  "verification status",
];

/** Autumn's own per-criterion states with their raw evidence and sources, never re-judged. */
function CandidateCriteria({ candidate }: { candidate: RecruitingCandidate }) {
  const fields = candidate.latestSource?.report?.fields.filter((field) => field.providerStatus);
  return fields?.length ? (
    <CandidateReport condensed report={{ fields, sourceUrls: [] }} />
  ) : (
    <span className="text-muted-foreground">
      <Trans>Not returned</Trans>
    </span>
  );
}

/** The saved search round that last returned this person, named like the round filter. */
function CandidateSourceRound({
  candidate,
  research,
}: {
  candidate: RecruitingCandidate;
  research?: Snapshot["research"];
}) {
  const source = candidate.latestSource;
  if (source && source.providerTaskId === null) return <Trans>Imported list</Trans>;
  const index = source?.actionId
    ? (research?.actions.findIndex((action) => action.id === source.actionId) ?? -1)
    : -1;
  if (index >= 0) return <Trans>Search update {index + 1}</Trans>;
  const observation = research?.observations.find((item) => item.effectId === source?.effectId);
  return observation ? (
    <>
      <Trans>Saved results</Trans>
      {" · "}
      {new Date(observation.observedAt).toLocaleString(undefined, {
        timeZone: "America/Los_Angeles",
        timeZoneName: "short",
      })}
    </>
  ) : (
    "—"
  );
}

function CandidateContactFields({
  candidate,
  labels,
  contacts,
  kind,
}: {
  candidate: RecruitingCandidate;
  labels: readonly string[];
  contacts: RecruitingCorrespondence["contacts"];
  kind: "email" | "phone" | "status";
}) {
  const { t } = useLingui();
  const matched = contacts.filter((contact) => contact.candidateKey === candidate.candidateKey);
  const originalFields =
    candidate.latestSource?.report?.fields.filter((field) =>
      labels.includes(field.label.toLowerCase()),
    ) ?? [];
  const fields = matched.length
    ? matched.flatMap((contact) =>
        kind === "phone"
          ? contact.phones.map((phone) => ({
              label: phone.type ?? t`Phone`,
              value: phone.number,
              sourceUrls: [],
            }))
          : contact.emails.map((email) => ({
              label: kind === "email" ? t`Email` : email.address,
              value:
                kind === "email"
                  ? email.address
                  : email.status === "HIGH_PROBABILITY"
                    ? t`High probability`
                    : email.status,
              sourceUrls: [],
            })),
      )
    : originalFields;
  return (
    <>
      {fields.length ? (
        <CandidateReport report={{ fields, sourceUrls: [] }} />
      ) : (
        <span className="text-muted-foreground">
          <Trans>Not returned</Trans>
        </span>
      )}
      {matched.length && originalFields.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            <Trans>Original source</Trans>
          </summary>
          <CandidateReport report={{ fields: originalFields, sourceUrls: [] }} />
        </details>
      ) : null}
      {kind === "status"
        ? matched.map((contact) => (
            <p
              className="mt-2 text-xs text-muted-foreground"
              key={`${contact.source}:${contact.checkedAt}`}
            >
              {contact.source} ·{" "}
              <time dateTime={contact.checkedAt}>
                {new Date(contact.checkedAt).toLocaleString()}
              </time>
            </p>
          ))
        : null}
    </>
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
            {source.providerTaskId === null ? (
              <p className="text-xs font-medium">
                <Trans>Imported list</Trans>
              </p>
            ) : null}
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
                  <CandidateReport
                    report={source.report}
                    showDiagnostics={showDiagnostics}
                    condensed
                  />
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
            <CandidateReport report={current.excerpt.report} showDiagnostics={showDiagnostics} />
          ) : current?.excerpt?.kind === "text" ? (
            <SourceText
              text={current.excerpt.text}
              start={current.excerpt.start}
              end={current.excerpt.end}
            />
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

function VerdictLabel({ verdict, label }: { verdict: Verdict; label?: string }) {
  const Icon = verdict === "met" ? Check : verdict === "unmet" ? X : CircleHelp;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${verdict === "met" ? "text-success" : verdict === "unmet" ? "text-destructive" : "text-warning"}`}
    >
      <Icon size={14} aria-hidden />
      {label ??
        (verdict === "met" ? (
          <Trans>Met</Trans>
        ) : verdict === "unmet" ? (
          <Trans>Unmet</Trans>
        ) : (
          <Trans>Unknown</Trans>
        ))}
    </span>
  );
}

// Reset all fetched records when navigation changes the source thread, even before its reads finish.
export function RecruitingPanel(props: Props) {
  return props.crmBrowse ? (
    <CrmRecruitingPanel
      key={JSON.stringify([props.readCacheScope, props.threadId, props.crmBrowse.selection])}
      {...props}
      browse={props.crmBrowse}
      agent={props.roleConversation ? <RoleAgentSection {...props} /> : undefined}
    />
  ) : (
    <NativeRecruitingPanel {...props} />
  );
}

/**
 * The role conversation's own saved results for the current workbench tab. A CRM role and an
 * agent-created role share one workbench: CRM records render below this section when linked.
 */
function RoleAgentSection({ crmBrowse, roleConversation: _, correspondence, ...props }: Props) {
  const view = crmBrowse?.view;
  if (view === "brief" || view === "feedback")
    return <NativeRecruitingPanel {...props} presentation="workspace" summary={view} />;
  if (view === "sequence" || view === "inbox" || view === "interview") return <>{correspondence}</>;
  if (view === "conversation") return null;
  return (
    <NativeRecruitingPanel
      {...props}
      presentation="workspace"
      // Search results and CRM contacts are one list.
      view={view === "shortlist" ? view : view === "workflow" ? "results" : "contacts"}
      tab={view === "workflow" ? "dashboard" : "evidence"}
    />
  );
}

/**
 * Single mount point for the Contacts, Sequence, Inbox and Interview tabs. The role tabs need the
 * conversation's native role bound to CRM; a CRM role without one keeps its stored CRM views.
 */
function CorrespondenceTabMount({
  view,
  role,
  conversation,
  refreshSignal,
  onDraftReply,
  loading,
  fallback,
}: {
  view: RecruitingWorkspaceView;
  role?: Omit<RecruitingTabProps, "conversation" | "refreshSignal">;
  conversation: { groupId: string } | { botId: string };
  refreshSignal: number;
  onDraftReply?: (email: RecruitingInboxEmail) => void;
  /** The role binding is still being read. */
  loading: boolean;
  fallback: ReactNode;
}) {
  if (!role && loading) return <TabLoading />;
  if (!role) return <>{fallback}</>;
  const props = { ...role, conversation, refreshSignal };
  if (view === "sequence") return <SequenceTab {...props} />;
  if (view === "interview") return <InterviewTab {...props} />;
  return <InboxWithReply {...props} onDraftReply={onDraftReply} />;
}

type BoundRole = {
  roleId: string;
  spaceId: string;
  title: string;
  crmTarget: RecruitingCrmTarget;
};

/**
 * The role conversation's native role when it is bound to a CRM role; `done` once known. The
 * binding is handed to the role tabs so they read CRM rows without re-reading it.
 */
function useBoundRole(
  threadId: string,
  enabled: boolean,
  refreshSignal: number,
  cache: Pick<Props, "readCache" | "readCacheScope">,
): { done: boolean; role?: BoundRole; title?: string } {
  const read = useKeyedRead(
    enabled ? JSON.stringify([threadId, refreshSignal]) : null,
    async (): Promise<{ role?: BoundRole; title?: string }> => {
      const workspace = await rpc.recruiting.getWorkspace({ threadId });
      // The native role names the workbench, bound to a CRM role or not.
      const title = workspace?.role.title;
      return workspace?.crmTarget
        ? {
            title,
            role: {
              roleId: workspace.role.id,
              spaceId: workspace.role.spaceId,
              title: workspace.role.title,
              crmTarget: workspace.crmTarget.target,
            },
          }
        : { title };
    },
    tabCacheSlot(cache, ["boundRole", threadId]),
  );
  return {
    done: !enabled || Boolean(read.data) || read.failed,
    role: read.data?.role,
    title: read.data?.title,
  };
}

function CrmRecruitingPanel({
  browse,
  agent,
  threadId,
  botId,
  groupId,
  readCache,
  readCacheScope,
  showDiagnostics = false,
  refreshSignal = 0,
}: Props & { browse: NonNullable<Props["crmBrowse"]>; agent?: ReactNode }) {
  const { t } = useLingui();
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const bound = useBoundRole(threadId, Boolean(agent), refreshSignal + refresh, {
    readCache,
    readCacheScope,
  });
  const boundRole = bound.role && {
    roleId: bound.role.roleId,
    spaceId: bound.role.spaceId,
    crmTarget: bound.role.crmTarget,
    readCache,
    readCacheScope,
  };
  // The role tabs read their own CRM data; stored CRM views read only when they are shown.
  const storedCrmReads =
    !agent ||
    !["contacts", "sequence", "inbox", "interview"].includes(browse.view) ||
    (bound.done && !bound.role);
  const [mailPageSelection, setMailPageSelection] = useState<{
    candidateId: string;
    cursor: Extract<RecruitingCrmDataInput, { operation: "mail" }>["cursor"];
  }>();
  const mailCursor =
    mailPageSelection?.candidateId === browse.candidateId ? mailPageSelection?.cursor : undefined;
  const setMailCursor = (
    cursor: Extract<RecruitingCrmDataInput, { operation: "mail" }>["cursor"],
  ) =>
    setMailPageSelection(
      browse.candidateId ? { candidateId: browse.candidateId, cursor } : undefined,
    );
  const [selectedMail, setSelectedMail] = useState<string>();
  type CandidatePage = Extract<RecruitingCrmDataOutput, { operation: "candidates" }>;
  type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
  const target = groupId ? { groupId } : { botId: botId! };
  const input = {
    ...target,
    operation: "candidates" as const,
    ...browse.selection,
    query,
    limit: 30,
    offset,
  };
  const key = JSON.stringify([readCacheScope, input, refreshSignal, refresh]);
  const cacheKey = readCacheScope ? `${readCacheScope}:crm:${JSON.stringify(input)}` : undefined;
  const [read, setRead] = useState<{
    key: string;
    data?: CandidatePage;
    failed?: boolean;
    loading?: boolean;
  }>();
  useEffect(() => {
    if (!storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    setRead({
      key,
      loading: true,
      data: cacheKey ? (readCache?.entries.get(cacheKey) as CandidatePage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(input), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch) return setRead({ key, failed: true });
        if (
          value.operation !== "candidates" ||
          value.source.serverId !== browse.selection.serverId ||
          value.source.serverRevision !== browse.selection.serverRevision ||
          value.source.organizationId !== browse.selection.organizationId ||
          (browse.selection.crmRoleId &&
            value.selectedRole?.crmRoleId !== browse.selection.crmRoleId)
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, cacheKey, value, epoch);
        setRead({ key, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setRead({ key, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [key, cacheKey, readCache, readCacheScope, storedCrmReads]);
  const page = read?.key === key ? read.data : undefined;
  const mailInput = {
    ...target,
    operation: "mail" as const,
    serverId: browse.selection.serverId,
    serverRevision: browse.selection.serverRevision,
    organizationId: browse.selection.organizationId,
    candidateId: browse.candidateId ?? "",
    ...(browse.selection.crmRoleId ? { crmRoleId: browse.selection.crmRoleId } : {}),
    limit: 30,
    ...(mailCursor ? { cursor: mailCursor } : {}),
  };
  const mailKey = JSON.stringify([readCacheScope, mailInput, refreshSignal, refresh]);
  const [mail, setMail] = useState<{
    key: string;
    data?: MailPage;
    failed?: boolean;
    validated?: boolean;
  }>();
  useEffect(() => {
    setSelectedMail(undefined);
  }, [browse.candidateId]);
  useEffect(() => {
    if (browse.view !== "inbox" || !browse.candidateId || !storedCrmReads) {
      setMail(undefined);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(mailInput)}`
      : undefined;
    setMail({
      key: mailKey,
      data: savedKey ? (readCache?.entries.get(savedKey) as MailPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(mailInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch) return setMail({ key: mailKey, failed: true });
        if (
          value.operation !== "mail" ||
          value.source.serverId !== browse.selection.serverId ||
          value.source.serverRevision !== browse.selection.serverRevision ||
          value.source.organizationId !== browse.selection.organizationId ||
          value.candidateId !== browse.candidateId ||
          value.nativeCorrespondence.some(
            (entry) =>
              entry.candidateId !== browse.candidateId ||
              entry.crmRoleId !== browse.selection.crmRoleId,
          )
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setMail({ key: mailKey, data: value, validated: true });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setMail({ key: mailKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [mailKey, browse.view, readCache, readCacheScope, storedCrmReads]);
  const currentMail = mail?.key === mailKey ? mail : undefined;
  const mailPage = currentMail?.data;
  const nativeMail = mailPage?.nativeCorrespondence ?? [];
  const nativeByEmail = new Map<string, (typeof nativeMail)[number]>();
  for (const entry of nativeMail) {
    if (!entry.email) continue;
    const previous = nativeByEmail.get(entry.email.id);
    if (!previous || Date.parse(entry.checkedAt) > Date.parse(previous.checkedAt))
      nativeByEmail.set(entry.email.id, entry);
  }
  const nativeEmails = [...nativeByEmail.values()];
  const inboxEmails = [
    ...nativeEmails.flatMap((entry) =>
      entry.email ? [{ ...entry.email, id: `native:${entry.email.id}` }] : [],
    ),
    ...(mailPage?.items.map((item) => ({
      id: `crm:${item.id}`,
      sender: item.sender,
      recipients: item.recipients,
      subject: item.subject ?? "",
      body: item.body ?? "",
      snippet: item.partial,
      date: item.date,
      url: null,
    })) ?? []),
  ];
  const selectedInboxEmail = inboxEmails.find((item) => item.id === selectedMail) ?? inboxEmails[0];
  const selectedNativeMail = nativeEmails.find(
    (entry) => entry.email && `native:${entry.email.id}` === selectedInboxEmail?.id,
  );
  const nativeMailStatus = {
    read: t`Saved email`,
    sent_recorded: t`Send recorded`,
    scheduled: t`Scheduled`,
    unknown: t`Send outcome unknown`,
  };
  const draftEmail = currentMail?.validated ? selectedInboxEmail : undefined;
  const people = page?.items ?? [];
  const selectedPerson = people.find((person) => person.candidateId === browse.candidateId);
  const importantView = ["shortlist", "interview", "workflow"].includes(browse.view);
  type ImportantStatus = NonNullable<
    Extract<RecruitingCrmDataInput, { operation: "important" }>["status"]
  >;
  const workflowLabels = {
    waiting_resume: t`Waiting for resume`,
    resume_ready: t`Resume ready`,
    introduced: t`Introduced`,
    needs_scheduling: t`Needs scheduling`,
    scheduled: t`Scheduled`,
    awaiting_feedback: t`Awaiting feedback`,
  };
  const [statusSelection, setStatusSelection] = useState<{
    view: RecruitingWorkspaceView;
    status: ImportantStatus | "";
  }>();
  const importantStatus =
    statusSelection?.view === browse.view
      ? statusSelection.status
      : browse.view === "shortlist"
        ? "high_signal"
        : browse.view === "interview"
          ? "needs_scheduling"
          : "";
  const [sectionPage, setSectionPage] = useState<{ key: string; offset: number }>();
  const sectionScope = JSON.stringify([browse.view, importantStatus]);
  const sectionOffset = sectionPage?.key === sectionScope ? sectionPage.offset : 0;
  const pinned = {
    serverId: browse.selection.serverId,
    serverRevision: browse.selection.serverRevision,
    organizationId: browse.selection.organizationId,
  };
  const sectionInput = importantView
    ? {
        ...target,
        ...pinned,
        operation: "important" as const,
        ...(importantStatus ? { status: importantStatus } : {}),
        limit: 30,
        offset: sectionOffset,
      }
    : browse.view === "sequence" && browse.selection.crmRoleId
      ? {
          ...target,
          ...pinned,
          operation: "roleCampaigns" as const,
          crmRoleId: browse.selection.crmRoleId,
          limit: 30,
          offset: sectionOffset,
        }
      : undefined;
  const sectionKey = JSON.stringify([readCacheScope, sectionInput, refreshSignal, refresh]);
  type SectionPage = Extract<RecruitingCrmDataOutput, { operation: "important" | "roleCampaigns" }>;
  const [sectionRead, setSectionRead] = useState<{
    key: string;
    data?: SectionPage;
    loading?: boolean;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!sectionInput || !storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(sectionInput)}`
      : undefined;
    setSectionRead({
      key: sectionKey,
      loading: true,
      data: savedKey ? (readCache?.entries.get(savedKey) as SectionPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(sectionInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch)
          return setSectionRead({ key: sectionKey, failed: true });
        if (
          (value.operation !== "important" && value.operation !== "roleCampaigns") ||
          value.operation !== sectionInput.operation ||
          value.source.serverId !== pinned.serverId ||
          value.source.serverRevision !== pinned.serverRevision ||
          value.source.organizationId !== pinned.organizationId ||
          (value.operation === "roleCampaigns" && value.crmRoleId !== browse.selection.crmRoleId)
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setSectionRead({ key: sectionKey, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setSectionRead({ key: sectionKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [sectionKey, readCache, readCacheScope, storedCrmReads]);
  const section = sectionRead?.key === sectionKey ? sectionRead : undefined;
  const important = section?.data?.operation === "important" ? section.data : undefined;
  const campaigns = section?.data?.operation === "roleCampaigns" ? section.data : undefined;
  const [detailsPage, setDetailsPage] = useState<{ candidateId: string; offset: number }>();
  const detailsOffset =
    detailsPage?.candidateId === browse.candidateId ? (detailsPage?.offset ?? 0) : 0;
  const detailsInput =
    browse.candidateId && ["feedback", "sequence"].includes(browse.view)
      ? {
          ...target,
          ...pinned,
          operation: "candidateDetails" as const,
          candidateId: browse.candidateId,
          limit: 30,
          offset: detailsOffset,
        }
      : undefined;
  const detailsKey = JSON.stringify([readCacheScope, detailsInput, refreshSignal, refresh]);
  type DetailsPage = Extract<RecruitingCrmDataOutput, { operation: "candidateDetails" }>;
  const [detailsRead, setDetailsRead] = useState<{
    key: string;
    data?: DetailsPage;
    loading?: boolean;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!detailsInput || !storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(detailsInput)}`
      : undefined;
    setDetailsRead({
      key: detailsKey,
      loading: true,
      data: savedKey ? (readCache?.entries.get(savedKey) as DetailsPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(detailsInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch)
          return setDetailsRead({ key: detailsKey, failed: true });
        if (
          value.operation !== "candidateDetails" ||
          value.source.serverId !== pinned.serverId ||
          value.source.serverRevision !== pinned.serverRevision ||
          value.source.organizationId !== pinned.organizationId ||
          value.candidateId !== browse.candidateId
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setDetailsRead({ key: detailsKey, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setDetailsRead({ key: detailsKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [detailsKey, readCache, readCacheScope, storedCrmReads]);
  const currentDetails = detailsRead?.key === detailsKey ? detailsRead : undefined;
  const details = currentDetails?.data;
  const contactRegion = useRef<HTMLElement>(null);
  const contactHeadingId = useId();
  const revealedContact = useRef<string | null>(null);
  const contactRead = browse.view === "inbox" ? currentMail : currentDetails;
  const outbox = contactRead?.data?.outbox;
  const queueStatusLabels = {
    pending: t`Saved, not sent`,
    processing: t`Previously processing`,
    sent: t`Marked as sent`,
    failed: t`Send failed`,
  };
  const outboxContent = outbox ? (
    <section className="my-6 space-y-3" aria-label={t`Recruiter messages`}>
      <h3 className="font-semibold">
        <Trans>Recruiter messages</Trans>
      </h3>
      {outbox.length ? (
        outbox.map((message) => (
          <article key={message.id} className="space-y-2 border-t pt-3">
            <p>
              {queueStatusLabels[message.status]} ·{" "}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </p>
            <h4 className="font-semibold">
              <Trans>Original message</Trans>
            </h4>
            <p className="whitespace-pre-wrap">{message.body}</p>
            {message.polishedBody !== null ? (
              <>
                <h4 className="font-semibold">
                  <Trans>Polished message</Trans>
                </h4>
                <p className="whitespace-pre-wrap">{message.polishedBody}</p>
              </>
            ) : null}
            {message.error !== null ? (
              <>
                <p>
                  <Trans>There was a problem sending this message.</Trans>
                </p>
                {showDiagnostics ? (
                  <details>
                    <summary>
                      <Trans>Error details</Trans>
                    </summary>
                    <pre className="whitespace-pre-wrap">{message.error}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
            {message.sentAt !== null ? (
              <p>
                <Trans>Sent at</Trans>:{" "}
                <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time>
              </p>
            ) : null}
          </article>
        ))
      ) : (
        <p>
          <Trans>No recruiter messages were found.</Trans>
        </p>
      )}
    </section>
  ) : null;
  const contactReady = Boolean(contactRead?.data || contactRead?.failed);
  const contactKey = JSON.stringify([
    readCacheScope,
    browse.view,
    browse.view === "inbox" ? mailInput : detailsInput,
    browse.view === "inbox" ? selectedMail : undefined,
  ]);
  const revealContact = useCallback(() => {
    contactRegion.current?.scrollIntoView({ block: "start" });
    contactRegion.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!browse.candidateId || !["inbox", "feedback", "sequence"].includes(browse.view)) {
      revealedContact.current = null;
      return;
    }
    if (!contactReady || revealedContact.current === contactKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (!contactRegion.current) return;
      revealContact();
      revealedContact.current = contactKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [browse.candidateId, browse.view, contactKey, contactReady, revealContact]);
  const detail = useRecruitingDetail();
  function selectContact(
    id: string,
    view?: RecruitingWorkspaceView,
    person?: RecruitingDetailPerson,
  ) {
    // A role with its own workbench opens the person beside the page instead of switching tabs.
    if (detail && boundRole && person && (!view || view === "inbox")) {
      detail.open({ view: "thread", person, role: { ...boundRole, conversation: target } });
      return;
    }
    if (browse.view === (view ?? "inbox") && browse.candidateId === id && contactReady)
      revealContact();
    if (view) browse.onSelectCandidate(id, view);
    else browse.onSelectCandidate(id);
  }
  const selectedRole = page?.selectedRole;
  const roleJdUrl =
    selectedRole?.jdUrl && /^https?:\/\//i.test(selectedRole.jdUrl) ? selectedRole.jdUrl : null;
  const initialDescription = selectedRole
    ? [`${selectedRole.roleLabel} · ${selectedRole.clientLabel}`, selectedRole.jdText, roleJdUrl]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const crmHistory = (
    <>
      {agent ? (
        <h2 className="mt-8 mb-3 font-semibold">
          <Trans>Earlier history</Trans>
        </h2>
      ) : (
        <span className="hire-eyebrow">
          <Trans>Earlier history</Trans>
        </span>
      )}
      <div className="mb-5 flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
          <Trans>Refresh</Trans>
        </Button>
        {browse.onStartRecruiting ? (
          <Button
            disabled={!initialDescription || read?.loading || read?.failed}
            onClick={() => browse.onStartRecruiting?.(initialDescription)}
          >
            <Trans>Start recruiting</Trans>
          </Button>
        ) : null}
      </div>
      {read?.key !== key || read.loading ? (
        <p role="status" className="py-2 text-sm">
          <Shimmer>{t`Loading candidate records…`}</Shimmer>
        </p>
      ) : null}
      {read?.key === key && read.failed ? (
        <p role="alert">
          <Trans>Could not load candidate records. Try refreshing.</Trans>
        </p>
      ) : null}
      {page?.scope === "legacy_role_labels" && !importantView && browse.view !== "sequence" ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>
            Historical records matched to this client and role. These are not new search results or
            a verified shortlist.
          </Trans>
        </p>
      ) : null}
      {importantView ? (
        <section className="space-y-4">
          <h2 className="font-semibold">
            {browse.view === "interview" ? t`Interview workflow` : t`Important`}
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>Organization-wide candidate-role records.</Trans>
          </p>
          <NativeSelect
            aria-label={t`Workflow filter`}
            value={importantStatus}
            onChange={(event) => {
              setStatusSelection({
                view: browse.view,
                status: event.target.value as ImportantStatus | "",
              });
            }}
          >
            {browse.view !== "interview" ? (
              <NativeSelectOption value="">
                <Trans>All Important records</Trans>
              </NativeSelectOption>
            ) : null}
            {browse.view !== "interview" ? (
              <NativeSelectOption value="high_signal">
                <Trans>High signal</Trans>
              </NativeSelectOption>
            ) : null}
            {Object.entries(workflowLabels)
              .filter(
                ([status]) =>
                  browse.view !== "interview" ||
                  ["needs_scheduling", "scheduled", "awaiting_feedback"].includes(status),
              )
              .map(([status, label]) => (
                <NativeSelectOption key={status} value={status}>
                  {label}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          {!section || section.loading ? (
            <p role="status">
              <Trans>Loading candidate records…</Trans>
            </p>
          ) : null}
          {section?.failed ? (
            <p role="alert">
              <Trans>Could not load candidate records. Try refreshing.</Trans>
            </p>
          ) : null}
          {important ? (
            <>
              <p>
                <Plural
                  value={important.total}
                  _1="# candidate-role record"
                  other="# candidate-role records"
                />
              </p>
              <div className="hire-table-wrap overflow-x-auto">
                <table className="hire-table w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        t`Candidate`,
                        t`Client`,
                        t`Role`,
                        t`High signal`,
                        t`Workflow status`,
                        t`Updated`,
                        t`Messages`,
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {important.items.map((person) => (
                      <tr key={JSON.stringify([person.candidateId, person.roleKey])}>
                        <th scope="row">{person.name}</th>
                        <td>{person.clientLabel}</td>
                        <td>{person.roleLabel}</td>
                        <td>{person.highSignal ? t`High signal` : "—"}</td>
                        <td>
                          {person.workflowStatus ? workflowLabels[person.workflowStatus] : "—"}
                        </td>
                        <td>
                          {new Date(person.statusChangedAt ?? person.updatedAt).toLocaleString()}
                        </td>
                        <td>
                          <Button
                            variant="link"
                            onClick={() => selectContact(person.candidateId, undefined, person)}
                          >
                            <Trans>View messages</Trans>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!important.items.length ? (
                <p>
                  <Trans>No Important records matched this filter.</Trans>
                </p>
              ) : null}
            </>
          ) : null}
          <div className="flex gap-2">
            {sectionOffset > 0 ? (
              <Button
                variant="outline"
                onClick={() =>
                  setSectionPage({ key: sectionScope, offset: Math.max(0, sectionOffset - 30) })
                }
              >
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {important?.nextOffset != null ? (
              <Button
                variant="outline"
                onClick={() => setSectionPage({ key: sectionScope, offset: important.nextOffset! })}
              >
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "interview" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Calendar booking details are not included in these manual CRM workflow records.
              </Trans>
            </p>
          ) : null}
        </section>
      ) : browse.view === "brief" ? (
        <section className="space-y-4">
          {selectedRole &&
          ![selectedRole.summary, selectedRole.description, selectedRole.jdText, roleJdUrl].some(
            (value) => value?.trim(),
          ) ? (
            <p>
              <Trans>
                No job description is saved for this role. Add a JD or link when starting
                recruiting.
              </Trans>
            </p>
          ) : null}
          {page?.selectedRole?.summary ? <p>{page.selectedRole.summary}</p> : null}
          {page?.selectedRole?.description ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.description}</p>
          ) : null}
          {page?.selectedRole?.jdText ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.jdText}</p>
          ) : null}
          {roleJdUrl ? (
            <a className="underline" href={roleJdUrl} target="_blank" rel="noreferrer">
              <Trans>Original job description</Trans>
            </a>
          ) : null}
        </section>
      ) : (
        <>
          {browse.view === "sequence" ? (
            <section className="mb-6 space-y-4">
              <h2 className="font-semibold">
                <Trans>Role campaigns</Trans>
              </h2>
              {!browse.selection.crmRoleId ? (
                <p>
                  <Trans>Choose a role to see its outreach.</Trans>
                </p>
              ) : !section || section.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {section?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {campaigns ? (
                <>
                  <div className="hire-table-wrap overflow-x-auto">
                    <table className="hire-table w-full text-left text-sm">
                      <thead>
                        <tr>
                          {[t`Campaign`, t`Provider status code`, t`Last synced`].map((label) => (
                            <th scope="col" key={label}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {campaigns.items.map((campaign) => (
                          <tr key={campaign.id}>
                            <th scope="row">{campaign.name}</th>
                            <td>{campaign.status ?? "—"}</td>
                            <td>{new Date(campaign.syncedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!campaigns.items.length ? (
                    <p>
                      <Trans>No stored campaign associations were returned for this role.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {sectionOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({
                            key: sectionScope,
                            offset: Math.max(0, sectionOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous campaigns</Trans>
                      </Button>
                    ) : null}
                    {campaigns.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({ key: sectionScope, offset: campaigns.nextOffset! })
                        }
                      >
                        <Trans>Next campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Sequence steps and delivery status are not included in these stored campaign
                  associations.
                </Trans>
              </p>
            </section>
          ) : null}
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              setQuery(queryDraft.trim());
            }}
          >
            <Input
              aria-label={t`Search contacts`}
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Trans>Search</Trans>
            </Button>
          </form>
          {page ? (
            <p className="mb-3 text-sm">
              <Plural value={page.total} _1="# contact" other="# contacts" />
            </p>
          ) : null}
          {page ? (
            <div className="hire-table-wrap overflow-x-auto">
              <table className="hire-table w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      t`Candidate`,
                      t`Current role`,
                      t`Email`,
                      t`Phone`,
                      t`Stage`,
                      t`Contact status`,
                      t`Outreach status`,
                      browse.view === "feedback" || browse.view === "sequence"
                        ? t`Details`
                        : t`Messages`,
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.candidateId}>
                      <th scope="row">
                        {person.name}
                        {person.linkedinUrl && /^https?:\/\//i.test(person.linkedinUrl) ? (
                          <a
                            className="block text-xs underline"
                            href={person.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Trans>LinkedIn</Trans>
                          </a>
                        ) : null}
                      </th>
                      <td>
                        {person.title ?? "—"}
                        {person.location ? (
                          <small className="block">{person.location}</small>
                        ) : null}
                      </td>
                      <td>{person.email ?? "—"}</td>
                      <td>{person.phone ?? "—"}</td>
                      <td>{person.stage ?? "—"}</td>
                      <td>{person.contactStatus || "—"}</td>
                      <td>{person.outreachStatus || "—"}</td>
                      <td>
                        <Button
                          variant="link"
                          onClick={() =>
                            browse.view === "feedback" || browse.view === "sequence"
                              ? selectContact(person.candidateId, browse.view)
                              : selectContact(person.candidateId, undefined, person)
                          }
                        >
                          {browse.view === "feedback" || browse.view === "sequence" ? (
                            <Trans>View details</Trans>
                          ) : (
                            <Trans>View messages</Trans>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {page && !people.length ? (
            <p>
              <Trans>No records matched this search.</Trans>
            </p>
          ) : null}
          <div className="my-4 flex gap-2">
            {offset > 0 ? (
              <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 30))}>
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {page?.nextOffset !== null && page?.nextOffset !== undefined ? (
              <Button variant="outline" onClick={() => setOffset(page.nextOffset!)}>
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "feedback" || browse.view === "sequence" ? (
            <section
              ref={contactRegion}
              aria-labelledby={contactHeadingId}
              tabIndex={-1}
              className="my-6 space-y-4"
            >
              <h2 id={contactHeadingId} className="font-semibold">
                {selectedPerson?.name ?? details?.review?.candidateName ?? t`Candidate details`}
              </h2>
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored details.</Trans>
                </p>
              ) : !currentDetails || currentDetails.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {currentDetails?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {details && browse.view === "feedback" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Role interest</Trans>
                  </h3>
                  {details.roleInterests.length ? (
                    <div className="hire-table-wrap overflow-x-auto">
                      <table className="hire-table w-full text-left text-sm">
                        <thead>
                          <tr>
                            {[t`Client`, t`Role`, t`Interest`, t`Source`].map((label) => (
                              <th scope="col" key={label}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {details.roleInterests.map((interest) => (
                            <tr key={interest.roleKey}>
                              <th scope="row">{interest.clientLabel}</th>
                              <td>{interest.roleLabel}</td>
                              <td>
                                {interest.interest === "interested"
                                  ? t`Interested`
                                  : interest.interest === "declined"
                                    ? t`Declined`
                                    : t`Unknown`}
                              </td>
                              <td>
                                {interest.source === "manual"
                                  ? t`Human-entered`
                                  : interest.source === "ai"
                                    ? t`AI interpretation`
                                    : interest.source === "instantly"
                                      ? t`Email reply`
                                      : t`Unknown`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      <Trans>No stored role-interest records were returned.</Trans>
                    </p>
                  )}
                  <h3 className="font-semibold">
                    <Trans>Internal review</Trans>
                  </h3>
                  {details.review ? (
                    <div className="space-y-2">
                      {details.review.roleTitle ? <p>{details.review.roleTitle}</p> : null}
                      <p>
                        {details.review.stage ?? "—"} ·{" "}
                        {details.review.reviewed === true
                          ? t`Reviewed`
                          : details.review.reviewed === false
                            ? t`Not reviewed`
                            : t`Review status unknown`}
                      </p>
                      {details.review.result ? (
                        <p>
                          {details.review.result === "approved"
                            ? t`Approved in internal review`
                            : details.review.result === "rejected"
                              ? t`Rejected in internal review`
                              : t`Pooled in internal review`}
                        </p>
                      ) : null}
                      {details.review.notes ? (
                        <p className="whitespace-pre-wrap">{details.review.notes}</p>
                      ) : null}
                    </div>
                  ) : (
                    <p>
                      <Trans>No internal review was returned.</Trans>
                    </p>
                  )}
                </>
              ) : null}
              {details && browse.view === "sequence" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Contact campaign associations</Trans>
                  </h3>
                  {details.campaignAssociations.pipelineCampaign ? (
                    <p>
                      {details.campaignAssociations.pipelineCampaign.name} ·{" "}
                      <Trans>Primary pipeline campaign</Trans>
                    </p>
                  ) : null}
                  {details.campaignAssociations.leadCampaigns.map((association) => (
                    <p key={association.leadId}>
                      {association.campaign?.name ?? t`Campaign details unavailable`}
                      {association.campaign ? (
                        <>
                          {" "}
                          · <Trans>Provider status code</Trans>:{" "}
                          {association.campaign.status ?? "—"}
                        </>
                      ) : null}
                    </p>
                  ))}
                  {!details.campaignAssociations.pipelineCampaign &&
                  !details.campaignAssociations.leadCampaigns.length ? (
                    <p>
                      <Trans>No contact campaign associations were returned.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {detailsOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: Math.max(0, detailsOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous contact campaigns</Trans>
                      </Button>
                    ) : null}
                    {details.campaignAssociations.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: details.campaignAssociations.nextOffset!,
                          })
                        }
                      >
                        <Trans>Next contact campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              {outboxContent}
            </section>
          ) : null}
          {browse.view === "inbox" ? (
            <section ref={contactRegion} aria-labelledby={contactHeadingId} tabIndex={-1}>
              <h2 id={contactHeadingId} className="mb-3 font-semibold">
                {selectedPerson?.name ?? t`Candidate messages`}
              </h2>
              {browse.onDraftReply && draftEmail && browse.candidateId ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const person =
                      read?.key === key && !read.loading && !read.failed
                        ? selectedPerson
                        : undefined;
                    browse.onDraftReply?.({
                      threadId,
                      candidateId: browse.candidateId!,
                      ...(person
                        ? { candidateName: person.name, candidateEmail: person.email }
                        : {}),
                      email: {
                        sender: draftEmail.sender,
                        recipients: draftEmail.recipients,
                        subject: draftEmail.subject,
                        date: draftEmail.date,
                      },
                      source: {
                        serverId: browse.selection.serverId,
                        serverRevision: browse.selection.serverRevision,
                        organizationId: browse.selection.organizationId,
                      },
                      ...(browse.selection.crmRoleId
                        ? { crmRoleId: browse.selection.crmRoleId }
                        : {}),
                    });
                  }}
                >
                  <Trans>Draft reply</Trans>
                </Button>
              ) : null}
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored messages.</Trans>
                </p>
              ) : !currentMail || (!currentMail.data && !currentMail.failed) ? (
                <p role="status">
                  <Trans>Loading stored messages…</Trans>
                </p>
              ) : currentMail.failed ? (
                <p role="alert">
                  <Trans>Could not load stored messages. Try refreshing.</Trans>
                </p>
              ) : mailPage ? (
                <>
                  {inboxEmails.length ? (
                    <>
                      <p className="my-3 text-sm text-muted-foreground">
                        {selectedNativeMail?.email?.sourceName ?? mailPage.source.name}
                        {selectedNativeMail ? (
                          <> · {nativeMailStatus[selectedNativeMail.status]}</>
                        ) : null}
                      </p>
                      <CorrespondenceEmails
                        emails={inboxEmails}
                        selectedId={selectedInboxEmail?.id}
                        onSelect={setSelectedMail}
                      />
                    </>
                  ) : (
                    <p>
                      <Trans>No stored messages were returned for this contact.</Trans>
                    </p>
                  )}
                  {nativeMail
                    .filter((entry) => entry.status === "unknown")
                    .map((entry) => (
                      <p key={entry.id} role="status" className="my-3 text-sm">
                        {nativeMailStatus.unknown} ·{" "}
                        <time dateTime={entry.checkedAt}>
                          {new Date(entry.checkedAt).toLocaleString()}
                        </time>
                      </p>
                    ))}
                  {mailCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(undefined)}>
                      <Trans>Latest messages</Trans>
                    </Button>
                  ) : null}
                  {mailPage.nextCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(mailPage.nextCursor!)}>
                      <Trans>Older messages</Trans>
                    </Button>
                  ) : null}
                </>
              ) : null}
              {outboxContent}
            </section>
          ) : null}
        </>
      )}
    </>
  );
  const body = (
    <>
      {agent}
      {crmHistory}
    </>
  );
  return (
    <div className="hire-standard-view">
      <header className="hire-section-header">
        <h1>
          {bound.title ??
            (bound.done
              ? (page?.selectedRole?.roleLabel ??
                (read?.key === key && !read.loading ? t`Contacts` : null))
              : null)}
        </h1>
        {page?.selectedRole ? <p>{page.selectedRole.clientLabel}</p> : null}
      </header>
      {browse.view === "contacts" && agent ? (
        <>
          {agent}
          {bound.done && !bound.role ? crmHistory : null}
        </>
      ) : ["sequence", "inbox", "interview"].includes(browse.view) ? (
        <>
          {agent}
          <CorrespondenceTabMount
            view={browse.view}
            role={boundRole}
            loading={!bound.done}
            conversation={target}
            refreshSignal={refreshSignal + refresh}
            onDraftReply={
              browse.onDraftReply
                ? ({ email, ...context }) =>
                    browse.onDraftReply?.({
                      ...context,
                      threadId,
                      email: {
                        sender: email.sender,
                        recipients: email.recipients,
                        subject: email.subject,
                        date: email.date,
                      },
                    })
                : undefined
            }
            fallback={agent ? crmHistory : body}
          />
        </>
      ) : (
        body
      )}
    </div>
  );
}

function NativeRecruitingPanel(props: Props) {
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
  groupId,
  readCache,
  readCacheScope,
  refreshSignal,
  onClose,
  onBrowseCandidates,
  onRevealMessage,
  onDiscussCandidate,
  onCandidateFeedback,
  candidateFeedbackRecipients,
  showDiagnostics = false,
  presentation = "panel",
  summary,
  view = "results",
  tab,
  onTabChange,
}: Props & { userId?: string }) {
  const { t } = useLingui();
  const shortlistFilterId = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const workspaceCacheKey = readCacheScope ? `${readCacheScope}:workspace` : undefined;
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Pick<Snapshot, "workspace"> | null>(
    () =>
      workspaceCacheKey
        ? ((readCache?.entries.get(workspaceCacheKey) as Pick<Snapshot, "workspace"> | undefined) ??
          null)
        : null,
  );
  const initialStorageKey =
    workspaceSnapshot?.workspace && userId
      ? `${rightPanelStorageKey(userId, workspaceSnapshot.workspace.role.spaceId, botId ? "bot" : "group", threadId)}:recruiting:${workspaceSnapshot.workspace.role.id}`
      : null;
  const [refresh, setRefresh] = useState(0);
  const workspaceReadKey = JSON.stringify([threadId, refresh, refreshSignal]);
  const [validatedWorkspaceRead, setValidatedWorkspaceRead] = useState<string>();
  const [feedbackRefresh, setFeedbackRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmationFailed, setConfirmationFailed] = useState(false);
  const [candidateList, setCandidateList] = useState(() =>
    readRecruitingPanelState(initialStorageKey),
  );
  const activeTab = tab ?? (presentation === "workspace" ? "evidence" : candidateList.tab);
  const contactsView = presentation === "workspace" && view === "contacts";
  const shortlistView = presentation === "workspace" && view === "shortlist";
  const candidateWorkspace =
    presentation === "workspace" && !showDiagnostics && activeTab === "evidence" && !summary;
  const requestedTab = useRef(tab);
  requestedTab.current = tab;
  useEffect(() => {
    if (tab) setCandidateList((current) => (current.tab === tab ? current : { ...current, tab }));
  }, [tab]);
  useEffect(() => {
    if (workspaceSnapshot) onTabChange?.(activeTab);
  }, [activeTab, workspaceSnapshot, onTabChange]);
  const [candidateStorageKey, setCandidateStorageKey] = useState<string | null>(initialStorageKey);
  const tabsList = useRef<HTMLDivElement>(null);
  const {
    candidateView: storedCandidateView,
    filters: storedCandidateFilters,
    detailOpen: candidateDetailOpen,
  } = candidateList;
  const candidateView = contactsView ? "table" : storedCandidateView;
  const candidateFilters = useMemo(
    () =>
      presentation === "workspace" && view === "shortlist"
        ? { ...storedCandidateFilters, shortlisted: true as const }
        : storedCandidateFilters,
    [presentation, view, storedCandidateFilters],
  );
  // Every returned candidate keeps Autumn's own result fields in the workspace table.
  const candidateTableDetails = presentation === "workspace" && !contactsView;
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
  const candidateReadAbort = useRef<AbortController | null>(null);
  const previousCandidateSearch = useRef<{ scope: string; query?: string } | undefined>(undefined);
  const loadingMore = useRef(false);
  const readEpoch = useRef(0);
  const candidateValidation = useRef<number | undefined>(undefined);
  const candidateValidatedRead = useRef<string | undefined>(undefined);
  const displayedCandidateQuery = useRef<string | undefined>(undefined);
  const denyAccess = useCallback(
    (error: unknown) => {
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
      clearRecruitingReads(readCache, readCacheScope);
      candidateGeneration.current++;
      setSnapshot(null);
      setWorkspaceSnapshot(null);
      setCandidatePage(null);
      setSelection(null);
      setCandidateList((current) => ({
        ...current,
        selectedCandidateKey: null,
        detailOpen: false,
      }));
      candidateHandoff.current = null;
      setSelectedEvidence(null);
      setCriteriaEdit(null);
      shortlistMutation.current = null;
      setShortlistPending(null);
      setFailed(true);
      editScope.current.roleId = null;
      editScope.current.generation++;
    },
    [readCache, readCacheScope],
  );
  const [criteriaEdit, setCriteriaEdit] = useState<CriteriaEdit | null>(null);
  const [savingCriteria, setSavingCriteria] = useState(false);
  const [criteriaFailed, setCriteriaFailed] = useState(false);
  const editScope = useRef({
    active: true,
    roleId: workspaceSnapshot?.workspace?.role.id ?? (null as string | null),
    generation: 0,
  });
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
    let cacheEpoch = readCache?.epoch;
    setLoading(true);
    setFailed(false);
    const updateEditScope = (workspace: Snapshot["workspace"]) => {
      const roleId = workspace?.role.id ?? null;
      if (editScope.current.roleId === roleId) return;
      const changingRole = editScope.current.roleId !== null;
      if (changingRole) {
        clearRecruitingReads(readCache, readCacheScope);
        cacheEpoch = readCache?.epoch;
      }
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
    const abort = new AbortController();
    /** Retries a deploy's or an edge's transient failure before reporting it. */
    const read = <T,>(call: () => Promise<T>) =>
      retryTransientRead(call, abort.signal).catch(onReadError);
    async function load() {
      try {
        let workspace = await read(() => rpc.recruiting.getWorkspace({ threadId }));
        while (!cancelled && epoch === readEpoch.current) {
          updateEditScope(workspace);
          setSnapshot((current) =>
            current?.workspace?.role.id !== workspace?.role.id ||
            current?.workspace?.revision.id !== workspace?.revision.id
              ? null
              : current,
          );
          setWorkspaceSnapshot((current) =>
            current && JSON.stringify(current.workspace) === JSON.stringify(workspace)
              ? current
              : { workspace },
          );
          rememberRecruitingRead(readCache, workspaceCacheKey, { workspace }, cacheEpoch);
          setValidatedWorkspaceRead(workspaceReadKey);
          if (summary) return;
          const roleId = workspace?.role.id;
          const [assessments, research, questions, documents] = await Promise.all([
            roleId && !candidateWorkspace
              ? read(() => rpc.recruiting.listAssessments({ roleId }))
              : Promise.resolve([]),
            roleId
              ? read(() => rpc.recruiting.listResearch({ roleId }))
              : Promise.resolve({ tasks: [], actions: [], observations: [] }),
            roleId && !candidateWorkspace
              ? read(() => rpc.recruiting.listQuestions({ threadId, roleId }))
              : Promise.resolve({ questions: [] }),
            candidateWorkspace
              ? Promise.resolve([])
              : Promise.all([
                  read(() => rpc.memory.list({ scope: "user" })),
                  ...(botId ? [read(() => rpc.memory.list({ scope: "bot", botId }))] : []),
                ]).then((lists) => lists.flat()),
          ]);
          if (cancelled || epoch !== readEpoch.current) return;
          const verified = await read(() => rpc.recruiting.getWorkspace({ threadId }));
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
      abort.abort();
    };
  }, [
    userId,
    threadId,
    botId,
    refresh,
    refreshSignal,
    denyAccess,
    summary,
    candidateWorkspace,
    readCache,
    workspaceCacheKey,
    workspaceReadKey,
  ]);
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
  const showInternalAssessments =
    showDiagnostics ||
    assessments.length > 0 ||
    (candidateWorkspace &&
      ((candidatePage?.counts.assessed ?? 0) > 0 ||
        candidateFilters.assessmentState !== undefined ||
        candidateFilters.verdict !== undefined));
  const retainInternalAssessmentFilters =
    candidateWorkspace || showInternalAssessments || !snapshot;
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
  const candidateQueryKey = JSON.stringify([
    userId,
    threadId,
    roleId,
    roleRevisionId,
    candidateRequestFilters,
  ]);
  const candidateFresh =
    !candidateLoading &&
    !candidateFailed &&
    validatedWorkspaceRead === workspaceReadKey &&
    candidateValidatedRead.current === `${workspaceReadKey}:${candidateQueryKey}` &&
    (!readCache || candidateValidation.current === readCache.epoch);
  const candidatesCacheKey =
    readCacheScope && roleId && roleRevisionId
      ? `${readCacheScope}:candidates:${JSON.stringify([roleId, roleRevisionId, candidateRequestFilters])}`
      : undefined;
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
  const userSortRef = useRef(candidateList.userSort === true);
  userSortRef.current = candidateList.userSort === true;
  const resetUnavailableCandidateSort = useCallback(
    (page: ListRecruitingCandidatesOutput, filters: RecruitingPanelState["filters"]) => {
      const sort = filters.sort ?? "score";
      // A list that was sorted by a fallback returns to score order once scores exist.
      if (!userSortRef.current && sort !== "score" && page.sortAvailability.score) {
        setCandidatePage(null);
        setCandidateList((current) => ({
          ...current,
          filters: { ...current.filters, sort: "score" },
          pageCount: 1,
        }));
        return true;
      }
      if (
        (sort === "rank" || sort === "tier" || sort === "score") &&
        !page.sortAvailability[sort]
      ) {
        // Keep the provider's ordering when one exists: score, then rank, then tier, then name.
        const fallback =
          (["score", "rank", "tier"] as const).find((key) => page.sortAvailability[key]) ?? "name";
        setCandidatePage(null);
        setCandidateList((current) => ({
          ...current,
          filters: { ...current.filters, sort: fallback },
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
    const cacheEpoch = readCache?.epoch;
    const isCurrent = () =>
      !cancelled &&
      generation === candidateGeneration.current &&
      epoch === readEpoch.current &&
      (!readCache || cacheEpoch === readCache.epoch);
    loadingMore.current = false;
    setCandidateLoading(!!roleId && validatedWorkspaceRead === workspaceReadKey);
    setCandidateFailed(false);
    const retainCandidatePage = displayedCandidateQuery.current === candidateQueryKey;
    setCandidatePage(
      (current) =>
        (candidatesCacheKey
          ? (readCache?.entries.get(candidatesCacheKey) as
              | ListRecruitingCandidatesOutput
              | undefined)
          : undefined) ?? (retainCandidatePage ? current : null),
    );
    displayedCandidateQuery.current = candidateQueryKey;
    if (!roleId || summary || validatedWorkspaceRead !== workspaceReadKey) return;
    const query = candidateQuery.current;
    const abort = new AbortController();
    candidateReadAbort.current = abort;
    const scope = JSON.stringify([userId, threadId, roleId, roleRevisionId]);
    const queryChanged =
      previousCandidateSearch.current?.scope === scope &&
      previousCandidateSearch.current.query !== candidateRequestFilters.query;
    previousCandidateSearch.current = { scope, query: candidateRequestFilters.query };
    const load = async () => {
      let page = await rpc.recruiting.listCandidates(
        {
          roleId,
          limit: 30,
          ...candidateRequestFilters,
        },
        { signal: abort.signal },
      );
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
      candidateValidation.current = cacheEpoch;
      candidateValidatedRead.current = `${workspaceReadKey}:${candidateQueryKey}`;
      setCandidatePage(page);
      rememberRecruitingRead(
        readCache,
        candidatesCacheKey,
        { ...page, crmTarget: null, items: page.items.map((item) => ({ ...item, crm: null })) },
        cacheEpoch,
      );
      setCandidateList((current) => ({ ...current, pageCount: 1 }));
      let pageCount = 1;
      // ponytail: replay saved page depth with fresh cursors; cached rows are display-only until verified.
      for (let index = 1; index < query.pageCount && page.nextCursor; index++) {
        if (!isCurrent()) return;
        const next = await rpc.recruiting.listCandidates(
          {
            roleId,
            limit: 30,
            ...candidateRequestFilters,
            cursor: page.nextCursor,
          },
          { signal: abort.signal },
        );
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
        rememberRecruitingRead(
          readCache,
          candidatesCacheKey,
          { ...page, crmTarget: null, items: page.items.map((item) => ({ ...item, crm: null })) },
          cacheEpoch,
        );
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
          const selectedPage = await rpc.recruiting.listCandidates(
            {
              roleId,
              limit: 30,
              query: selectedCandidateKey,
              ...(sourceEffectId !== undefined ? { sourceEffectId } : {}),
              ...(actionId !== undefined ? { actionId } : {}),
              ...(cursor ? { cursor } : {}),
            },
            { signal: abort.signal },
          );
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
    };
    const start = () =>
      void load()
        .catch((error: unknown) => {
          if (
            cancelled ||
            generation !== candidateGeneration.current ||
            epoch !== readEpoch.current
          )
            return;
          denyAccess(error);
          if (generation === candidateGeneration.current && epoch === readEpoch.current)
            setCandidateFailed(true);
        })
        .finally(() => {
          if (
            !cancelled &&
            generation === candidateGeneration.current &&
            epoch === readEpoch.current
          )
            setCandidateLoading(false);
        });
    const timer = queryChanged ? setTimeout(start, 250) : undefined;
    if (timer === undefined) start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
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
    summary,
    candidatesCacheKey,
    candidateQueryKey,
    readCache,
    workspaceReadKey,
    validatedWorkspaceRead,
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
  function discussCandidate(
    candidate: RecruitingCandidate,
    intent: CandidateDiscussionContext["intent"],
  ) {
    if (
      !workspace ||
      !onDiscussCandidate ||
      !candidateFresh ||
      (readCache && candidateValidation.current !== readCache.epoch)
    )
      return;
    onDiscussCandidate({
      threadId,
      roleTitle: workspace.role.title,
      roleId: workspace.role.id,
      roleRevisionId: workspace.revision.id,
      roleVersion: workspace.revision.revision,
      candidateKey: candidate.candidateKey,
      name: candidate.name,
      title: candidate.title,
      company: candidate.company,
      linkedinUrl: candidate.linkedinUrl,
      resumeUrl: candidate.resumeUrl,
      intent,
    });
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
    const signal = candidateReadAbort.current?.signal;
    loadingMore.current = true;
    setCandidateLoading(true);
    setCandidateFailed(false);
    try {
      const page = await rpc.recruiting.listCandidates(
        {
          roleId,
          limit: 30,
          ...candidateRequestFilters,
          cursor: candidatePage.nextCursor,
        },
        { signal },
      );
      if (
        signal?.aborted ||
        generation !== candidateGeneration.current ||
        epoch !== readEpoch.current
      )
        return;
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
      if (
        !signal?.aborted &&
        generation === candidateGeneration.current &&
        epoch === readEpoch.current
      ) {
        denyAccess(error);
        setCandidateFailed(true);
      }
    } finally {
      if (
        !signal?.aborted &&
        generation === candidateGeneration.current &&
        epoch === readEpoch.current
      ) {
        loadingMore.current = false;
        setCandidateLoading(false);
      }
    }
  }
  async function setShortlist(candidate: RecruitingCandidate, shortlisted: boolean) {
    if (
      shortlistMutation.current ||
      !candidateFresh ||
      (readCache && candidateValidation.current !== readCache.epoch)
    )
      return;
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
      clearRecruitingReads(readCache, readCacheScope);
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
      // Reuse the role-verified loader for authoritative counts after this saved change.
      setRefresh((value) => value + 1);
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
      loading ||
      failed ||
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
  if (summary) {
    const CriteriaBody = summary === "feedback" ? "details" : "div";
    return (
      <section
        className="hire-live-criteria"
        aria-label={summary === "brief" ? t`Search Criteria` : t`Client feedback`}
      >
        <div className="hire-panel-heading">
          {summary === "brief" ? (
            <BriefcaseBusiness size={18} aria-hidden />
          ) : (
            <Building2 size={18} aria-hidden />
          )}
          <div>
            <strong>
              {summary === "brief" ? (
                <Trans>Search Criteria</Trans>
              ) : (
                <Trans>Client feedback</Trans>
              )}
            </strong>
            <span>
              {summary === "brief" ? (
                <Trans>From this role’s saved requirements</Trans>
              ) : (
                <Trans>Saved feedback for this role</Trans>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Refresh criteria`}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} aria-hidden />
          </Button>
        </div>
        {failed ? (
          <p role="alert" className="hire-source-hint">
            <Trans>Could not load recruiting. Refresh to try again.</Trans>
          </p>
        ) : loading && !workspaceSnapshot ? (
          <p role="status" className="hire-source-hint">
            <Trans>Loading…</Trans>
          </p>
        ) : workspace ? (
          <>
            <div className="hire-jd-summary">
              <strong>{workspace.role.title}</strong>
            </div>
            {summary === "feedback" ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + refresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
                showEmpty
              />
            ) : null}
            <CriteriaBody className={summary === "feedback" ? "hire-criterion-row" : "contents"}>
              {summary === "feedback" ? (
                <summary>
                  <Trans>Search Criteria</Trans>
                </summary>
              ) : null}
              {brief?.fields
                .filter((field) => field.value !== null)
                .map((field) => (
                  <div className="hire-criterion-row" key={field.key}>
                    {Object.hasOwn(briefFieldLabels, field.key) ? (
                      <span>{briefFieldLabels[field.key]}</span>
                    ) : null}
                    <strong className="whitespace-pre-wrap">{field.value}</strong>
                    {field.state === "conflict" ? (
                      <span>
                        <Trans>Conflicting information</Trans>
                      </span>
                    ) : field.state !== "known" ? (
                      <span>
                        <Trans>Unknown</Trans>
                      </span>
                    ) : null}
                    {field.origin === "inferred" ? (
                      <span>
                        <Trans>Assumption</Trans>
                      </span>
                    ) : null}
                  </div>
                ))}
              {brief?.searchFilters.map((filter) => (
                <div className="hire-criterion-row" key={filter.id}>
                  <span>
                    {filter.mode === "include" ? (
                      <Trans>Include</Trans>
                    ) : filter.mode === "exclude" ? (
                      <Trans>Exclude</Trans>
                    ) : (
                      <Trans>Prefer</Trans>
                    )}
                  </span>
                  <strong>{filter.statement}</strong>
                </div>
              ))}
              {criteria.map((criterion) => (
                <div className="hire-criterion-row" key={criterion.id}>
                  <span>
                    {criterion.priority === "hard" ? (
                      <Trans>Required</Trans>
                    ) : (
                      <Trans>Preferred</Trans>
                    )}
                  </span>
                  <CriteriaExpression expression={criterion.expression} />
                </div>
              ))}
              {workspace.revision.preferences.length ? (
                <div className="hire-criterion-row">
                  <span>
                    <Trans>Preferences</Trans>
                  </span>
                  <ul>
                    {workspace.revision.preferences.map((preference) => (
                      <li key={preference}>{preference}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!brief?.fields.some((field) => field.value !== null) &&
              !brief?.searchFilters.length &&
              !criteria.length &&
              !workspace.revision.preferences.length ? (
                <p className="hire-source-hint">
                  <Trans>
                    Share the role requirements in the conversation to build this brief.
                  </Trans>
                </p>
              ) : null}
              {roleSources.length ? (
                <details className="hire-criterion-row">
                  <summary>
                    <Trans>Role sources</Trans>
                  </summary>
                  <Sources
                    sourceTarget={{ kind: "role", threadId, roleRevisionId: workspace.revision.id }}
                    sources={roleSources}
                    showDiagnostics={false}
                  />
                </details>
              ) : null}
            </CriteriaBody>
            <p className="hire-source-hint">
              <Check size={15} aria-hidden />
              <Trans>Requirements and feedback stay with this role.</Trans>
            </p>
          </>
        ) : (
          <p className="hire-source-hint">
            <Trans>No role linked yet. Describe the role in this conversation.</Trans>
          </p>
        )}
      </section>
    );
  }
  return (
    <section
      aria-label={t`Recruiting`}
      className={
        presentation === "workspace"
          ? "hire-recruiting-workspace space-y-4 text-sm"
          : "space-y-4 text-sm"
      }
    >
      {shortlistView || contactsView ? (
        <header className="hire-section-header">
          <h1>{shortlistView ? <Trans>Shortlist</Trans> : <Trans>Contacts</Trans>}</h1>
          {workspace ? <p>{workspace.role.title}</p> : null}
          {candidatePage ? (
            <p>
              <Plural
                value={candidatePage.counts.candidates}
                _1="# candidate in the pool"
                other="# candidates in the pool"
              />
            </p>
          ) : null}
        </header>
      ) : null}
      {presentation !== "workspace" ? (
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
      ) : null}
      {failed ? (
        <RetryNotice onRetry={() => setRefresh((value) => value + 1)}>
          <Trans>Could not load recruiting</Trans>
        </RetryNotice>
      ) : loading &&
        (!workspaceSnapshot ||
          ["dashboard", "missing", "memory", "activity"].includes(activeTab)) ? (
        <TabLoading />
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
          {presentation !== "workspace" ? (
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
          ) : null}
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
                    {workspace.revision.brief.confirmation?.revision !==
                      workspace.revision.revision &&
                      roleQuestions.map((question) => (
                        <p key={question} className="text-sm text-muted-foreground">
                          {question}
                        </p>
                      ))}
                    {workspace.revision.brief.confirmation?.revision ===
                    workspace.revision.revision ? (
                      <p>
                        <Trans>Brief confirmed</Trans>
                      </p>
                    ) : (
                      <Button
                        disabled={
                          loading ||
                          failed ||
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
                          loading ||
                          failed ||
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
                <div
                  className={
                    presentation === "workspace"
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
                    roleId={workspace.role.id}
                    spaceId={workspace.role.spaceId}
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
                      setShortlist: (candidate, shortlisted) =>
                        void setShortlist(candidate, shortlisted),
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
                      <ul
                        className={presentation === "workspace" ? "hire-card-grid" : "grid gap-2"}
                      >
                        {candidatePage.items.map((candidate) => (
                          <li key={candidate.candidateKey}>
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
                                onShortlist={() =>
                                  void setShortlist(candidate, !candidate.shortlisted)
                                }
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
                                  <td className="py-2 pe-3 tabular-nums">
                                    {candidate.discoveryCount}
                                  </td>
                                ) : null}
                                <td className="py-2">
                                  <Checkbox
                                    aria-label={t`Shortlist ${candidate.name ?? (showDiagnostics ? candidate.candidateKey : t`Unnamed candidate`)}`}
                                    checked={candidate.shortlisted}
                                    disabled={shortlistPending !== null || !candidateFresh}
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
                readCache={readCache}
                readCacheScope={readCacheScope}
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
    </section>
  );
}
