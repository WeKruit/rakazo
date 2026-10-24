import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, buttonVariants } from "@rakazo/ui-web";
import {
  ArrowLeft,
  Bookmark,
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  Download,
  Mail,
  MapPin,
  Phone,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import { ActivityTab } from "./ActivityTab";
import { AssessmentCard } from "./AssessmentCard";
import type { RecruitingDetailController, RecruitingDetailView } from "./detail";
import type { RecruitingInboxEmail } from "./InboxTab";
import { InboxWithReply } from "./InboxTab";
import { InterviewTab } from "./InterviewTab";
import { NotesTab, noteCandidateKeys } from "./NotesTab";
import { CompanyLogo, EducationTimeline, ExperienceTimeline } from "./ProfileTimeline";
import {
  candidateSections,
  initials,
  linkedinHandle,
  sourceLabel,
  storedProfileFields,
} from "./profile";
import { statusText } from "./shared";
import { reminderCandidateKeys, TasksTab } from "./TasksTab";

const SKILLS_SHOWN = 12;

export function PersonAvatar({
  name,
  size = "md",
  src,
}: {
  name: string;
  size?: "sm" | "md";
  src?: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground ${
        size === "sm" ? "size-8 text-[11px]" : "size-12 text-sm"
      }`}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(src)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-12 border-t py-4">
      <h3 id={`${id}-title`} className="mb-3 font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Sources({ urls }: { urls: readonly string[] }) {
  if (!urls.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">
          {sourceLabel(url)}
        </a>
      ))}
    </span>
  );
}

/**
 * The workbench detail panel: one person's profile, email thread or interview state, opened beside
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
  const person = current?.person;
  const depth = controller.stack.length;
  const [allSkills, setAllSkills] = useState(false);
  const [shortlisted, setShortlisted] = useState<{ key: string; value: boolean }>();

  useEffect(() => {
    if (!person) return;
    chatContext.setSelectedContact({ name: person.name, reference: person.candidateId });
    setAllSkills(false);
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
  const crm = current.crm !== false;
  const reminderKeys = reminderCandidateKeys(
    current.candidate?.candidateKey,
    crm && person.candidateId,
  );
  const reminderKey = reminderKeys[0] ?? null;
  const views: { view: RecruitingDetailView; label: string }[] = [
    { view: "contact", label: t`Profile` },
    { view: "activity", label: t`Activity` },
    ...(crm
      ? [
          { view: "thread" as const, label: t`Emails` },
          { view: "interview" as const, label: t`Interview` },
        ]
      : []),
    ...(reminderKey ? [{ view: "tasks" as const, label: t`Tasks` }] : []),
    ...(reminderKey ? [{ view: "notes" as const, label: t`Notes` }] : []),
  ];
  const view = views.some((option) => option.view === current.view) ? current.view : "contact";
  const candidate = current.candidate;
  const sections = candidateSections([
    ...(candidate?.latestSource?.report?.fields ?? []),
    ...storedProfileFields(person.profile),
  ]);
  const email = person.email ?? sections.email;
  const phone = person.phone ?? sections.phone;
  const company = person.company ?? candidate?.company;
  const role =
    person.title && company ? t`${person.title} at ${company}` : (person.title ?? company);
  const resumeUrl = candidate?.resumeUrl ?? sections.resumeUrl;
  const handle = linkedinHandle(person.linkedinUrl);
  const previous = current.walk?.(-1);
  const next = current.walk?.(1);
  const actions = current.actions;
  const shortlist = actions?.shortlist;
  const isShortlisted =
    shortlisted?.key === person.candidateId ? shortlisted.value : shortlist?.shortlisted;
  const emailDraft =
    actions?.emailDraft ?? (crm ? () => controller.replace({ ...current, view: "thread" }) : null);
  const stage = [
    { label: t`Stage`, value: person.stage },
    { label: t`Contact status`, value: person.contactStatus },
    { label: t`Outreach status`, value: person.outreachStatus },
  ].filter((item) => item.value);
  const anchors = [
    candidate && (sections.fit || sections.requirements.length || sections.summary)
      ? { id: "fit", label: t`Assessment` }
      : null,
    sections.experience.length ? { id: "experience", label: t`Experience` } : null,
    sections.education.length ? { id: "education", label: t`Education` } : null,
    sections.skills.length ? { id: "skills", label: t`Skills` } : null,
    sections.findings.length ? { id: "findings", label: t`Research findings` } : null,
    stage.length ? { id: "outreach", label: t`Outreach` } : null,
  ].filter((anchor): anchor is { id: string; label: string } => anchor !== null);
  const anchorId = (id: string) => `recruiting-detail-${id}`;
  const fitBadge = [sections.fit?.score?.value, sections.fit?.tier?.value]
    .filter(Boolean)
    .join(" · ");
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
      <header className="flex items-center gap-1 border-b border-sidebar-border px-3 py-2">
        {depth > 1 ? (
          <Button variant="ghost" size="icon-sm" aria-label={t`Back`} onClick={controller.back}>
            <ArrowLeft size={18} aria-hidden />
          </Button>
        ) : null}
        <span className="flex-1" />
        {current.walk ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Previous`}
              disabled={!previous}
              onClick={() => previous && controller.replace(previous)}
            >
              <ChevronLeft size={18} aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Next`}
              disabled={!next}
              onClick={() => next && controller.replace(next)}
            >
              <ChevronRight size={18} aria-hidden />
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={controller.close}>
          <X size={18} aria-hidden />
        </Button>
      </header>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 px-4 pt-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h2
                ref={heading}
                tabIndex={-1}
                className="truncate text-lg font-semibold outline-none"
                title={person.name}
              >
                {person.name}
              </h2>
              {role ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <BriefcaseBusiness size={14} aria-hidden className="shrink-0" />
                  <span className="truncate">{role}</span>
                </p>
              ) : null}
              {sections.company.industry || sections.company.size ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {company ? (
                    <CompanyLogo name={company} host={sections.company.host} small />
                  ) : null}
                  <span className="truncate">
                    {[
                      sections.company.industry,
                      sections.company.size ? t`${sections.company.size} employees` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </p>
              ) : null}
              {person.location || handle ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {person.location ? (
                    <span className="flex items-center gap-1.5">
                      <MapPin size={14} aria-hidden className="shrink-0" />
                      {person.location}
                    </span>
                  ) : null}
                  {handle && person.linkedinUrl && /^https?:\/\//i.test(person.linkedinUrl) ? (
                    <a
                      href={person.linkedinUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline"
                    >
                      {handle}
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
            <PersonAvatar name={person.name} src={sections.photoUrl} />
          </div>
          <details open className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              <Trans>Contact details</Trans>
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Mail size={14} aria-hidden />
                <Trans>Email</Trans>
              </dt>
              <dd className="flex items-center justify-between gap-2 break-all">
                <span>
                  {email || "—"}
                  {sections.contactStatus ? (
                    <small className="ms-2 text-muted-foreground">
                      {statusText(sections.contactStatus)}
                    </small>
                  ) : null}
                </span>
                {!email && actions?.findEmail ? (
                  <Button size="sm" variant="outline" onClick={actions.findEmail}>
                    <Trans>Find email</Trans>
                  </Button>
                ) : null}
              </dd>
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Phone size={14} aria-hidden />
                <Trans>Phone</Trans>
              </dt>
              <dd className="break-all">{phone || "—"}</dd>
            </dl>
          </details>
          {emailDraft || shortlist || resumeUrl || actions?.openEvidence ? (
            <div className="flex flex-wrap gap-2">
              {emailDraft ? (
                <Button size="sm" onClick={emailDraft}>
                  <Mail size={15} aria-hidden />
                  <Trans>Email draft</Trans>
                </Button>
              ) : null}
              {shortlist ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={Boolean(isShortlisted)}
                  disabled={shortlist.disabled}
                  onClick={() => {
                    setShortlisted({ key: person.candidateId, value: !isShortlisted });
                    shortlist.set(!isShortlisted);
                  }}
                >
                  <Bookmark size={15} aria-hidden fill={isShortlisted ? "currentColor" : "none"} />
                  {isShortlisted ? <Trans>Shortlisted</Trans> : <Trans>Shortlist</Trans>}
                </Button>
              ) : null}
              {resumeUrl ? (
                <a
                  href={resumeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  <Download size={15} aria-hidden />
                  <Trans>Resume</Trans>
                </a>
              ) : null}
              {actions?.openEvidence ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-haspopup="dialog"
                  onClick={(event) => actions.openEvidence?.(event.currentTarget)}
                >
                  <Trans>Evidence</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <nav className="sticky top-0 z-10 flex gap-1 border-b border-sidebar-border bg-background px-3 pt-3 pb-2">
          {views.length > 1
            ? views.map(({ view: option, label }) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === view ? "secondary" : "ghost"}
                  aria-pressed={option === view}
                  onClick={() => controller.open({ ...current, view: option })}
                >
                  {label}
                </Button>
              ))
            : null}
          {view === "contact" && anchors.length > 1 ? (
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {views.length > 1 ? <span className="mx-1 w-px bg-border" aria-hidden /> : null}
              {anchors.map((anchor) => (
                <Button
                  key={anchor.id}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    document
                      .getElementById(anchorId(anchor.id))
                      ?.scrollIntoView({ block: "start", behavior: "smooth" })
                  }
                >
                  {anchor.label}
                </Button>
              ))}
            </div>
          ) : null}
        </nav>
        <div className="px-4 py-3">
          {view === "activity" ? (
            <ActivityTab
              key={person.candidateId}
              {...current.role}
              person={person}
              crm={crm}
              candidateKey={current.candidate?.candidateKey}
            />
          ) : view === "tasks" && reminderKey ? (
            <TasksTab
              key={reminderKey}
              roleId={current.role.roleId}
              candidateKey={reminderKey}
              candidateKeys={reminderKeys}
            />
          ) : view === "notes" && reminderKey ? (
            <NotesTab
              key={reminderKey}
              roleId={current.role.roleId}
              createKey={reminderKey}
              candidateKeys={noteCandidateKeys(
                current.candidate?.candidateKey,
                crm && person.candidateId,
              )}
            />
          ) : view === "thread" ? (
            <InboxWithReply
              key={person.candidateId}
              {...current.role}
              candidateId={person.candidateId}
              onDraftReply={onDraftReply}
            />
          ) : view === "contact" ? (
            <div className="text-sm">
              {anchors.some((anchor) => anchor.id === "fit") ? (
                <Section id={anchorId("fit")} title={<Trans>Agent assessment</Trans>}>
                  <AssessmentCard
                    score={fitBadge || null}
                    rank={sections.fit?.rank ?? null}
                    summary={sections.summary}
                    quick={sections.quick}
                    rows={sections.requirements}
                    sourceUrls={sections.requirementSources}
                  />
                </Section>
              ) : null}
              {sections.experience.length ? (
                <Section id={anchorId("experience")} title={<Trans>Experience</Trans>}>
                  <ExperienceTimeline fields={sections.experience} Sources={Sources} />
                </Section>
              ) : null}
              {sections.education.length ? (
                <Section id={anchorId("education")} title={<Trans>Education</Trans>}>
                  <EducationTimeline fields={sections.education} Sources={Sources} />
                </Section>
              ) : null}
              {sections.skills.length ? (
                <Section id={anchorId("skills")} title={<Trans>Skills</Trans>}>
                  <ul className="flex flex-wrap gap-1.5">
                    {(allSkills ? sections.skills : sections.skills.slice(0, SKILLS_SHOWN)).map(
                      (skill) => (
                        <li key={skill}>
                          <Badge variant="secondary">{skill}</Badge>
                        </li>
                      ),
                    )}
                  </ul>
                  {!allSkills && sections.skills.length > SKILLS_SHOWN ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => setAllSkills(true)}
                    >
                      <Trans>Show more</Trans>
                    </Button>
                  ) : null}
                </Section>
              ) : null}
              {anchors.some((anchor) => anchor.id === "findings") ? (
                <Section id={anchorId("findings")} title={<Trans>Research findings</Trans>}>
                  <FieldList fields={sections.findings} />
                </Section>
              ) : null}
              {stage.length ? (
                <Section id={anchorId("outreach")} title={<Trans>Outreach</Trans>}>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                    {stage.map(({ label, value }) => (
                      <div key={label} className="contents">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd>{statusText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              ) : null}
            </div>
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
      </div>
    </section>
  );
}

function FieldList({
  fields,
}: {
  fields: readonly { label: string; value: string | null; sourceUrls: readonly string[] }[];
}) {
  return (
    <dl className="space-y-3">
      {fields.map((field) => (
        <div key={field.label} className="space-y-1">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="whitespace-pre-wrap">{field.value ?? "—"}</dd>
          <Sources urls={field.sourceUrls} />
        </div>
      ))}
    </dl>
  );
}
