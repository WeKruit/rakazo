import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ChevronDown, Mail, Reply, UserRound } from "lucide-react";
import { Fragment, useEffect, useId, useRef } from "react";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import type { RecruitingInboxEmail } from "./InboxTab";
import { ProfileImage } from "./ProfileImage";
import { initials } from "./profile";
import { formatDate } from "./shared";

/** Exact saved messages; candidateId is present on the existing role-wide mail projection. */
export type EmailConversationItem = RecruitingInboxEmail["email"] & { candidateId?: string };

export type EmailConversationProps = {
  artifactTarget?: ArtifactTarget;
  /** Caller owns the source read, message order, and any real thread scope. */
  items: readonly EmailConversationItem[];
  candidateId?: string;
  selectedId?: string;
  onSelect: (email: EmailConversationItem) => void;
  candidateName?: string | null;
  candidateTitle?: string | null;
  candidatePhotoUrl?: string | null;
  onOpenProfile?: () => void;
  /** Requests a draft for this exact message; this component has no send action. */
  onDraftReply?: (email: EmailConversationItem) => void;
};

function MessageTime({ date }: { date: string | null }) {
  return date && Number.isFinite(Date.parse(date)) ? (
    <time dateTime={date} className="text-xs text-muted-foreground">
      {formatDate(date)}
    </time>
  ) : (
    <span className="text-xs text-muted-foreground">
      <Trans>Time not recorded</Trans>
    </span>
  );
}

function MessageBody({
  email,
  artifactTarget,
}: {
  email: EmailConversationItem;
  artifactTarget?: ArtifactTarget;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-4 px-4 pb-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          <Trans>From</Trans>
        </dt>
        <dd className="break-words">{email.sender || t`Sender unavailable`}</dd>
        <dt className="text-muted-foreground">
          <Trans>To</Trans>
        </dt>
        <dd className="break-words">
          {email.recipients.length ? email.recipients.join(", ") : t`Recipients unavailable`}
        </dd>
        {[
          { label: t`Cc`, addresses: email.cc },
          { label: t`Bcc`, addresses: email.bcc },
        ]
          .filter((header) => header.addresses?.length)
          .map((header) => (
            <Fragment key={header.label}>
              <dt className="text-muted-foreground">{header.label}</dt>
              <dd className="break-words">{header.addresses!.join(", ")}</dd>
            </Fragment>
          ))}
      </dl>
      {email.partial ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Preview only. Ask for the complete message to read the full body.</Trans>
        </p>
      ) : null}
      <div className="break-words whitespace-pre-wrap text-sm leading-relaxed">
        {email.body || t`Message body unavailable`}
      </div>
      {artifactTarget
        ? email.attachments?.map((file) => (
            <ArtifactFileCard
              key={file.id}
              target={artifactTarget}
              artifactId={file.id}
              name={file.name}
              mimeType={file.mimeType}
              size={file.size}
            />
          ))
        : null}
    </div>
  );
}

function MessageHeading({ email }: { email: EmailConversationItem }) {
  const { t } = useLingui();
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium">
          {email.sender || t`Sender unavailable`}
        </span>
        <MessageTime date={email.date} />
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm">{email.subject || t`No subject`}</span>
        {email.direction === "sent" ? (
          <Badge variant="outline">
            <Trans>Sent</Trans>
          </Badge>
        ) : email.direction === "received" ? (
          <Badge variant="outline">
            <Trans>Received</Trans>
          </Badge>
        ) : null}
      </span>
    </span>
  );
}

/**
 * A presentational history of supplied messages. It does not infer reply relationships, group
 * unrelated subjects into a thread, or claim delivery/read status beyond the saved direction.
 */
export function EmailConversation({
  artifactTarget,
  items,
  candidateId,
  selectedId,
  onSelect,
  candidateName,
  candidateTitle,
  candidatePhotoUrl,
  onOpenProfile,
  onDraftReply,
}: EmailConversationProps) {
  const { t } = useLingui();
  const headingId = useId();
  const openedFromHistory = useRef<string | null>(null);
  const selectedArticle = useRef<HTMLElement>(null);
  const messages = candidateId
    ? items.filter((email) => email.candidateId === undefined || email.candidateId === candidateId)
    : items;
  const selected = messages.find((email) => email.id === selectedId) ?? messages[0];
  // Only provider-supplied thread IDs group emails; an unthreaded message is its own choice.
  const hasThreads = messages.some((email) => email.threadId);
  const groupKey = (email: EmailConversationItem) =>
    email.threadId && email.sourceId && email.eaccount && email.campaignId !== undefined
      ? JSON.stringify([
          "thread",
          email.sourceId,
          email.organizationId,
          email.crmRoleId,
          email.candidateId,
          email.eaccount,
          email.campaignId,
          email.threadId,
        ])
      : `message:${email.id}`;
  const threads = new Map<string, EmailConversationItem>();
  for (const email of messages)
    if (!threads.has(groupKey(email))) threads.set(groupKey(email), email);
  const visibleMessages =
    hasThreads && selected
      ? messages.filter((email) => groupKey(email) === groupKey(selected))
      : messages;
  useEffect(() => {
    if (openedFromHistory.current !== selected?.id) return;
    openedFromHistory.current = null;
    selectedArticle.current?.focus({ preventScroll: true });
  }, [selected?.id]);
  return (
    <section
      aria-labelledby={headingId}
      data-testid="email-conversation"
      className="min-w-0 rounded-xl border bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 basis-64 grow items-center gap-3">
          <ProfileImage
            key={candidateId ?? candidateName}
            src={candidatePhotoUrl}
            fallback={candidateName ? initials(candidateName) : <Mail size={20} />}
            photo
            className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-sm font-medium text-muted-foreground"
          />
          <div className="min-w-0">
            <h3 id={headingId} className="break-words font-semibold">
              {candidateName || t`Saved emails`}
            </h3>
            {candidateTitle ? (
              <p className="mt-0.5 break-words text-sm text-muted-foreground">{candidateTitle}</p>
            ) : null}
          </div>
        </div>
        {onOpenProfile || (onDraftReply && selected) ? (
          <div className="flex flex-wrap gap-2">
            {onOpenProfile ? (
              <Button size="sm" variant="outline" onClick={onOpenProfile}>
                <UserRound size={14} aria-hidden />
                <Trans>Profile</Trans>
              </Button>
            ) : null}
            {onDraftReply && selected ? (
              <Button size="sm" onClick={() => onDraftReply(selected)}>
                <Reply size={14} aria-hidden />
                <Trans>Draft reply</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {hasThreads && threads.size > 1 && selected ? (
        <div className="border-b p-3">
          <NativeSelect
            aria-label={t`Email thread or message`}
            value={groupKey(selected)}
            className="w-full"
            onChange={(event) => {
              const email = threads.get(event.target.value);
              if (email) onSelect(email);
            }}
          >
            {[...threads].map(([key, email]) => (
              <NativeSelectOption key={key} value={key}>
                {email.threadId ? t`Thread` : t`Message`} · {email.subject || t`No subject`}
                {email.date && Number.isFinite(Date.parse(email.date))
                  ? ` · ${formatDate(email.date)}`
                  : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      {!hasThreads && candidateName ? (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          <Trans>Saved emails</Trans>
        </p>
      ) : null}
      {visibleMessages.length ? (
        <ol aria-label={t`Emails`} className="space-y-3 p-3">
          {visibleMessages.map((email) => (
            <li key={email.id}>
              {email.id === selected?.id ? (
                <article
                  ref={selectedArticle}
                  tabIndex={-1}
                  aria-label={email.subject || t`No subject`}
                  className="rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex gap-3 p-4">
                    <MessageHeading email={email} />
                  </div>
                  <MessageBody email={email} artifactTarget={artifactTarget} />
                </article>
              ) : (
                <details
                  className="group rounded-lg border bg-muted/30"
                  onToggle={(event) => {
                    if (event.currentTarget.open) {
                      openedFromHistory.current = email.id;
                      onSelect(email);
                    }
                  }}
                >
                  <summary className="flex cursor-pointer list-none items-start gap-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <MessageHeading email={email} />
                    <ChevronDown
                      size={16}
                      aria-hidden
                      className="mt-0.5 shrink-0 text-muted-foreground group-open:rotate-180"
                    />
                  </summary>
                  <MessageBody email={email} artifactTarget={artifactTarget} />
                </details>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          <Trans>No replies yet.</Trans>
        </p>
      )}
    </section>
  );
}
