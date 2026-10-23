import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import type { RecruitingDetailController, RecruitingDetailView } from "./detail";
import type { RecruitingInboxEmail } from "./InboxTab";
import { InboxTab } from "./InboxTab";
import { InterviewTab } from "./InterviewTab";
import { statusText } from "./shared";

/**
 * The workbench detail panel: one person's email thread, profile or interview state, opened beside
 * the page and the role chat instead of replacing them. Draft and scheduling requests go to the
 * role chat composer, so sending still needs the user's exact confirmation there.
 */
export function RecruitingDetailPanel({
  controller,
  onDraftReply,
  onAskChat,
}: {
  controller: RecruitingDetailController;
  onDraftReply?: (email: RecruitingInboxEmail) => void;
  onAskChat?: (text: string) => void;
}) {
  const { t } = useLingui();
  const chatContext = useRecruitingChatContext();
  const current = controller.current;
  const heading = useRef<HTMLHeadingElement>(null);
  const [email, setEmail] = useState<RecruitingInboxEmail>();
  const person = current?.person;
  const depth = controller.stack.length;

  useEffect(() => {
    if (!person) return;
    chatContext.setSelectedContact({ name: person.name, reference: person.candidateId });
  }, [person?.candidateId, person?.name]);
  const open = Boolean(current);
  useEffect(() => {
    if (!open) return;
    return () => chatContext.setSelectedContact(null);
  }, [open]);
  useEffect(() => {
    if (current) heading.current?.focus({ preventScroll: true });
  }, [depth]);

  if (!current || !person) return null;
  const views: { view: RecruitingDetailView; label: string }[] = [
    { view: "thread", label: t`Emails` },
    { view: "contact", label: t`Profile` },
    { view: "interview", label: t`Interview` },
  ];
  const fields = [
    { label: t`Current role`, value: person.title },
    { label: t`Location`, value: person.location },
    { label: t`Email`, value: person.email },
    { label: t`Phone`, value: person.phone },
    { label: t`Stage`, value: person.stage && statusText(person.stage) },
    { label: t`Contact status`, value: person.contactStatus && statusText(person.contactStatus) },
    {
      label: t`Outreach status`,
      value: person.outreachStatus && statusText(person.outreachStatus),
    },
  ];
  return (
    <section
      aria-label={person.name}
      data-testid="recruiting-detail-panel"
      className="flex h-full min-h-0 w-full flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        controller.close();
      }}
    >
      <header className="flex items-center gap-1 border-b border-sidebar-border px-3 py-3">
        {depth > 1 ? (
          <Button variant="ghost" size="icon-sm" aria-label={t`Back`} onClick={controller.back}>
            <ArrowLeft size={18} aria-hidden />
          </Button>
        ) : null}
        <h2
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate px-1 font-semibold outline-none"
          title={person.name}
        >
          {person.name}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={controller.close}>
          <X size={18} aria-hidden />
        </Button>
      </header>
      <nav className="flex gap-1 px-3 pt-3">
        {views.map(({ view, label }) => (
          <Button
            key={view}
            size="sm"
            variant={view === current.view ? "secondary" : "ghost"}
            aria-pressed={view === current.view}
            onClick={() => controller.open({ ...current, view })}
          >
            {label}
          </Button>
        ))}
      </nav>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {current.view === "thread" ? (
          <>
            {onDraftReply && email ? (
              <Button variant="outline" className="mb-3" onClick={() => onDraftReply(email)}>
                <Trans>Draft reply</Trans>
              </Button>
            ) : null}
            <InboxTab
              key={person.candidateId}
              {...current.role}
              candidateId={person.candidateId}
              onSelectEmail={setEmail}
            />
          </>
        ) : current.view === "contact" ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {fields.map(({ label, value }) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value || "—"}</dd>
              </div>
            ))}
            {person.linkedinUrl && /^https?:\/\//i.test(person.linkedinUrl) ? (
              <dd className="col-span-2">
                <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="underline">
                  <Trans>LinkedIn</Trans>
                </a>
              </dd>
            ) : null}
          </dl>
        ) : (
          <>
            {onAskChat ? (
              <Button
                variant="outline"
                className="mb-3"
                onClick={() =>
                  onAskChat(
                    t`Schedule an interview with ${person.name}. Check availability and prepare the invitation here for my approval; do not send it yet.`,
                  )
                }
              >
                <Trans>Schedule interview</Trans>
              </Button>
            ) : null}
            <InterviewTab
              key={person.candidateId}
              {...current.role}
              candidateId={person.candidateId}
              candidateEmail={person.email}
            />
          </>
        )}
      </div>
    </section>
  );
}
