import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingCampaignDetails,
  RecruitingSequenceDraft,
  RecruitingSequenceInput,
  RecruitingSequenceOutput,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Textarea,
} from "@rakazo/ui-web";
import { ChevronDown, ChevronRight, Clock3, Mail, Plus, Send, Sparkles, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CampaignObservedDetails } from "./CampaignObservedDetails";
import { clearSequenceDraftNonce, sequenceDraftNonce } from "./sequenceDraftNonce";

export type SequenceEditorProps = {
  roleId: string;
  serverId: string;
  expectedCampaignId?: string;
  mode?: "new" | "edit";
  observedDetails?: RecruitingCampaignDetails;
  execute: (input: RecruitingSequenceInput) => Promise<RecruitingSequenceOutput>;
  onAskAgent?: (message: string) => void;
  onDone?: () => void;
};
const emptyStep = () => ({ subject: "", body: "", delay_days: 0 });
const tokens = ["first_name", "last_name", "company_name", "personalization"];

/** Edits only the saved role-bound draft. Composer requests use the conversation's native agent. */
export function SequenceEditor({
  roleId,
  serverId,
  expectedCampaignId,
  mode = "edit",
  observedDetails,
  execute,
  onAskAgent,
  onDone,
}: SequenceEditorProps) {
  const { t } = useLingui();
  const formId = useId();
  const [data, setData] = useState<RecruitingSequenceOutput>();
  const [draft, setDraft] = useState<RecruitingSequenceDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [preview, setPreview] = useState<number>();
  const [composer, setComposer] = useState("");
  const [composerOpen, setComposerOpen] = useState(true);
  const [composerWidth, setComposerWidth] = useState(300);
  const [confirmExit, setConfirmExit] = useState(false);
  const epoch = useRef(0);
  const nonceScope = JSON.stringify([roleId, serverId, "create"]);
  const clientNonce = useMemo(() => sequenceDraftNonce(nonceScope), [nonceScope]);
  const accept = (result: RecruitingSequenceOutput, reading = false) => {
    const campaign = reading && mode === "new" ? null : result.campaign;
    setData({ ...result, campaign });
    setDraft({
      name: campaign?.name ?? result.roleTitle,
      eaccount: campaign?.eaccount ?? result.mailboxes[0] ?? "",
      steps: campaign?.steps.length ? campaign.steps : [emptyStep()],
      timezone: campaign?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      send_hours: campaign?.send_hours ?? "weekdays_9_to_5",
    });
    setDirty(false);
  };
  useEffect(() => {
    const current = ++epoch.current;
    setData(undefined);
    setDraft(undefined);
    setBusy(true);
    setError(false);
    setSaved(false);
    setDirty(false);
    setActiveStep(0);
    setPreview(undefined);
    setConfirmExit(false);
    void Promise.resolve()
      .then(() =>
        execute({
          operation: "read",
          roleId,
          serverId,
          ...(expectedCampaignId ? { campaignId: expectedCampaignId } : {}),
        }),
      )
      .then((result) => {
        if (epoch.current === current) accept(result, true);
      })
      .catch(() => {
        if (epoch.current === current) setError(true);
      })
      .finally(() => {
        if (epoch.current === current) setBusy(false);
      });
    return () => {
      epoch.current++;
    };
  }, [roleId, serverId, expectedCampaignId, mode, execute]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const mismatch = Boolean(expectedCampaignId && data && data.campaign?.id !== expectedCampaignId);
  const editable =
    !mismatch && (!data?.campaign || (data.campaign.editable && Boolean(data.campaign.revision)));
  const change = (patch: Partial<RecruitingSequenceDraft>) => {
    setDraft((value) => (value ? { ...value, ...patch } : value));
    setSaved(false);
    setDirty(true);
  };
  const save = async (operation: "create" | "save" | "pause") => {
    if (!draft || busy || mismatch || (operation !== "pause" && !editable)) return;
    const current = epoch.current;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const input: RecruitingSequenceInput =
        operation === "create"
          ? { operation, roleId, serverId, draft, clientNonce }
          : operation === "save"
            ? {
                operation,
                roleId,
                serverId,
                campaignId: data!.campaign!.id,
                draft,
                expectedRevision: data!.campaign!.revision!,
              }
            : { operation, roleId, serverId, campaignId: data!.campaign!.id };
      const result = await execute(input);
      if (current === epoch.current) {
        accept(result);
        if (operation === "create") clearSequenceDraftNonce(nonceScope, clientNonce);
        setSaved(true);
      }
    } catch {
      if (current === epoch.current) setError(true);
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const done = () => {
    if (dirty) setConfirmExit(true);
    else onDone?.();
  };
  const focusStep = (index: number) => {
    setActiveStep(index);
    document.getElementById(`${formId}-step-${index}`)?.scrollIntoView?.({ block: "nearest" });
  };
  const changeStep = (index: number, patch: Partial<RecruitingSequenceDraft["steps"][number]>) => {
    if (draft)
      change({ steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) });
  };
  const addStep = () => {
    if (!draft || draft.steps.length >= 10) return;
    change({ steps: [...draft.steps, emptyStep()] });
    setActiveStep(draft.steps.length);
  };
  return (
    <section
      aria-label={t`Sequence draft`}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape" && onDone && !confirmExit) {
          event.preventDefault();
          done();
        }
      }}
    >
      <header className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <p className="text-xs text-muted-foreground">
            <Trans>Sequence editor</Trans>
          </p>
          <h2 className="truncate text-lg font-semibold leading-snug" title={draft?.name}>
            {draft?.name || t`New sequence`}
          </h2>
          <p className="text-xs text-muted-foreground">
            <Trans>Draft changes do not send email.</Trans>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span role="status" className="text-xs text-muted-foreground">
            {busy
              ? data
                ? t`Saving…`
                : t`Loading…`
              : dirty
                ? t`Unsaved changes`
                : saved
                  ? t`Saved`
                  : data?.campaign
                    ? t`Saved draft`
                    : t`Not saved`}
          </span>
          {!mismatch && data?.campaign?.status === 1 ? (
            <Button disabled={busy} variant="outline" onClick={() => void save("pause")}>
              <Trans>Pause</Trans>
            </Button>
          ) : null}
          {draft && editable ? (
            <Button type="submit" form={`${formId}-form`} disabled={busy}>
              {data?.campaign ? <Trans>Save draft</Trans> : <Trans>Create draft</Trans>}
            </Button>
          ) : null}
          {onDone ? (
            <Button disabled={busy} variant="outline" onClick={done}>
              <Trans>Done</Trans>
            </Button>
          ) : null}
        </div>
      </header>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          <Trans>Could not load or save this sequence. Reopen it to try again.</Trans>
        </p>
      ) : null}
      {busy && !draft ? (
        <p role="status" className="p-6">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {draft ? (
        <div className="flex min-w-0 flex-col lg:flex-row">
          <aside
            className="flex max-w-full shrink-0 flex-col border-b bg-muted/30 lg:border-r lg:border-b-0"
            style={{ width: composerOpen ? composerWidth : undefined }}
          >
            <div className="flex items-center justify-between gap-2 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles size={15} aria-hidden />
                <Trans>Composer</Trans>
              </h3>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={composerOpen ? t`Collapse Composer` : t`Open Composer`}
                aria-expanded={composerOpen}
                onClick={() => setComposerOpen(!composerOpen)}
              >
                {composerOpen ? (
                  <ChevronDown size={14} aria-hidden />
                ) : (
                  <ChevronRight size={14} aria-hidden />
                )}
              </Button>
            </div>
            {composerOpen ? (
              <div className="flex flex-1 flex-col gap-4 px-4 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  <Trans>
                    Ask the assistant to draft this sequence or rewrite the email you have open.
                  </Trans>
                </p>
                <form
                  className="mt-auto space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!composer.trim() || !onAskAgent || busy) return;
                    onAskAgent(
                      t`For sequence "${draft?.name ?? data?.campaign?.name ?? "New sequence"}" in this role, email ${activeStep + 1}, subject "${draft?.steps[activeStep]?.subject ?? ""}", body: ${draft?.steps[activeStep]?.body ?? ""}. Request: ${composer.trim()}. Prepare draft changes only; do not send or activate. If the saved sequence cannot be identified uniquely, ask me to select it.`,
                    );
                    setComposer("");
                  }}
                >
                  <Textarea
                    aria-label={t`Ask Composer`}
                    name="sequence-composer"
                    rows={4}
                    maxLength={4000}
                    value={composer}
                    disabled={!onAskAgent}
                    onChange={(event) => setComposer(event.target.value)}
                    placeholder={t`Draft or rewrite an email…`}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    variant="outline"
                    disabled={!onAskAgent || !composer.trim() || busy}
                  >
                    <Send size={14} aria-hidden />
                    <Trans>Ask assistant</Trans>
                  </Button>
                </form>
                <label className="hidden text-xs text-muted-foreground lg:block">
                  <Trans>Composer width</Trans>
                  <input
                    type="range"
                    className="mt-2 block w-full accent-primary"
                    min={240}
                    max={420}
                    step={10}
                    value={composerWidth}
                    aria-label={t`Composer width`}
                    onChange={(event) => setComposerWidth(Number(event.target.value))}
                  />
                </label>
              </div>
            ) : null}
          </aside>
          <div className="min-w-0 flex-1 bg-muted/10 p-3 sm:p-5">
            {mismatch ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    This sequence is available for review only. Its saved draft is not linked to
                    this role.
                  </Trans>
                </p>
                <CampaignObservedDetails
                  details={observedDetails ?? data?.campaign?.observedDetails}
                  sender={data?.campaign?.eaccount}
                  stopOnReply={data?.campaign?.stopOnReply}
                  status={data?.campaign?.status}
                />
              </div>
            ) : !editable && !data?.campaign?.steps.length ? (
              <CampaignObservedDetails
                details={observedDetails ?? data?.campaign?.observedDetails}
                sender={data?.campaign?.eaccount}
                stopOnReply={data?.campaign?.stopOnReply}
                status={data?.campaign?.status}
              />
            ) : (
              <form
                id={`${formId}-form`}
                className="min-w-0"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(data?.campaign ? "save" : "create");
                }}
              >
                {!editable ? (
                  <p className="mb-4 text-sm text-muted-foreground">
                    <Trans>
                      This sequence is read-only. Sending changes require review in the
                      conversation.
                    </Trans>
                  </p>
                ) : null}
                <fieldset
                  disabled={busy || !editable}
                  className="mb-5 grid min-w-0 gap-3 sm:grid-cols-2"
                >
                  <label htmlFor={`${formId}-name`} className="space-y-1 text-xs">
                    <span>
                      <Trans>Sequence name</Trans>
                    </span>
                    <Input
                      id={`${formId}-name`}
                      name="sequence-name"
                      autoComplete="off"
                      required
                      maxLength={200}
                      value={draft.name}
                      onChange={(event) => change({ name: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span>
                      <Trans>Sending mailbox</Trans>
                    </span>
                    <select
                      className="w-full min-w-0 rounded-md border bg-background p-2 text-sm text-foreground"
                      name="sending-mailbox"
                      required
                      value={draft.eaccount}
                      onChange={(event) => change({ eaccount: event.target.value })}
                    >
                      <option value="">{t`Select a mailbox`}</option>
                      {data?.mailboxes.map((email) => (
                        <option key={email} value={email}>
                          {email}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
                <div className="grid min-w-0 gap-4 xl:grid-cols-[160px_minmax(0,1fr)]">
                  <nav
                    aria-label={t`Email steps`}
                    className="flex min-w-0 gap-2 overflow-x-auto xl:sticky xl:top-0 xl:flex-col xl:self-start"
                  >
                    {draft.steps.map((step, index) => (
                      <button
                        type="button"
                        key={index}
                        aria-label={t`Go to email ${index + 1}`}
                        aria-current={activeStep === index ? "step" : undefined}
                        onClick={() => focusStep(index)}
                        className="min-w-36 rounded-lg border bg-background p-3 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-current:border-foreground"
                      >
                        <span className="mb-1 flex items-center gap-2 font-semibold">
                          <Mail size={13} aria-hidden />
                          <Trans>Email {index + 1}</Trans>
                        </span>
                        <span className="block truncate" title={draft.eaccount}>
                          {draft.eaccount || t`Choose sender`}
                        </span>
                        <span className="mt-1 block text-muted-foreground">
                          {step.delay_days === 0
                            ? t`No delay`
                            : t`Wait ${step.delay_days} calendar days`}
                        </span>
                      </button>
                    ))}
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy || draft.steps.length >= 10}
                        onClick={addStep}
                      >
                        <Plus size={14} aria-hidden />
                        <Trans>Add email</Trans>
                      </Button>
                    ) : null}
                  </nav>
                  <div className="min-w-0 space-y-5">
                    {draft.steps.map((step, index) => (
                      <section
                        key={index}
                        id={`${formId}-step-${index}`}
                        aria-label={t`Email ${index + 1}`}
                        className="min-w-0 scroll-mt-4"
                        data-active={activeStep === index || undefined}
                      >
                        <details className="mb-3 rounded-md border border-dashed bg-background text-xs">
                          <summary className="flex cursor-pointer items-center gap-2 p-3">
                            <Clock3 size={14} aria-hidden />
                            {step.delay_days === 0
                              ? t`No delay before email ${index + 1}`
                              : t`Wait ${step.delay_days} calendar days`}
                            <span className="ms-auto truncate">{draft.timezone}</span>
                          </summary>
                          <fieldset
                            disabled={busy || !editable}
                            className="grid gap-3 border-t p-3 sm:grid-cols-3"
                          >
                            <label htmlFor={`${formId}-delay-${index}`} className="space-y-1">
                              <span>
                                <Trans>Wait days</Trans>
                              </span>
                              <Input
                                id={`${formId}-delay-${index}`}
                                name={`delay-${index}`}
                                type="number"
                                required
                                min={0}
                                max={366}
                                value={step.delay_days}
                                onChange={(event) =>
                                  changeStep(index, { delay_days: Number(event.target.value) })
                                }
                              />
                              <span className="text-muted-foreground">
                                <Trans>Calendar days</Trans>
                              </span>
                            </label>
                            <label className="space-y-1">
                              <span>
                                <Trans>Delivery</Trans>
                              </span>
                              <select
                                className="w-full rounded-md border bg-background p-2 text-foreground"
                                name={`delivery-${index}`}
                                value={draft.send_hours}
                                onChange={(event) =>
                                  change({
                                    send_hours: event.target
                                      .value as RecruitingSequenceDraft["send_hours"],
                                  })
                                }
                              >
                                <option value="weekdays_9_to_5">{t`Weekdays, 9–5`}</option>
                                <option value="any_time">{t`Any time`}</option>
                              </select>
                            </label>
                            <label htmlFor={`${formId}-timezone-${index}`} className="space-y-1">
                              <span>
                                <Trans>Timezone</Trans>
                              </span>
                              <Input
                                id={`${formId}-timezone-${index}`}
                                name={index === 0 ? "timezone" : `timezone-${index}`}
                                autoComplete="off"
                                spellCheck={false}
                                required
                                maxLength={64}
                                value={draft.timezone}
                                onChange={(event) => change({ timezone: event.target.value })}
                              />
                            </label>
                          </fieldset>
                          <p className="border-t px-3 py-2 text-muted-foreground">
                            <Trans>Delivery hours and timezone apply to the whole sequence.</Trans>
                          </p>
                        </details>
                        <div
                          className={`min-w-0 rounded-lg border bg-background ${activeStep === index ? "border-foreground/40" : "border-border"}`}
                        >
                          <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                            <h3 className="flex items-center gap-2 text-sm font-semibold">
                              <Mail size={14} aria-hidden />
                              <Trans>Email {index + 1}</Trans>
                            </h3>
                            <div className="flex gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setActiveStep(index);
                                  setPreview(preview === index ? undefined : index);
                                }}
                              >
                                <Trans>Preview email {index + 1}</Trans>
                              </Button>
                              {editable && draft.steps.length > 1 ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={busy}
                                  aria-label={t`Remove email ${index + 1}`}
                                  onClick={() => {
                                    change({ steps: draft.steps.filter((_, i) => i !== index) });
                                    setActiveStep(Math.max(0, index - 1));
                                    setPreview(undefined);
                                  }}
                                >
                                  <X size={14} aria-hidden />
                                </Button>
                              ) : null}
                            </div>
                          </header>
                          <fieldset disabled={busy || !editable} className="min-w-0 space-y-3 p-4">
                            <p className="break-words text-xs text-muted-foreground">
                              <Trans>From</Trans> · {draft.eaccount || "—"}
                            </p>
                            <label
                              htmlFor={`${formId}-subject-${index}`}
                              className="block space-y-1 text-xs"
                            >
                              <span>
                                <Trans>Subject</Trans>
                              </span>
                              <Input
                                id={`${formId}-subject-${index}`}
                                name={`subject-${index}`}
                                required
                                maxLength={500}
                                autoComplete="off"
                                value={step.subject}
                                onChange={(event) =>
                                  changeStep(index, { subject: event.target.value })
                                }
                              />
                            </label>
                            <fieldset
                              aria-label={t`Insert variable`}
                              className="flex flex-wrap gap-1"
                            >
                              {tokens.map((token) => (
                                <Button
                                  key={token}
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="font-mono text-xs"
                                  onClick={() =>
                                    changeStep(index, { body: `${step.body}{{${token}}}` })
                                  }
                                >{`{{${token}}}`}</Button>
                              ))}
                            </fieldset>
                            <label
                              htmlFor={`${formId}-body-${index}`}
                              className="block space-y-1 text-xs"
                            >
                              <span>
                                <Trans>Message · plain text</Trans>
                              </span>
                              <Textarea
                                id={`${formId}-body-${index}`}
                                name={`body-${index}`}
                                required
                                rows={8}
                                maxLength={20000}
                                autoComplete="off"
                                className="leading-relaxed"
                                value={step.body}
                                onChange={(event) =>
                                  changeStep(index, { body: event.target.value })
                                }
                              />
                            </label>
                          </fieldset>
                          {preview === index ? (
                            <section
                              aria-label={t`Email preview`}
                              className="space-y-3 border-t bg-muted/30 p-4 text-sm"
                            >
                              <p className="text-xs text-muted-foreground">
                                <Trans>Preview only · variables remain unfilled</Trans>
                              </p>
                              <h4 className="break-words font-semibold">
                                {step.subject || t`No subject`}
                              </h4>
                              <p className="whitespace-pre-wrap break-words">
                                {step.body.split(/(\{\{[^{}]+\}\})/g).map((part, partIndex) =>
                                  /^\{\{/.test(part) ? (
                                    <mark
                                      key={partIndex}
                                      className="rounded bg-muted px-1 font-mono text-foreground"
                                    >
                                      {part}
                                    </mark>
                                  ) : (
                                    part
                                  ),
                                )}
                              </p>
                            </section>
                          ) : null}
                        </div>
                      </section>
                    ))}
                    {editable ? (
                      <Button
                        type="button"
                        className="w-full"
                        variant="outline"
                        disabled={busy || draft.steps.length >= 10}
                        onClick={addStep}
                      >
                        <Plus size={14} aria-hidden />
                        <Trans>Add email</Trans>
                      </Button>
                    ) : null}
                    <div className="border-t pt-4 text-xs text-muted-foreground">
                      <p>
                        <Trans>
                          Any reply stops remaining follow-ups when stop on reply is enabled.
                        </Trans>
                      </p>
                      <details className="mt-3">
                        <summary className="cursor-pointer">
                          <Trans>More email options</Trans>
                        </summary>
                        <p className="mt-2 leading-relaxed">
                          <Trans>
                            Rich formatting, reply threading, signatures, attachments, snippets,
                            unsubscribe settings and business-day delays cannot be changed in this
                            draft editor.
                          </Trans>
                        </p>
                      </details>
                    </div>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
      {data?.campaign && onAskAgent && !mismatch ? (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
          <Button
            variant="outline"
            disabled={busy || dirty}
            title={dirty ? t`Save the draft before reviewing a send` : undefined}
            onClick={() =>
              onAskAgent(
                t`Review the saved sequence "${data.campaign!.name}" in this role and prepare its send confirmation with the exact saved emails and recipients. If this sequence cannot be identified uniquely, ask me to select it. Do not substitute another sequence.`,
              )
            }
          >
            <Trans>Review and send</Trans>
          </Button>
        </footer>
      ) : null}
      <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Discard unsaved changes?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Your saved sequence will stay unchanged.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep editing</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmExit(false);
                onDone?.();
              }}
            >
              <Trans>Discard changes</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
