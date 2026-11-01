import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingSequenceOutput } from "@rakazo/contracts";
import { hideVendorNames } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import { rpc } from "../../lib/rpc";
import { CampaignObservedDetails } from "./CampaignObservedDetails";
import { RetryNotice } from "./RetryNotice";
import { TabLoading } from "./shared";

type Person = { key: string; name: string; email?: string | null; linkedinUrl?: string | null };
type Choice = {
  key: string;
  roleId: string;
  roleTitle: string;
  groupId: string;
  serverId: string;
  campaignId: string;
  name: string;
};

/** Saved sequence choice and exact content preview, followed by the existing approval-aware chat. */
export function AddToSequenceDialog({
  open,
  onOpenChange,
  people,
  roleId,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: readonly Person[];
  roleId?: string;
  onContinue: (message: string) => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const previewEpoch = useRef(0);
  const [choices, setChoices] = useState<{ scope: string; items: Choice[] }>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: RecruitingSequenceOutput }>();
  const [stage, setStage] = useState<"setup" | "preview">("setup");
  const [start, setStart] = useState<"saved" | "later">("saved");
  const [when, setWhen] = useState("");
  const [zone, setZone] = useState(localTimezone);
  const scope = roleId ?? "all";
  const selectionKey = JSON.stringify(people.map((person) => person.key));
  useEffect(() => {
    setStage("setup");
    setPreview(undefined);
  }, [selectionKey, scope]);
  useEffect(() => {
    previewEpoch.current++;
    setReading(false);
    setStage("setup");
    setPreview(undefined);
  }, [open, selected, scope]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setError(false);
    void (async () => {
      const items = new Map<string, Choice>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await rpc.recruiting.accountView(
          { view: "sequence", roleId, cursor, limit: 50 },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        for (const item of page.items) {
          const role = page.roles.find((entry) => entry.id === item.roleId);
          if (!role?.groupId) continue;
          for (const entry of item.campaigns ?? (item.campaign ? [item.campaign] : [])) {
            if (!entry.campaign || !entry.serverId) continue;
            const key = JSON.stringify([item.roleId, entry.serverId, entry.campaign.id]);
            items.set(key, {
              key,
              roleId: item.roleId,
              roleTitle: role.title,
              groupId: role.groupId,
              serverId: entry.serverId,
              campaignId: entry.campaign.id,
              name: hideVendorNames(entry.campaign.name),
            });
          }
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated sequence cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!abort.signal.aborted) setChoices({ scope, items: [...items.values()] });
    })().catch(() => {
      if (!abort.signal.aborted) setError(true);
    });
    return () => abort.abort();
  }, [open, scope, reload]);
  const items = choices?.scope === scope ? choices.items : undefined;
  const choice = items?.find((entry) => entry.key === selected);
  const saved = preview?.key === selected ? preview.data.campaign : null;
  const ready = choice && people.length && !reading && (start !== "later" || Boolean(when && zone));
  const readPreview = async () => {
    if (!ready || !choice) return;
    const generation = ++previewEpoch.current;
    setReading(true);
    setError(false);
    try {
      const data = await rpc.recruiting.sequenceDraft({
        groupId: choice.groupId,
        command: {
          operation: "read",
          roleId: choice.roleId,
          serverId: choice.serverId,
          campaignId: choice.campaignId,
        },
      });
      if (
        data.roleId !== choice.roleId ||
        data.campaign?.id !== choice.campaignId ||
        (!data.campaign.steps.length &&
          !data.campaign.observedDetails?.sequences?.some((sequence) =>
            sequence?.steps?.some(
              (step) =>
                step?.type === "email" &&
                step.variants?.some((variant) => variant?.body || variant?.subject),
            ),
          ))
      )
        throw new Error("Sequence preview unavailable");
      if (generation !== previewEpoch.current) return;
      setPreview({ key: choice.key, data });
      setStage("preview");
    } catch {
      if (generation === previewEpoch.current) setError(true);
    } finally {
      if (generation === previewEpoch.current) setReading(false);
    }
  };
  const handoff = () => {
    if (!choice || !saved) return;
    const recipients = people
      .map((person) =>
        [person.name, person.email ?? t`Email not saved`, person.linkedinUrl]
          .filter(Boolean)
          .join(" · "),
      )
      .join("\n");
    const schedule =
      start === "later"
        ? `${when} (${zone})`
        : t`Use the saved schedule; verify any missing hours or time zone before activation.`;
    const canonical = saved.steps
      .map(
        (step, index) =>
          `${index + 1}. ${t`Day delay`}: ${step.delay_days}\n${step.subject}\n${step.body}`,
      )
      .join("\n\n");
    const steps =
      canonical ||
      saved.observedDetails?.sequences
        ?.flatMap(
          (sequence) =>
            sequence?.steps?.flatMap(
              (step) =>
                step?.variants?.flatMap((variant) =>
                  variant ? [variant.subject, variant.body].filter(Boolean).join("\n") : [],
                ) ?? [],
            ) ?? [],
        )
        .join("\n\n") ||
      "";
    onContinue(
      t`Prepare adding exactly ${people.length} selected people to the saved sequence ${choice.name} in role ${choice.roleTitle}. Verify this exact saved sequence, sender and current enrollment before changing anything. Sender: ${saved.eaccount ?? t`Not saved`}. Requested start: ${schedule}. Use saved email addresses only; resolve missing addresses with me before enrollment. Show the final recipients, content and schedule in the existing approval flow before any sending.` +
        `\n\n${recipients}\n\n${steps}`,
    );
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add to sequence</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>{people.length} selected people</Trans>
        </p>
        {stage === "setup" ? (
          <>
            {!items && !error ? <TabLoading /> : null}
            {items ? (
              <label htmlFor={`${formId}-sequence`} className="space-y-1 text-sm">
                <span>
                  <Trans>Sequence</Trans>
                </span>
                <NativeSelect
                  id={`${formId}-sequence`}
                  aria-label={t`Sequence`}
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setPreview(undefined);
                  }}
                >
                  <NativeSelectOption value="">
                    <Trans>Select a saved sequence</Trans>
                  </NativeSelectOption>
                  {items.map((entry) => (
                    <NativeSelectOption key={entry.key} value={entry.key}>
                      {entry.name} · {entry.roleTitle}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {items && !items.length ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No saved sequences in this scope.</Trans>
              </p>
            ) : null}
            {choice ? (
              <p className="text-sm">
                <Trans>Recipients will be associated with {choice.roleTitle}.</Trans>
              </p>
            ) : null}
            <label htmlFor={`${formId}-email`} className="space-y-1 text-sm">
              <span>
                <Trans>Email preference</Trans>
              </span>
              <NativeSelect
                id={`${formId}-email`}
                aria-label={t`Email preference`}
                value="saved"
                onChange={() => undefined}
              >
                <NativeSelectOption value="saved">
                  <Trans>Saved addresses only</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </label>
            <label htmlFor={`${formId}-start`} className="space-y-1 text-sm">
              <span>
                <Trans>Start</Trans>
              </span>
              <NativeSelect
                id={`${formId}-start`}
                aria-label={t`Sequence start`}
                value={start}
                onChange={(event) => setStart(event.target.value as typeof start)}
              >
                <NativeSelectOption value="saved">
                  <Trans>Use saved schedule</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="later">
                  <Trans>Choose a start time</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </label>
            {start === "later" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label htmlFor={`${formId}-when`} className="space-y-1 text-sm">
                  <span>
                    <Trans>Start date and time</Trans>
                  </span>
                  <Input
                    id={`${formId}-when`}
                    aria-label={t`Start date and time`}
                    type="datetime-local"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                  />
                </label>
                <label htmlFor={`${formId}-zone`} className="space-y-1 text-sm">
                  <span>
                    <Trans>Time zone</Trans>
                  </span>
                  <NativeSelect
                    id={`${formId}-zone`}
                    aria-label={t`Sequence time zone`}
                    value={zone}
                    onChange={(event) => setZone(event.target.value)}
                  >
                    {[...new Set([zone, ...Intl.supportedValuesOf("timeZone")])].map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {value}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              </div>
            ) : null}
            <details className="rounded-lg bg-muted p-3 text-sm">
              <summary className="cursor-pointer">
                <Trans>More details</Trans>
              </summary>
              <ul className="mt-2 space-y-1">
                {people.map((person) => (
                  <li key={person.key} className="break-words">
                    {person.name} · {person.email ?? t`Email not saved`}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : saved ? (
          <div className="space-y-3">
            <h3 className="font-medium">{choice?.name}</h3>
            <p className="text-sm">{choice?.roleTitle}</p>
            <ul className="space-y-1 text-sm">
              {people.map((person) => (
                <li key={person.key} className="break-words">
                  {person.name} · {person.email ?? t`Email not saved`}
                </li>
              ))}
            </ul>
            <p className="break-words text-sm">
              <Trans>Sender</Trans>: {saved.eaccount ?? t`Not saved`}
            </p>
            <p className="text-sm">
              {start === "later"
                ? `${when} · ${zone}`
                : [
                    saved.timezone,
                    saved.send_hours === "weekdays_9_to_5"
                      ? t`Weekdays, 9 to 5`
                      : saved.send_hours === "any_time"
                        ? t`Any time`
                        : t`Schedule not saved`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
            {saved.steps.length ? (
              <ol className="space-y-3">
                {saved.steps.map((step, index) => (
                  <li key={index} className="space-y-2 rounded-lg border p-3">
                    <h4 className="font-medium">
                      <Trans>Step {index + 1}</Trans> · <Trans>{step.delay_days} days later</Trans>
                    </h4>
                    <p className="break-words text-sm font-medium">{step.subject}</p>
                    <p className="break-words whitespace-pre-wrap text-sm">{step.body}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <CampaignObservedDetails details={saved.observedDetails} />
            )}
            <p className="text-xs text-muted-foreground">
              <Trans>This preview has not enrolled anyone or sent email.</Trans>
            </p>
          </div>
        ) : null}
        {error ? (
          <RetryNotice
            onRetry={() => {
              setChoices(undefined);
              setReload((value) => value + 1);
            }}
          >
            <Trans>Could not load the saved sequence. Your selection is preserved.</Trans>
          </RetryNotice>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          {stage === "preview" ? (
            <>
              <Button variant="ghost" onClick={() => setStage("setup")}>
                <Trans>Back</Trans>
              </Button>
              <Button disabled={!saved || !choice} onClick={handoff}>
                <Trans>Continue in chat</Trans>
              </Button>
            </>
          ) : (
            <Button disabled={!ready} onClick={() => void readPreview()}>
              <Trans>Preview steps</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
