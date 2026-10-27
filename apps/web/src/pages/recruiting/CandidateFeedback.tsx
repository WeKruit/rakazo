import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingFeedbackRecord } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";
import type { CandidateDiscussionContext, CandidateFeedback, Props } from "./workspace-types";
export function CandidateFeedbackForm({
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

export function FeedbackHistory({
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
