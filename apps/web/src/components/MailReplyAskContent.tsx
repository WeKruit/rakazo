import { Trans, useLingui } from "@lingui/react/macro";
import type { AskAnswer, MailReply } from "@rakazo/contracts";
import { MailReplySendAnswerSchema } from "@rakazo/contracts";
import { Badge, Button, Input, Textarea } from "@rakazo/ui-web";
import { ChevronDown, Mail } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AskDeadline } from "./AskDeadline";
import { LoadingState } from "./ai/primitives";

/** Content of the existing approval card; both Inbox and the transcript render AskCard. */
export function MailReplyAskContent({
  reply,
  canAnswer,
  expiresAt,
  onAnswer,
}: {
  reply: MailReply;
  canAnswer: boolean;
  expiresAt?: string | null;
  onAnswer: (answer: AskAnswer) => Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const id = useId();
  const inFlight = useRef(false);
  const [body, setBody] = useState(reply.body);
  const [cc, setCc] = useState(reply.cc.join(", "));
  const [showCc, setShowCc] = useState(reply.cc.length > 0);
  const [expanded, setExpanded] = useState(reply.status !== "sent");
  const [pending, setPending] = useState<"send" | "discard" | null>(null);
  const [accepted, setAccepted] = useState<"send" | "discard" | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (reply.status !== "needs_approval") {
      setBody(reply.body);
      setCc(reply.cc.join(", "));
      if (reply.status === "sent") setExpanded(false);
    }
  }, [reply.status, reply.body, reply.cc.join(", ")]);
  const submitted = pending ?? accepted;
  const status =
    reply.status === "needs_approval" && submitted
      ? submitted === "send"
        ? "sending"
        : "discarded"
      : reply.status;
  const editable = canAnswer && status === "needs_approval";
  const localPreview = reply.status === "needs_approval" && submitted === "send";
  const displayedCc = localPreview
    ? cc
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : reply.cc;
  const labels: Record<MailReply["status"], string> = {
    needs_approval: t`Needs approval`,
    sending: t`Sending…`,
    sent: t`Sent`,
    discarded: t`Discarded`,
    failed: t`Failed`,
    unknown: t`Delivery unconfirmed`,
  };
  const anchor = [reply.inReplyTo.subject, reply.inReplyTo.sender].filter(Boolean).join(" · ");

  async function submit(action: "send" | "discard") {
    if (!editable || inFlight.current) return;
    const answer =
      action === "discard"
        ? "deny"
        : MailReplySendAnswerSchema.safeParse({
            action: "send",
            body,
            cc: cc
              .split(",")
              .map((address) => address.trim())
              .filter(Boolean),
          });
    if (answer !== "deny" && !answer.success) {
      setError(t`Enter a reply and valid Cc email addresses.`);
      return;
    }
    inFlight.current = true;
    setPending(action);
    setError(undefined);
    try {
      await onAnswer(answer === "deny" ? answer : answer.data);
      setAccepted(action);
    } catch {
      inFlight.current = false;
      setError(
        action === "send" ? t`Could not submit this reply.` : t`Could not discard this reply.`,
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="mail-reply-card" data-status={status}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left text-sm"
        aria-expanded={expanded}
        aria-controls={`${id}-email`}
        onClick={() => setExpanded((value) => !value)}
      >
        <Mail className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">
          <Trans>Mail</Trans>
        </span>
        {status === "sent" ? (
          <span className="shrink-0">
            <Trans>Sent email</Trans>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{reply.from}</span>
        <Badge
          variant="outline"
          className={
            status === "sent"
              ? "text-success"
              : status === "failed"
                ? "text-destructive"
                : undefined
          }
        >
          {labels[status]}
        </Badge>
        <ChevronDown
          className={`size-4 shrink-0 ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {status === "sent" && reply.sentAt && Number.isFinite(Date.parse(reply.sentAt)) ? (
        <time className="block text-xs text-muted-foreground" dateTime={reply.sentAt}>
          {new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(reply.sentAt),
          )}
        </time>
      ) : null}
      {status === "sending" ? <LoadingState label={t`Sending…`} /> : null}
      {expanded ? (
        <div id={`${id}-email`} className="space-y-4">
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">
              <Trans>From</Trans>
            </dt>
            <dd className="break-words">{reply.from ?? t`Sender unavailable`}</dd>
            <dt className="text-muted-foreground">
              <Trans>In reply to</Trans>
            </dt>
            <dd className="break-words">
              {reply.inReplyTo.inboxKey ? (
                <Link
                  className="underline underline-offset-2"
                  to={`/app?view=inbox&role=all&mailThread=${encodeURIComponent(reply.inReplyTo.inboxKey)}`}
                >
                  {anchor || t`Original email`}
                </Link>
              ) : (
                anchor || t`Original email`
              )}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>To</Trans>
            </dt>
            <dd className="flex min-w-0 items-start justify-between gap-2">
              <span className="break-words">
                {reply.to.join(", ") || t`Recipients unavailable`}
              </span>
              {editable && !showCc ? (
                <Button size="sm" variant="ghost" onClick={() => setShowCc(true)}>
                  <Trans>Add Cc</Trans>
                </Button>
              ) : null}
            </dd>
            {(editable && showCc) || (!editable && displayedCc.length > 0) ? (
              <>
                <dt className="self-center text-muted-foreground">
                  <label htmlFor={`${id}-cc`}>
                    <Trans>Cc</Trans>
                  </label>
                </dt>
                <dd className="min-w-0">
                  {editable ? (
                    <Input
                      id={`${id}-cc`}
                      aria-label={t`Cc`}
                      value={cc}
                      onChange={(event) => setCc(event.target.value)}
                    />
                  ) : (
                    <span className="break-words">{displayedCc.join(", ")}</span>
                  )}
                </dd>
              </>
            ) : null}
            {reply.bcc.length > 0 ? (
              <>
                <dt className="text-muted-foreground">
                  <Trans>Bcc</Trans>
                </dt>
                <dd className="break-words">{reply.bcc.join(", ")}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">
              <Trans>Subject</Trans>
            </dt>
            <dd className="break-words">{reply.subject}</dd>
          </dl>
          {editable ? (
            <Textarea
              aria-label={t`Reply body`}
              className="min-h-40 max-h-[60vh] text-base leading-relaxed"
              maxLength={20000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          ) : (
            <div className="break-words whitespace-pre-wrap text-sm leading-relaxed">
              {localPreview ? body : reply.body}
            </div>
          )}
        </div>
      ) : null}
      {editable ? (
        <>
          {expiresAt ? <AskDeadline expiresAt={expiresAt} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => void submit("discard")}>
              <Trans>Discard</Trans>
            </Button>
            <Button disabled={!body.trim()} onClick={() => void submit("send")}>
              <Trans>Send</Trans>
            </Button>
          </div>
        </>
      ) : status === "needs_approval" ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No longer active</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
