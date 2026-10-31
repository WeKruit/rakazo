import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingAccountViewOutput,
  RecruitingCorrespondenceReference,
  RecruitingOutreachSequence,
  RecruitingCorrespondence as SavedCorrespondence,
  ThreadMessage,
} from "@rakazo/contracts";
import {
  RecruitingCorrespondenceReferenceSchema,
  RecruitingOutreachSequenceSchema,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowRight, CalendarDays, ChevronRight, Inbox, Mail, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import type { ArtifactTarget } from "../lib/artifact-open";
import { fetchArtifactBytes } from "../lib/artifact-open";
import { retryTransientRead } from "../lib/read-retry";
import type { RecruitingReadCache } from "../lib/recruiting-read-cache";
import {
  clearRecruitingReads,
  rememberRecruitingRead,
  savedRecruitingRead,
} from "../lib/recruiting-read-cache";
import { rpc } from "../lib/rpc";
import { AvailabilityRanges } from "./recruiting/AvailabilityRanges";
import { useRecruitingDetail } from "./recruiting/detail";
import { EmailConversation } from "./recruiting/EmailConversation";
import type { SchedulingPlanHandoff } from "./recruiting/SchedulingPlan";
import { SchedulingPlanForm, SchedulingPlanHistory } from "./recruiting/SchedulingPlan";
import { sequenceLine, useSequenceLabels, useSequenceStats } from "./recruiting/SequenceStats";
import { RoleCampaignCard } from "./recruiting/SequenceTab";
import { LoadMore, type RoleCrm, useCrmPages, useKeyedRead } from "./recruiting/shared";

export type RecruitingSequenceSaveInput = {
  sourceArtifactId: string;
  name: string;
  sequence: RecruitingOutreachSequence;
  clientNonce: string;
};

type Props = {
  view: "sequence" | "inbox" | "interview";
  messages: readonly ThreadMessage[];
  artifactTarget: ArtifactTarget;
  threadId?: string;
  outreachBotIds?: readonly string[];
  onConversation: (text?: string) => void;
  onEmailSelection?: (reference: RecruitingCorrespondenceReference | undefined) => void;
  onReviewSchedulingPlan?: (handoff: SchedulingPlanHandoff) => void;
  onOpenConnections: () => void;
  onSaveDraft?: (input: RecruitingSequenceSaveInput) => Promise<void>;
  page?: RecruitingAccountViewOutput["items"][number];
  refreshSignal?: number;
  readCache?: RecruitingReadCache;
  readCacheScope?: string;
};

function SequenceEditor({
  document,
  artifactId,
  name,
  onSave,
}: {
  document: RecruitingOutreachSequence;
  artifactId: string;
  name: string;
  onSave?: Props["onSaveDraft"];
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => structuredClone(document));
  const [recipientIndex, setRecipientIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const busy = useRef(false);
  const mounted = useRef(true);
  const attempt = useRef<{ fingerprint: string; clientNonce: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const recipient = draft.recipients[recipientIndex]!;
  const step = recipient.steps[stepIndex]!;
  function edit(changes: Partial<typeof step>) {
    setStatus("idle");
    setDraft((current) => ({
      ...current,
      recipients: current.recipients.map((item, index) =>
        index !== recipientIndex
          ? item
          : {
              ...item,
              steps: item.steps.map((value, step) =>
                step !== stepIndex ? value : { ...value, ...changes },
              ),
            },
      ),
    }));
  }
  async function save() {
    if (!onSave || busy.current) return;
    const sequence = { ...draft, revisesArtifactId: artifactId };
    if (!RecruitingOutreachSequenceSchema.safeParse(sequence).success) {
      setStatus("failed");
      return;
    }
    const fingerprint = JSON.stringify(sequence);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, clientNonce: crypto.randomUUID() };
    busy.current = true;
    setStatus("saving");
    try {
      await onSave({
        sourceArtifactId: artifactId,
        name,
        sequence,
        clientNonce: attempt.current.clientNonce,
      });
      if (mounted.current) setStatus("saved");
    } catch {
      if (mounted.current) setStatus("failed");
    } finally {
      busy.current = false;
    }
  }
  return (
    <>
      <div className="hire-sequence-stats">
        <div>
          <strong>{draft.recipients.length}</strong>
          <span>
            <Trans>Recipients</Trans>
          </span>
        </div>
        <div>
          <strong>{recipient.steps.length}</strong>
          <span>
            <Trans>Steps</Trans>
          </span>
        </div>
        <div>
          <strong>
            <Trans>Draft</Trans>
          </strong>
          <span>{draft.roleTitle}</span>
        </div>
      </div>
      <div className="hire-sequence-layout">
        <section className="hire-step-list" aria-label={t`Sequence steps`}>
          <div className="hire-subheading">
            <strong>
              <Trans>Steps</Trans>
            </strong>
          </div>
          {recipient.steps.map((item, index) => (
            <button
              key={index}
              type="button"
              className={stepIndex === index ? "active" : undefined}
              aria-pressed={stepIndex === index}
              aria-label={t`Step ${index + 1}`}
              onClick={() => setStepIndex(index)}
            >
              <span className="hire-step-number">{index + 1}</span>
              <span>
                <strong>
                  {index === 0 ? <Trans>Initial email</Trans> : <Trans>Follow-up email</Trans>}
                </strong>
                <small>
                  {item.dayOffset === null ? t`Timing not set` : t`Day ${item.dayOffset}`} ·{" "}
                  {item.subject || t`Subject not set`}
                </small>
              </span>
              <ChevronRight size={16} aria-hidden />
            </button>
          ))}
          <div className="hire-recipient-list">
            <strong>
              <Trans>Recipients</Trans>
            </strong>
            {draft.recipients.map((person, index) => (
              <button
                key={index}
                type="button"
                aria-pressed={recipientIndex === index}
                onClick={() => {
                  setRecipientIndex(index);
                  setStepIndex(0);
                }}
              >
                <strong>{person.name}</strong>
                <small>{person.email ?? t`Email missing`}</small>
              </button>
            ))}
          </div>
        </section>
        <form
          className="hire-step-editor"
          aria-label={t`Email draft editor`}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="hire-subheading">
            <strong>
              <Trans>Step {stepIndex + 1} · Email draft</Trans>
            </strong>
            <span>{recipient.name}</span>
          </div>
          <div className="px-5 pt-4 text-xs text-muted-foreground">
            {recipient.linkedinUrl ? (
              <a href={recipient.linkedinUrl} target="_blank" rel="noreferrer">
                <Trans>LinkedIn</Trans>
              </a>
            ) : (
              <Trans>LinkedIn missing</Trans>
            )}
            {" · "}
            {recipient.email ?? t`Email missing`}
          </div>
          <label>
            <Trans>Subject</Trans>
            <input
              aria-label={t`Subject`}
              value={step.subject}
              readOnly={!onSave}
              disabled={status === "saving"}
              onChange={(event) => edit({ subject: event.currentTarget.value })}
            />
          </label>
          <label>
            <Trans>Message</Trans>
            <textarea
              aria-label={t`Message`}
              value={step.body}
              readOnly={!onSave}
              disabled={status === "saving"}
              onChange={(event) => edit({ body: event.currentTarget.value })}
            />
          </label>
          <div className="hire-step-editor-foot">
            <label>
              <Trans>Send on day</Trans>
              <input
                aria-label={t`Send on day`}
                type="number"
                min="0"
                step="1"
                value={step.dayOffset ?? ""}
                readOnly={!onSave}
                disabled={status === "saving"}
                onChange={(event) =>
                  edit({
                    dayOffset:
                      event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber,
                  })
                }
              />
            </label>
            {onSave ? (
              <button
                type="submit"
                className="hire-black-button"
                disabled={status === "saving" || status === "saved"}
              >
                {status === "saving" ? <Trans>Saving…</Trans> : <Trans>Save draft</Trans>}
              </button>
            ) : null}
          </div>
          {status === "saved" ? (
            <p className="px-5 pt-3 text-sm text-success" role="status">
              <Trans>Draft saved</Trans>
            </p>
          ) : status === "failed" ? (
            <p className="px-5 pt-3 text-sm text-destructive" role="alert">
              <Trans>Could not save this draft. Try again.</Trans>
            </p>
          ) : null}
        </form>
      </div>
    </>
  );
}

type CorrespondenceEmail = Pick<
  SavedCorrespondence["emails"][number],
  "id" | "sender" | "recipients" | "subject" | "body" | "snippet" | "date" | "url"
>;

export function CorrespondenceEmails({
  emails,
  selectedId,
  onSelect,
}: {
  emails: readonly CorrespondenceEmail[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const selected = emails.find((email) => email.id === selectedId) ?? emails[0];
  return (
    <div className="hire-inbox-layout">
      <aside className="hire-inbox-list" aria-label={t`Saved emails`}>
        <div className="hire-inbox-filter">
          <strong>
            <Trans>Emails</Trans>
          </strong>
          <span>{emails.length}</span>
        </div>
        {emails.map((email) => (
          <button
            key={email.id}
            type="button"
            aria-label={email.subject || t`No subject`}
            aria-pressed={selected?.id === email.id}
            className="block w-full border-b border-border p-4 text-start hover:bg-muted aria-pressed:bg-muted"
            onClick={() => onSelect(email.id)}
          >
            <strong className="block truncate">{email.sender ?? t`Sender unavailable`}</strong>
            <span className="block truncate text-sm">{email.subject || t`No subject`}</span>
            {email.date ? (
              <time className="text-xs text-muted-foreground" dateTime={email.date}>
                {new Date(email.date).toLocaleString()}
              </time>
            ) : null}
          </button>
        ))}
      </aside>
      <section className="hire-inbox-thread" aria-label={t`Email content`}>
        {selected ? (
          <>
            <div className="hire-subheading">
              <strong>{selected.subject || t`No subject`}</strong>
            </div>
            <div className="space-y-4 p-5">
              <p className="break-words text-sm">
                {selected.sender ?? t`Sender unavailable`}
                {selected.recipients.length ? <> → {selected.recipients.join(", ")}</> : null}
              </p>
              {selected.snippet ? (
                <p className="text-xs text-muted-foreground">
                  <Trans>Preview only. Ask for the complete message to read the full body.</Trans>
                </p>
              ) : null}
              <p className="whitespace-pre-wrap break-words">
                {selected.body || t`Message body unavailable`}
              </p>
              {selected.url ? (
                <a href={selected.url} target="_blank" rel="noreferrer" className="underline">
                  <Trans>Open original email</Trans>
                </a>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function SavedCorrespondenceView({
  view,
  artifactTarget,
  threadId,
  onConversation,
  onOpenConnections,
  onEmailSelection,
  onReviewSchedulingPlan,
  page,
  refreshSignal = 0,
  readCache,
  readCacheScope,
}: Pick<
  Props,
  | "artifactTarget"
  | "threadId"
  | "onConversation"
  | "onOpenConnections"
  | "onEmailSelection"
  | "onReviewSchedulingPlan"
  | "page"
  | "refreshSignal"
  | "readCache"
  | "readCacheScope"
> & {
  view: "inbox" | "interview";
}) {
  const { t } = useLingui();
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [planningKey, setPlanningKey] = useState<string>();
  const [selectedSource, setSelectedSource] = useState<string>();
  const [selectedThread, setSelectedThread] = useState<string>();
  const [selectedCampaign, setSelectedCampaign] = useState<string>();
  const [chosenCandidate, setChosenCandidate] = useState<string>();
  const [candidateQuery, setCandidateQuery] = useState("");
  const [mailFilter, setMailFilter] = useState<"all" | "unread">("all");
  const [mobileConversation, setMobileConversation] = useState(false);
  const railTrigger = useRef<HTMLButtonElement | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);
  const detail = useRecruitingDetail();
  useEffect(() => {
    if (mobileConversation) {
      if (backButton.current?.getClientRects().length) backButton.current.focus();
    } else railTrigger.current?.focus();
  }, [mobileConversation]);
  const key = JSON.stringify([artifactTarget, view, refreshSignal, refresh]);
  const scopeKey = JSON.stringify([readCacheScope, artifactTarget, view]);
  const savedWorkspace = readCacheScope
    ? (savedRecruitingRead(readCache, `${readCacheScope}:workspace`) as
        | { workspace: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>> }
        | undefined)
    : undefined;
  const cacheKey =
    readCacheScope && savedWorkspace?.workspace
      ? `${readCacheScope}:correspondence:${JSON.stringify([view, artifactTarget, savedWorkspace.workspace.role.id, savedWorkspace.workspace.revision.id])}`
      : undefined;
  const [read, setRead] = useState<{
    key: string;
    scopeKey?: string;
    data?: SavedCorrespondence;
    failed?: boolean;
    fresh?: boolean;
  }>();
  useEffect(() => {
    if (page) return;
    let cancelled = false;
    const abort = new AbortController();
    const cacheEpoch = readCache?.epoch;
    setRead((current) => ({
      key,
      scopeKey,
      data:
        (cacheKey
          ? (savedRecruitingRead(readCache, cacheKey) as SavedCorrespondence | undefined)
          : undefined) ?? (readCache && current?.scopeKey === scopeKey ? current?.data : undefined),
    }));
    void retryTransientRead(
      () => rpc.recruiting.correspondence({ ...artifactTarget, view }),
      abort.signal,
    )
      .then((data) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && cacheEpoch !== readCache.epoch)
          return setRead({ key, scopeKey, failed: true });
        rememberRecruitingRead(readCache, cacheKey, data, cacheEpoch);
        setRead({ key, scopeKey, data, fresh: true });
      })
      .catch((error) => {
        if (!cancelled) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(String(error.code))
          ) {
            clearRecruitingReads(readCache, readCacheScope);
            setRead({ key, scopeKey, failed: true });
          } else
            setRead((current) =>
              current?.key === key && current.scopeKey === scopeKey
                ? { ...current, failed: true }
                : { key, scopeKey, failed: true },
            );
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [key, cacheKey, readCache, readCacheScope, scopeKey, page]);
  const current = page
    ? { key, scopeKey, data: page.correspondence, fresh: true, failed: false }
    : read?.key === key && read.scopeKey === scopeKey
      ? read
      : undefined;
  const data = current?.data;
  const workspaceRead = useKeyedRead(
    !page && view === "inbox" && data?.roleId && threadId
      ? JSON.stringify([scopeKey, data.roleId, threadId, refreshSignal, refresh])
      : null,
    async () => {
      const workspace = await rpc.recruiting.getWorkspace({ threadId: threadId! });
      if (workspace?.role.id !== data?.roleId) throw new Error("Role changed");
      return workspace;
    },
  );
  const workspace = page?.workspace ?? workspaceRead.data;
  const target = workspace?.crmTarget?.target;
  const crm: RoleCrm = workspaceRead.loading
    ? { status: "loading" }
    : workspaceRead.failed
      ? { status: "failed" }
      : target
        ? { status: "ready", target, conversation: artifactTarget }
        : { status: "unbound" };
  const readCrm: RoleCrm = page ? { status: "unbound" } : crm;
  const peopleRead = useCrmPages(
    readCrm,
    "candidates",
    target ? { crmRoleId: target.crmRoleId } : null,
    {
      spaceId: workspace?.role.spaceId ?? "",
      readCache,
      readCacheScope,
      refreshSignal: refreshSignal + refresh,
    },
  );
  const people = page
    ? {
        ...peopleRead,
        failed: false,
        data: {
          items: (page.candidates?.items ?? []).flatMap((person) =>
            person.crm
              ? [
                  {
                    ...person.crm,
                    name: person.name ?? t`Unnamed candidate`,
                    email: person.email,
                    title: person.title,
                    location: person.location,
                    linkedinUrl: person.linkedinUrl,
                    phone: person.crm.phone ?? null,
                    roleSpecId: target?.crmRoleId ?? null,
                    legacyClientLabel: target?.clientLabel ?? "",
                    legacyRoleLabel: target?.roleLabel ?? "",
                  },
                ]
              : [],
          ),
        },
      }
    : peopleRead;
  const sequenceStats = useSequenceStats(
    readCrm,
    (people.data?.items ?? []).map((person) => person.candidateId),
    {
      spaceId: workspace?.role.spaceId ?? "",
      readCache,
      readCacheScope,
      refreshSignal: refreshSignal + refresh,
    },
  );
  const sequenceLabels = useSequenceLabels();
  const matchesTarget = (email: SavedCorrespondence["emails"][number]) =>
    target &&
    email.crm &&
    email.sourceId === target.mcpServerId &&
    email.crm.serverRevision === target.serverRevision &&
    email.crm.organizationId === target.organizationId &&
    email.crm.crmRoleId === target.crmRoleId;
  const candidateOf = (email: SavedCorrespondence["emails"][number]) =>
    matchesTarget(email)
      ? `candidate:${email.crm!.candidateId}`
      : email.imported && email.candidateKey
        ? `imported-candidate:${email.candidateKey}`
        : email.sourceId &&
            email.eaccount &&
            email.campaignId !== undefined &&
            email.providerThreadId
          ? JSON.stringify([
              "unidentified-thread",
              email.sourceId,
              email.eaccount,
              email.campaignId,
              email.providerThreadId,
              email.crm?.organizationId,
              email.crm?.crmRoleId,
              email.crm?.candidateId,
            ])
          : `message:${email.id}`;
  const loadedEmails = data?.emails ?? [];
  const unreadCount = loadedEmails.filter((email) => email.unread === true).length;
  const unknownReadCount = loadedEmails.filter((email) => email.unread == null).length;
  const visibleEmails =
    mailFilter === "unread" ? loadedEmails.filter((email) => email.unread === true) : loadedEmails;
  const rail = new Map<
    string,
    {
      person?: NonNullable<typeof people.data>["items"][number];
      email?: SavedCorrespondence["emails"][number];
    }
  >();
  for (const email of visibleEmails)
    if (!rail.has(candidateOf(email))) rail.set(candidateOf(email), { email });
  for (const person of people.data?.items ?? []) {
    if (mailFilter === "unread" && !rail.has(`candidate:${person.candidateId}`)) continue;
    rail.set(`candidate:${person.candidateId}`, {
      ...rail.get(`candidate:${person.candidateId}`),
      person,
    });
  }
  const candidateKey =
    chosenCandidate && rail.has(chosenCandidate) ? chosenCandidate : rail.keys().next().value;
  const selectedPerson = candidateKey ? rail.get(candidateKey)?.person : undefined;
  const candidateEmails = visibleEmails.filter((email) => candidateOf(email) === candidateKey);
  const sourceOf = (email: SavedCorrespondence["emails"][number]) =>
    JSON.stringify([email.sourceId, email.eaccount ?? null]);
  // Only recorded source/thread/candidate identity can combine messages. Unknown threads stay separate.
  const threadOf = (email: SavedCorrespondence["emails"][number]) =>
    JSON.stringify([
      sourceOf(email),
      email.crm?.organizationId,
      email.crm?.crmRoleId,
      email.crm?.candidateId,
      email.campaignId ?? null,
      email.sourceId && email.eaccount && email.campaignId !== undefined && email.providerThreadId
        ? ["thread", email.providerThreadId]
        : ["message", email.id],
    ]);
  const sources = new Map(candidateEmails.map((email) => [sourceOf(email), email]));
  const sourceKey =
    selectedSource && sources.has(selectedSource) ? selectedSource : sources.keys().next().value;
  const sourceEmails = candidateEmails.filter((email) => sourceOf(email) === sourceKey);
  const campaignOf = (email: SavedCorrespondence["emails"][number]) =>
    JSON.stringify(email.campaignId ?? null);
  const campaigns = new Map(sourceEmails.map((email) => [campaignOf(email), email]));
  const campaignKey =
    selectedCampaign && campaigns.has(selectedCampaign)
      ? selectedCampaign
      : campaigns.keys().next().value;
  const campaignEmails = sourceEmails.filter((email) => campaignOf(email) === campaignKey);
  const threads = new Map(campaignEmails.map((email) => [threadOf(email), email]));
  const threadKey =
    selectedThread && threads.has(selectedThread) ? selectedThread : threads.keys().next().value;
  const threadEmails = campaignEmails.filter((email) => threadOf(email) === threadKey);
  const selected = threadEmails.find((email) => email.id === selectedId) ?? threadEmails[0];
  // Cached mail stays readable; only a current authorized read can create a plan or chat context.
  const parsed = useMemo(
    () =>
      view === "inbox" && current?.fresh && !current.failed && data?.roleId && selected && threadId
        ? RecruitingCorrespondenceReferenceSchema.safeParse({
            threadId,
            roleId: data.roleId,
            emailId: selected.id,
            sourceId: selected.sourceId,
            providerMessageId: selected.providerMessageId,
            savedRead: selected.savedRead,
            ...(selected.providerThreadId !== undefined
              ? { providerThreadId: selected.providerThreadId }
              : {}),
            ...(selected.campaignId !== undefined ? { campaignId: selected.campaignId } : {}),
            ...(selected.eaccount !== undefined ? { eaccount: selected.eaccount } : {}),
            ...(selected.crm ? { crm: selected.crm } : {}),
            sourceName: selected.sourceName.slice(0, 160),
            sender: selected.sender?.slice(0, 320) ?? null,
            subject: selected.subject.slice(0, 1000),
            date: selected.date,
            snippet: selected.snippet,
          })
        : undefined,
    [view, threadId, current?.fresh, current?.failed, data?.roleId, selected],
  );
  useEffect(() => {
    onEmailSelection?.(parsed?.success ? parsed.data : undefined);
    return () => onEmailSelection?.(undefined);
  }, [parsed, onEmailSelection]);
  const planKey = parsed?.success ? JSON.stringify(parsed.data) : undefined;
  const interview = view === "interview";
  const check = () =>
    onConversation(
      interview
        ? t`Check the connected calendar for interview availability for this role. Show the actual available times, time zone and any missing scheduling details. Don't send invitations, create events or contact candidates.`
        : t`Read the latest candidate email replies for this role using the connected mailbox. Show the sender, subject, date and original reply. Don't send, label, archive or modify any messages.`,
    );
  return (
    <div className="hire-standard-view">
      <header className="hire-section-header">
        <span className="hire-eyebrow">
          {interview ? <Trans>Scheduling</Trans> : <Trans>Conversations</Trans>}
        </span>
        <h1>{interview ? <Trans>Interview</Trans> : <Trans>Inbox</Trans>}</h1>
        <p>
          {interview ? (
            <Trans>Saved calendar checks in this conversation.</Trans>
          ) : (
            <Trans>Original email results saved in this role conversation.</Trans>
          )}
        </p>
      </header>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button type="button" className="hire-black-button" onClick={check}>
          {interview ? <Trans>Check availability</Trans> : <Trans>Check inbox</Trans>}
          <ArrowRight size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="hire-outline-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <Trans>Refresh saved results</Trans>
        </button>
        <button type="button" className="hire-outline-button" onClick={() => onOpenConnections()}>
          <Settings2 size={15} aria-hidden />
          <Trans>Manage connections</Trans>
        </button>
        {data?.checkedAt ? (
          <time className="text-xs text-muted-foreground" dateTime={data.checkedAt}>
            <Trans>Last checked</Trans>
            {" · "}
            {new Date(data.checkedAt).toLocaleString()}
          </time>
        ) : null}
      </div>
      {data ? (
        <ul className="mb-5 flex flex-wrap gap-2 text-sm" aria-label={t`Service connections`}>
          {data.connections.map((connection, index) => (
            <li key={index} className="rounded-lg border border-border px-3 py-2">
              {connection.name}
              {" · "}
              {connection.status === "configured" ? (
                <Trans>Configured</Trans>
              ) : connection.status === "needs_access" ? (
                <Trans>Enable for this role</Trans>
              ) : connection.status === "disabled" ? (
                <Trans>Disabled</Trans>
              ) : connection.status === "unavailable" ? (
                <Trans>Temporarily unavailable</Trans>
              ) : (
                <Trans>Connect account</Trans>
              )}
              {connection.checkIssue ? (
                <p role="alert" className="mt-1 text-destructive">
                  {connection.checkIssue.status === "failed" ? (
                    <Trans>A saved check failed.</Trans>
                  ) : (
                    <Trans>A saved result cannot be displayed.</Trans>
                  )}
                </p>
              ) : null}
            </li>
          ))}
          {!data.connections.length ? (
            <li>
              <Trans>No service configured for this role.</Trans>
            </li>
          ) : null}
        </ul>
      ) : null}
      {!current || (!data && !current.failed) ? (
        <p role="status">
          <Trans>Loading saved results…</Trans>
        </p>
      ) : null}
      {current?.failed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not load saved results. Try refreshing.</Trans>
        </p>
      ) : null}
      {data?.connectionChanged ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>
            Some saved results use an earlier connection setup. Check again to load results from the
            current connection.
          </Trans>
        </p>
      ) : null}
      {data?.partial ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>
            More results may be available. This is not the complete mailbox or calendar.
          </Trans>
        </p>
      ) : null}
      {data && data.status !== "ready" && (interview || data.status !== "empty") ? (
        <section className="hire-empty">
          {interview ? <CalendarDays size={34} aria-hidden /> : <Inbox size={34} aria-hidden />}
          <h2>
            {data.status === "not_checked" ? (
              <Trans>Not checked yet</Trans>
            ) : data.status === "empty" ? (
              <Trans>No saved results</Trans>
            ) : data.status === "failed" ? (
              <Trans>The last check failed</Trans>
            ) : (
              <Trans>This result cannot be displayed yet</Trans>
            )}
          </h2>
          <p>
            {data.status === "empty" ? (
              <Trans>
                The saved check returned no matching records. It does not confirm the entire account
                is empty.
              </Trans>
            ) : (
              <Trans>
                Use the connected service to check this role. Saved results will appear here when
                the agent finishes.
              </Trans>
            )}
          </p>
        </section>
      ) : null}
      {data && ["ready", "empty"].includes(data.status) && !interview ? (
        <section aria-label={t`Inbox`}>
          <fieldset
            className="mb-3 flex flex-wrap items-center gap-3"
            aria-label={t`Loaded email filters`}
          >
            <Button
              variant="outline"
              aria-pressed={mailFilter === "all"}
              onClick={() => setMailFilter("all")}
            >
              <Trans>All</Trans>
            </Button>
            <Button
              variant="outline"
              aria-pressed={mailFilter === "unread"}
              onClick={() => setMailFilter("unread")}
            >
              <Trans>Unread</Trans>
            </Button>
            <span className="text-xs text-muted-foreground">
              <Trans>
                Loaded observations: {loadedEmails.length} emails · {unreadCount} unread ·{" "}
                {unknownReadCount} read status unknown
              </Trans>
            </span>
          </fieldset>
          {mailFilter === "unread" && !visibleEmails.length ? (
            <p>
              <Trans>No unread emails among loaded observations.</Trans>
            </p>
          ) : null}
          {workspaceRead.failed || people.failed ? (
            <p role="alert">
              <Trans>Could not load candidate records. Try refreshing.</Trans>
            </p>
          ) : null}
          {!data.emails.length && !data.partial && !data.nextCursor ? (
            <p>
              <Trans>No replies yet.</Trans>
            </p>
          ) : null}
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,2fr)]">
            <section
              aria-label={t`Candidate conversations`}
              className={`${mobileConversation ? "hidden lg:block" : ""} min-w-0 overflow-hidden rounded-xl border bg-card`}
            >
              <div className="border-b p-3">
                <Input
                  aria-label={t`Search loaded candidates`}
                  placeholder={t`Search loaded candidates`}
                  value={candidateQuery}
                  onChange={(event) => setCandidateQuery(event.target.value)}
                />
              </div>
              <ul className="divide-y divide-border">
                {[...rail]
                  .filter(
                    ([, row]) =>
                      !candidateQuery.trim() ||
                      [
                        row.person?.name,
                        row.person?.title,
                        row.person?.company,
                        row.email?.subject,
                      ].some((value) =>
                        value
                          ?.toLocaleLowerCase()
                          .includes(candidateQuery.trim().toLocaleLowerCase()),
                      ),
                  )
                  .map(([id, row]) => {
                    const name = row.person?.name || t`Candidate details unavailable`;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-label={name}
                          aria-pressed={candidateKey === id}
                          className="w-full space-y-2 p-4 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                          onClick={(event) => {
                            railTrigger.current = event.currentTarget;
                            setChosenCandidate(id);
                            setSelectedSource(undefined);
                            setSelectedCampaign(undefined);
                            setSelectedThread(undefined);
                            setSelectedId(undefined);
                            setMobileConversation(true);
                          }}
                        >
                          <strong className="block">{name}</strong>
                          {row.person?.title ? (
                            <span className="block">{row.person.title}</span>
                          ) : null}
                          {row.person && sequenceStats.has(row.person.candidateId) ? (
                            <span className="block text-xs text-muted-foreground">
                              {sequenceLine(
                                sequenceStats.get(row.person.candidateId)!,
                                sequenceLabels,
                              )}
                            </span>
                          ) : null}
                          {row.email ? (
                            <span className="block text-xs text-muted-foreground">
                              {row.email.subject || t`No subject`}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
              </ul>
              <LoadMore pages={people} />
            </section>
            <div className={`${mobileConversation ? "" : "hidden lg:block"} min-w-0 space-y-3`}>
              <Button
                ref={backButton}
                variant="ghost"
                className="lg:hidden"
                onClick={() => setMobileConversation(false)}
              >
                <Trans>Back to inbox</Trans>
              </Button>
              {sources.size > 1 ? (
                <NativeSelect
                  aria-label={t`Source`}
                  value={sourceKey}
                  onChange={(event) => {
                    setSelectedSource(event.target.value);
                    setSelectedCampaign(undefined);
                    setSelectedThread(undefined);
                    setSelectedId(undefined);
                  }}
                >
                  {[...sources].map(([key, email]) => (
                    <NativeSelectOption key={key} value={key}>
                      {email.sourceName}
                      {email.eaccount ? ` · ${email.eaccount}` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              {campaigns.size > 1 ? (
                <NativeSelect
                  aria-label={t`Campaign`}
                  value={campaignKey}
                  onChange={(event) => {
                    setSelectedCampaign(event.target.value);
                    setSelectedThread(undefined);
                    setSelectedId(undefined);
                  }}
                >
                  {[...campaigns].map(([key, email], index) => (
                    <NativeSelectOption key={key} value={key}>
                      {email.campaignId ? `${t`Campaign`} ${index + 1}` : t`Unknown`}
                      {` · ${email.sender ?? t`Sender unavailable`} · ${email.subject || t`No subject`}`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              {threads.size > 1 ? (
                <NativeSelect
                  aria-label={t`Conversation`}
                  value={threadKey}
                  onChange={(event) => {
                    setSelectedThread(event.target.value);
                    setSelectedId(undefined);
                  }}
                >
                  {[...threads].map(([key, email], index) => (
                    <NativeSelectOption key={key} value={key}>
                      {`${index + 1}. ${email.sender ?? t`Sender unavailable`} · ${email.subject || t`No subject`}`}
                      {email.date ? ` · ${new Date(email.date).toLocaleString()}` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              {selected ? (
                <section
                  className="space-y-1 text-xs text-muted-foreground"
                  aria-label={t`Observed email metadata`}
                >
                  <p>
                    {selected.unread === true ? (
                      <Trans>Observed unread</Trans>
                    ) : selected.unread === false ? (
                      <Trans>Observed read</Trans>
                    ) : (
                      <Trans>Read status unknown</Trans>
                    )}
                  </p>
                  {selected.step != null ? (
                    <p>
                      <Trans>Step</Trans> · {selected.step}
                    </p>
                  ) : null}
                  {selected.observedAt ? (
                    <p>
                      <Trans>Observed at</Trans> ·{" "}
                      <time dateTime={selected.observedAt}>
                        {new Date(selected.observedAt).toLocaleString()}
                      </time>
                    </p>
                  ) : null}
                </section>
              ) : null}
              {threadEmails.length ||
              (data.emails.length && !data.partial && !data.nextCursor && mailFilter === "all") ? (
                <EmailConversation
                  artifactTarget={artifactTarget}
                  candidateName={selectedPerson?.name}
                  candidateTitle={selectedPerson?.title}
                  onOpenProfile={
                    detail && selectedPerson && workspace
                      ? () =>
                          detail.open({
                            view: "contact",
                            person: selectedPerson,
                            role: {
                              roleId: workspace.role.id,
                              spaceId: workspace.role.spaceId,
                              conversation: artifactTarget,
                            },
                          })
                      : undefined
                  }
                  items={threadEmails.map((email) => ({
                    ...email,
                    threadId: email.providerThreadId,
                    organizationId: email.crm?.organizationId,
                    crmRoleId: email.crm?.crmRoleId,
                    direction: email.direction ?? email.crm?.direction ?? null,
                    partial: email.snippet,
                    candidateId: email.crm?.candidateId,
                  }))}
                  selectedId={selected?.id}
                  onSelect={(email) => setSelectedId(email.id)}
                  onDraftReply={
                    selected && current?.fresh && !current.failed
                      ? (email) => {
                          if (email.id !== selected.id) return;
                          onConversation(
                            t`Draft a reply to the selected email for me to review. Read the original conversation and verify the candidate and role. Do not send.`,
                          );
                        }
                      : undefined
                  }
                />
              ) : null}
              {parsed?.success && workspace?.role.revision && !selected?.imported ? (
                <>
                  <Button variant="outline" onClick={() => setPlanningKey(planKey)}>
                    <Trans>Plan interview</Trans>
                  </Button>
                  {planningKey === planKey ? (
                    <SchedulingPlanForm
                      key={planKey}
                      originalEmail={parsed.data}
                      roleRevision={workspace.role.revision}
                      candidate={
                        selectedPerson?.name &&
                        selectedPerson.email &&
                        selected?.crm &&
                        matchesTarget(selected) &&
                        selectedPerson.candidateId === selected.crm.candidateId
                          ? {
                              candidateKey: selectedPerson.candidateId,
                              name: selectedPerson.name,
                              email: selectedPerson.email,
                            }
                          : undefined
                      }
                      onReview={onReviewSchedulingPlan}
                      onCheck={onConversation}
                      onClose={() => setPlanningKey(undefined)}
                    />
                  ) : null}
                </>
              ) : null}
              {selected?.url ? (
                <a href={selected.url} target="_blank" rel="noreferrer" className="underline">
                  <Trans>Open original email</Trans>
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
      {data?.status === "ready" && interview ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <Trans>
              No invitation is created by this view. Availability is the saved observation, not a
              reservation. Calendar records may include other roles; their role association has not
              been verified.
            </Trans>
          </p>
          <AvailabilityRanges
            slots={data.events.filter((event) => event.kind === "availability")}
          />
          {data.events
            .filter((event) => event.kind !== "availability")
            .map((event) => (
              <article key={event.id} className="rounded-xl border border-border p-5">
                <div className="mb-3 flex flex-wrap justify-between gap-2">
                  <h2 className="font-semibold">{event.title || t`Calendar event`}</h2>
                  {event.status ? (
                    <span className="text-sm text-muted-foreground">{event.status}</span>
                  ) : null}
                </div>
                <p>
                  <time dateTime={event.start}>{event.start}</time>
                  {event.end ? (
                    <>
                      {" "}
                      – <time dateTime={event.end}>{event.end}</time>
                    </>
                  ) : null}
                  {event.timeZone ? ` · ${event.timeZone}` : ""}
                </p>
                {event.attendees.length ? (
                  <p className="mt-2 break-words text-sm">{event.attendees.join(", ")}</p>
                ) : null}
                {event.location ? <p className="mt-2 text-sm">{event.location}</p> : null}
                {event.url ? (
                  <a
                    href={event.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block underline"
                  >
                    <Trans>Open calendar event</Trans>
                  </a>
                ) : null}
              </article>
            ))}
        </div>
      ) : null}
    </div>
  );
}

export function RecruitingCorrespondence({
  view,
  messages,
  artifactTarget,
  threadId,
  outreachBotIds = [],
  onConversation,
  onOpenConnections,
  onEmailSelection,
  onReviewSchedulingPlan,
  onSaveDraft,
  page,
  refreshSignal,
  readCache,
  readCacheScope,
}: Props) {
  const { t } = useLingui();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  // Ownership and immutable artifact identity, never filename guesses or inferred email state.
  const files = [
    ...new Map(
      messages
        .toReversed()
        .filter(
          (message) =>
            (message.role === "bot" &&
              message.botId !== undefined &&
              outreachBotIds.includes(message.botId)) ||
            message.role === "user",
        )
        .flatMap((message) =>
          message.blocks.filter(
            (block): block is Extract<ThreadMessage["blocks"][number], { kind: "file" }> =>
              block.kind === "file" &&
              (message.role === "bot" || block.mimeType === "application/json"),
          ),
        )
        .map((file) => [file.artifactId, file] as const),
    ).values(),
  ];
  const selected =
    files.find((file) => file.artifactId === selectedArtifactId) ??
    files.find((file) => file.mimeType === "application/json") ??
    files[0];
  const [retry, setRetry] = useState(0);
  const readKey = JSON.stringify([artifactTarget, selected?.artifactId, retry]);
  const [sequenceRead, setSequenceRead] = useState<{
    key: string;
    status: "loading" | "ready" | "failed";
    document?: RecruitingOutreachSequence;
  } | null>(null);
  useEffect(() => {
    if (view !== "sequence" || selected?.mimeType !== "application/json") return;
    let cancelled = false;
    setSequenceRead({ key: readKey, status: "loading" });
    void fetchArtifactBytes(artifactTarget, selected.artifactId)
      .then((bytes) => {
        if (cancelled) return;
        const document = RecruitingOutreachSequenceSchema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        setSequenceRead({
          key: readKey,
          status: "ready",
          ...(document.success ? { document: document.data } : {}),
        });
      })
      .catch(() => {
        if (!cancelled) setSequenceRead({ key: readKey, status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [readKey, view]);
  const loaded = sequenceRead?.key === readKey ? sequenceRead : null;
  const prepareDrafts = () =>
    onConversation(
      t`Prepare personalized first email drafts and follow-up sequences for the selected candidates in this role, using their saved evidence. Keep missing contact details unknown. Save the drafts here. Don't send anything or enroll anyone in a campaign.`,
    );

  if (view === "sequence") {
    return (
      <div className="hire-standard-view">
        <header className="hire-section-header">
          <span className="hire-eyebrow">
            <Trans>Outreach</Trans>
          </span>
          <h1>
            <Trans>Sequence</Trans>
          </h1>
          <p>
            <Trans>Review the outreach files saved in this conversation.</Trans>
          </p>
        </header>
        {!page ? (
          <RoleCampaignCard
            conversation={
              "groupId" in artifactTarget
                ? { groupId: artifactTarget.groupId }
                : { botId: artifactTarget.botId }
            }
            refreshSignal={refreshSignal}
            readCache={readCache}
            readCacheScope={readCacheScope}
          />
        ) : null}
        {files.length > 1 ? (
          <NativeSelect
            aria-label={t`Saved sequence file`}
            value={selected?.artifactId ?? ""}
            onChange={(event) => setSelectedArtifactId(event.target.value)}
          >
            {files.map((file) => (
              <NativeSelectOption key={file.artifactId} value={file.artifactId}>
                {file.preview?.label ?? file.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {loaded?.status === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading sequence…</Trans>
          </p>
        ) : null}
        {loaded?.status === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not read this sequence.</Trans>{" "}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              <Trans>Try again</Trans>
            </button>
          </p>
        ) : null}
        {loaded?.document && selected ? (
          <SequenceEditor
            key={readKey}
            document={loaded.document}
            artifactId={selected.artifactId}
            name={selected.name}
            onSave={onSaveDraft}
          />
        ) : files.length ? (
          <>
            <div className="hire-sequence-stats">
              <div>
                <strong>{files.length}</strong>
                <span>
                  <Trans>Loaded files</Trans>
                </span>
              </div>
            </div>
            <div className="hire-sequence-layout">
              <section className="hire-step-list" aria-label={t`Saved outreach files`}>
                <div className="hire-subheading">
                  <strong>
                    <Trans>Saved files</Trans>
                  </strong>
                </div>
                {files.map((file, index) => (
                  <button
                    key={file.artifactId}
                    type="button"
                    className={selected?.artifactId === file.artifactId ? "active" : undefined}
                    aria-pressed={selected?.artifactId === file.artifactId}
                    aria-label={file.preview?.label ?? file.name}
                    onClick={() => setSelectedArtifactId(file.artifactId)}
                  >
                    <span className="hire-step-number">{index + 1}</span>
                    <span>
                      <strong>{file.preview?.label ?? file.name}</strong>
                    </span>
                    <ChevronRight size={16} aria-hidden />
                  </button>
                ))}
              </section>
              <section className="hire-step-editor" aria-label={t`Outreach file review`}>
                <div className="hire-subheading">
                  <strong>
                    <Trans>File preview</Trans>
                  </strong>
                </div>
                {selected ? (
                  <div className="p-5">
                    <ArtifactFileCard
                      key={selected.artifactId}
                      target={artifactTarget}
                      {...selected}
                    />
                  </div>
                ) : null}
                <div className="hire-step-editor-foot">
                  <button
                    type="button"
                    className="hire-outline-button"
                    onClick={() => onConversation()}
                  >
                    <Trans>Review in conversation</Trans>
                    <ArrowRight size={15} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="hire-black-button"
                    onClick={() =>
                      onConversation(
                        t`Help me revise the saved outreach drafts for this role. Keep the changes unsent.`,
                      )
                    }
                  >
                    <Trans>Revise in chat</Trans>
                    <ArrowRight size={15} aria-hidden />
                  </button>
                </div>
              </section>
            </div>
          </>
        ) : (
          <section className="hire-empty">
            <Mail size={34} aria-hidden />
            <h2>
              <Trans>No outreach files loaded</Trans>
            </h2>
            <p>
              <Trans>
                Open the conversation to review its history, or ask WeKruit to prepare drafts from
                saved candidate evidence.
              </Trans>
            </p>
            <button type="button" className="hire-black-button" onClick={prepareDrafts}>
              <Trans>Prepare drafts</Trans>
              <ArrowRight size={15} aria-hidden />
            </button>
          </section>
        )}
      </div>
    );
  }

  if (view === "interview" && page)
    return page.scheduling && threadId ? (
      <SchedulingPlanHistory
        threadId={threadId}
        roleId={page.roleId}
        snapshot={page.scheduling}
        onReview={onReviewSchedulingPlan}
      />
    ) : null;
  return (
    <SavedCorrespondenceView
      view={view}
      page={page}
      artifactTarget={artifactTarget}
      threadId={threadId}
      onConversation={onConversation}
      onOpenConnections={onOpenConnections}
      onEmailSelection={onEmailSelection}
      onReviewSchedulingPlan={onReviewSchedulingPlan}
      refreshSignal={refreshSignal}
      readCache={readCache}
      readCacheScope={readCacheScope}
    />
  );
}
