import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingSequenceDraft,
  RecruitingSequenceInput,
  RecruitingSequenceOutput,
} from "@rakazo/contracts";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";

export type SequenceEditorProps = {
  roleId: string;
  serverId: string;
  execute: (input: RecruitingSequenceInput) => Promise<RecruitingSequenceOutput>;
  onAskAgent?: (message: string) => void;
};
const emptyStep = () => ({ subject: "", body: "", delay_days: 0 });
const tokens = ["first_name", "last_name", "company_name", "personalization"];

/** The saved provider draft is the only persisted sequence. */
export function SequenceEditor({ roleId, serverId, execute, onAskAgent }: SequenceEditorProps) {
  const { t } = useLingui();
  const formId = useId();
  const [data, setData] = useState<RecruitingSequenceOutput>();
  const [draft, setDraft] = useState<RecruitingSequenceDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const accept = (result: RecruitingSequenceOutput) => {
    setData(result);
    const campaign = result.campaign;
    setDraft({
      name: campaign?.name ?? result.roleTitle,
      eaccount: campaign?.eaccount ?? result.mailboxes[0] ?? "",
      steps: campaign?.steps.length ? campaign.steps : [emptyStep()],
      timezone: campaign?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      send_hours: campaign?.send_hours ?? "weekdays_9_to_5",
    });
  };
  useEffect(() => {
    const current = ++epoch.current;
    setData(undefined);
    setDraft(undefined);
    setBusy(true);
    setError(false);
    setSaved(false);
    void Promise.resolve()
      .then(() => execute({ operation: "read", roleId, serverId }))
      .then((result) => {
        if (epoch.current === current) accept(result);
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
  }, [roleId, serverId, execute]);
  const change = (patch: Partial<RecruitingSequenceDraft>) => {
    setDraft((value) => (value ? { ...value, ...patch } : value));
    setSaved(false);
  };
  const save = async (operation: "create" | "save" | "pause") => {
    if (!draft || busy) return;
    const current = epoch.current;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const input: RecruitingSequenceInput =
        operation === "create"
          ? { operation, roleId, serverId, draft }
          : operation === "save"
            ? { operation, roleId, serverId, campaignId: data!.campaign!.id, draft }
            : { operation, roleId, serverId, campaignId: data!.campaign!.id };
      const result = await execute(input);
      if (current === epoch.current) {
        accept(result);
        setSaved(true);
      }
    } catch {
      if (current === epoch.current) setError(true);
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const editable = !data?.campaign || data.campaign.editable;
  return (
    <section aria-label={t`Sequence draft`} className="min-w-0 space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold leading-snug">
          <Trans>Sequence draft</Trans>
        </h3>
        {data?.campaign?.status === 1 ? (
          <Button disabled={busy} variant="outline" onClick={() => void save("pause")}>
            <Trans>Pause</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not load or save this sequence. Reopen it to try again.</Trans>
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Saved</Trans>
        </p>
      ) : null}
      {busy && !draft ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {draft && editable ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save(data?.campaign ? "save" : "create");
          }}
        >
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <label htmlFor={`${formId}-name`} className="block space-y-1 text-sm">
              <span>
                <Trans>Name</Trans>
              </span>
              <Input
                autoComplete="off"
                id={`${formId}-name`}
                name="sequence-name"
                required
                maxLength={200}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>
                <Trans>Sending mailbox</Trans>
              </span>
              <select
                required
                className="w-full min-w-0 rounded-md border bg-background p-2"
                name="sending-mailbox"
                value={draft.eaccount}
                onChange={(e) => change({ eaccount: e.target.value })}
              >
                <option value="">{t`Select a mailbox`}</option>
                {data?.mailboxes.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-sm">
                <span>
                  <Trans>Delivery</Trans>
                </span>
                <select
                  className="w-full rounded-md border bg-background p-2"
                  name="delivery"
                  value={draft.send_hours}
                  onChange={(e) =>
                    change({ send_hours: e.target.value as RecruitingSequenceDraft["send_hours"] })
                  }
                >
                  <option value="weekdays_9_to_5">{t`Weekdays, 9–5`}</option>
                  <option value="any_time">{t`Any time`}</option>
                </select>
              </label>
              <label htmlFor={`${formId}-timezone`} className="block space-y-1 text-sm">
                <span>
                  <Trans>Timezone</Trans>
                </span>
                <Input
                  autoComplete="off"
                  id={`${formId}-timezone`}
                  name="timezone"
                  spellCheck={false}
                  required
                  maxLength={64}
                  value={draft.timezone}
                  onChange={(e) => change({ timezone: e.target.value })}
                />
              </label>
            </div>
            <ol className="space-y-4">
              {draft.steps.map((step, index) => {
                const changeStep = (patch: Partial<typeof step>) =>
                  change({
                    steps: draft.steps.map((item, i) =>
                      i === index ? { ...item, ...patch } : item,
                    ),
                  });
                return (
                  <li key={index} className="min-w-0 space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-medium">
                        <Trans>Email {index + 1}</Trans>
                      </h4>
                      {draft.steps.length > 1 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            change({ steps: draft.steps.filter((_, i) => i !== index) })
                          }
                        >
                          <Trans>Remove</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <label htmlFor={`${formId}-delay-${index}`} className="block space-y-1 text-sm">
                      <span>
                        <Trans>Wait days</Trans>
                      </span>
                      <Input
                        autoComplete="off"
                        id={`${formId}-delay-${index}`}
                        name={`delay-${index}`}
                        required
                        type="number"
                        min={0}
                        max={366}
                        value={step.delay_days}
                        onChange={(e) => changeStep({ delay_days: Number(e.target.value) })}
                      />
                    </label>
                    <label
                      htmlFor={`${formId}-subject-${index}`}
                      className="block space-y-1 text-sm"
                    >
                      <span>
                        <Trans>Subject</Trans>
                      </span>
                      <Input
                        autoComplete="off"
                        id={`${formId}-subject-${index}`}
                        name={`subject-${index}`}
                        required
                        maxLength={500}
                        value={step.subject}
                        onChange={(e) => changeStep({ subject: e.target.value })}
                      />
                    </label>
                    <label htmlFor={`${formId}-body-${index}`} className="block space-y-1 text-sm">
                      <span>
                        <Trans>Message</Trans>
                      </span>
                      <Textarea
                        autoComplete="off"
                        id={`${formId}-body-${index}`}
                        name={`body-${index}`}
                        required
                        maxLength={20_000}
                        rows={6}
                        value={step.body}
                        onChange={(e) => changeStep({ body: e.target.value })}
                      />
                    </label>
                    <fieldset className="flex flex-wrap gap-1" aria-label={t`Insert variable`}>
                      {tokens.map((token) => (
                        <Button
                          key={token}
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => changeStep({ body: `${step.body}{{${token}}}` })}
                        >{`{{${token}}}`}</Button>
                      ))}
                    </fieldset>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={draft.steps.length >= 10}
                onClick={() => change({ steps: [...draft.steps, emptyStep()] })}
              >
                <Trans>Add email</Trans>
              </Button>
              <Button type="submit">
                {data?.campaign ? <Trans>Save draft</Trans> : <Trans>Create draft</Trans>}
              </Button>
            </div>
          </fieldset>
        </form>
      ) : draft ? (
        <p className="text-sm text-muted-foreground">
          <Trans>This sequence is available to review in the conversation.</Trans>
        </p>
      ) : null}
      {data?.campaign && onAskAgent ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            onAskAgent(
              t`Review the saved sequence and prepare the send confirmation for this role.`,
            )
          }
        >
          <Trans>Review and send</Trans>
        </Button>
      ) : null}
    </section>
  );
}
