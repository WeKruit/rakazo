import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingOutreachSequence, ThreadMessage } from "@rakazo/contracts";
import { RecruitingOutreachSequenceSchema } from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowRight, CalendarDays, ChevronRight, Inbox, Mail, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import type { ArtifactTarget } from "../lib/artifact-open";
import { fetchArtifactBytes } from "../lib/artifact-open";

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

export function RecruitingCorrespondence({
  view,
  messages,
  artifactTarget,
  outreachBotIds = [],
  onConversation,
  onOpenConnections,
  onSaveDraft,
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
            <Trans>Check real availability before preparing an invitation.</Trans>
          ) : (
            <Trans>Read candidate replies from your connected email account.</Trans>
          )}
        </p>
      </header>
      <div className={interview ? "hire-calendar-top" : "hire-inbox-layout"}>
        {!interview ? (
          <aside className="hire-inbox-list">
            <div className="hire-inbox-filter">
              <strong>
                <Trans>Mailbox</Trans>
              </strong>
              <span>
                <Trans>Not loaded</Trans>
              </span>
            </div>
          </aside>
        ) : null}
        <section className={interview ? "hire-empty w-full" : "hire-inbox-thread"}>
          {!interview ? (
            <div className="hire-subheading">
              <strong>
                <Trans>Candidate replies</Trans>
              </strong>
            </div>
          ) : null}
          <div className={interview ? "space-y-4" : "hire-empty"}>
            {interview ? <CalendarDays size={34} aria-hidden /> : <Inbox size={34} aria-hidden />}
            <h2>
              {interview ? <Trans>Availability not loaded</Trans> : <Trans>Inbox not loaded</Trans>}
            </h2>
            <p>
              {interview ? (
                <Trans>
                  Ask WeKruit to read the connected calendar. No available times or bookings have
                  been loaded into this view.
                </Trans>
              ) : (
                <Trans>
                  Ask WeKruit to read the connected mailbox. Replies have not been loaded into this
                  view.
                </Trans>
              )}
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" className="hire-black-button" onClick={check}>
                {interview ? <Trans>Check availability</Trans> : <Trans>Check inbox</Trans>}
                <ArrowRight size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="hire-outline-button"
                onClick={() => onOpenConnections()}
              >
                <Settings2 size={15} aria-hidden />
                <Trans>Manage connections</Trans>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
