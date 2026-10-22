import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingOutreachSequence,
  RecruitingCorrespondence as SavedCorrespondence,
  ThreadMessage,
} from "@rakazo/contracts";
import { RecruitingOutreachSequenceSchema } from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowRight, CalendarDays, ChevronRight, Inbox, Mail, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import type { ArtifactTarget } from "../lib/artifact-open";
import { fetchArtifactBytes } from "../lib/artifact-open";
import type { RecruitingReadCache } from "../lib/recruiting-read-cache";
import { clearRecruitingReads, rememberRecruitingRead } from "../lib/recruiting-read-cache";
import { rpc } from "../lib/rpc";

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
  outreachBotIds?: readonly string[];
  onConversation: (text?: string) => void;
  onOpenConnections: () => void;
  onSaveDraft?: (input: RecruitingSequenceSaveInput) => Promise<void>;
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

function SavedCorrespondenceView({
  view,
  artifactTarget,
  onConversation,
  onOpenConnections,
  refreshSignal = 0,
  readCache,
  readCacheScope,
}: Pick<
  Props,
  | "artifactTarget"
  | "onConversation"
  | "onOpenConnections"
  | "refreshSignal"
  | "readCache"
  | "readCacheScope"
> & {
  view: "inbox" | "interview";
}) {
  const { t } = useLingui();
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const key = JSON.stringify([artifactTarget, view, refreshSignal, refresh]);
  const scopeKey = JSON.stringify([readCacheScope, artifactTarget, view]);
  const savedWorkspace = readCacheScope
    ? (readCache?.entries.get(`${readCacheScope}:workspace`) as
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
  }>();
  useEffect(() => {
    let cancelled = false;
    const cacheEpoch = readCache?.epoch;
    setRead((current) => ({
      key,
      scopeKey,
      data:
        (cacheKey
          ? (readCache?.entries.get(cacheKey) as SavedCorrespondence | undefined)
          : undefined) ?? (readCache && current?.scopeKey === scopeKey ? current?.data : undefined),
    }));
    void rpc.recruiting
      .correspondence({ ...artifactTarget, view })
      .then((data) => {
        if (!cancelled && (!readCache || cacheEpoch === readCache.epoch)) {
          rememberRecruitingRead(readCache, cacheKey, data, cacheEpoch);
          setRead({ key, scopeKey, data });
        }
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
            setRead({ key, failed: true });
          } else
            setRead((current) =>
              current?.key === key ? { ...current, failed: true } : { key, failed: true },
            );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, cacheKey, readCache, readCacheScope, scopeKey]);
  const current = read?.key === key ? read : undefined;
  const data = current?.data;
  const selected = data?.emails.find((email) => email.id === selectedId) ?? data?.emails[0];
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
      {data && data.status !== "ready" ? (
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
      {data?.status === "ready" && !interview ? (
        <div className="hire-inbox-layout">
          <aside className="hire-inbox-list" aria-label={t`Saved emails`}>
            <div className="hire-inbox-filter">
              <strong>
                <Trans>Emails</Trans>
              </strong>
              <span>{data.emails.length}</span>
            </div>
            {data.emails.map((email) => (
              <button
                key={email.id}
                type="button"
                aria-label={email.subject || t`No subject`}
                aria-pressed={selected?.id === email.id}
                className="block w-full border-b border-border p-4 text-start hover:bg-muted aria-pressed:bg-muted"
                onClick={() => setSelectedId(email.id)}
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
                      <Trans>
                        Preview only. Ask for the complete message to read the full body.
                      </Trans>
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
          {data.events.map((event) => (
            <article key={event.id} className="rounded-xl border border-border p-5">
              <div className="mb-3 flex flex-wrap justify-between gap-2">
                <h2 className="font-semibold">
                  {event.kind === "availability"
                    ? t`Available time`
                    : event.title || t`Calendar event`}
                </h2>
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
  outreachBotIds = [],
  onConversation,
  onOpenConnections,
  onSaveDraft,
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

  return (
    <SavedCorrespondenceView
      view={view}
      artifactTarget={artifactTarget}
      onConversation={onConversation}
      onOpenConnections={onOpenConnections}
      refreshSignal={refreshSignal}
      readCache={readCache}
      readCacheScope={readCacheScope}
    />
  );
}
