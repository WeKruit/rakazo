import { Trans, useLingui } from "@lingui/react/macro";
import { recruitingCandidateSourceText } from "@rakazo/contracts";
import { isVendorUrl } from "@rakazo/core";
import { Button, buttonVariants } from "@rakazo/ui-web";
import {
  ArrowLeft,
  Bookmark,
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  Download,
  MapPin,
  Maximize2,
  Minimize2,
  Phone,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useContext, useEffect, useRef, useState } from "react";
import { SidePanelSizeContext } from "../ResizableSidePanel";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import { ActivityTab } from "./ActivityTab";
import { AssessmentCard } from "./AssessmentCard";
import type { RecruitingDetailController, RecruitingDetailView } from "./detail";
import { HighlightText } from "./evidence";
import { fieldLabel } from "./fieldLabels";
import type { RecruitingInboxEmail } from "./InboxTab";
import { InboxWithReply } from "./InboxTab";
import { InterviewTab } from "./LazyViews";
import { LinkedInIcon } from "./LinkedInIcon";
import { NotesTab, noteCandidateKeys } from "./NotesTab";
import { CompanyLogo, OrgBadge } from "./OrgBadge";
import { PersonAvatar } from "./ProfileImage";
import { ProfileMailIcon } from "./ProfileMailIcon";
import { ProfileSequenceHistory } from "./ProfileSequenceHistory";
import { ProfileSourceIcon } from "./ProfileSourceIcon";
import { CurrentPosition, EducationTimeline, ExperienceTimeline } from "./ProfileTimeline";
import {
  candidateSections,
  linkedinHandle,
  shortFact,
  sourceLabel,
  storedProfileFields,
  withSavedProfile,
} from "./profile";
import {
  organizationLogo,
  profileAssets,
  profileContentFields,
  profileImageUrl,
  profileLinkUrl,
} from "./profileAssets";
import { organizationHosts } from "./quickOutput";
import { usePersonSequenceFacts } from "./SequenceStats";
import { SkillEvidence } from "./SkillEvidence";
import { statusText } from "./shared";
import { reminderCandidateKeys, TasksTab } from "./TasksTab";
import { useProfileView } from "./useProfileView";

/** Stored outreach state plus the saved sequence numbers; nothing when neither exists. */
function OutreachSection({
  id,
  role,
  candidateId,
  stage,
}: {
  id: string;
  role: Parameters<typeof usePersonSequenceFacts>[0];
  candidateId: string | null;
  stage: { label: string; value: string }[];
}) {
  const facts = [...stage, ...usePersonSequenceFacts(role, candidateId)];
  if (!facts.length) return null;
  return (
    <Section id={id} title={<Trans>Outreach</Trans>}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        {facts.map(({ label, value }) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t py-4">
      <h3 id={`${id}-title`} className="mb-3 font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Sources({ urls: allUrls }: { urls: readonly string[] }) {
  const urls = allUrls.filter((url) => !isVendorUrl(url));
  if (!urls.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {urls.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
        >
          <ProfileSourceIcon href={url} className="size-3.5 shrink-0" />
          {sourceLabel(url)}
        </a>
      ))}
    </span>
  );
}

/** Keep every navigation label reachable when the detail panel is narrow. */
function NavigationRow({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, start: true, end: true });
  const measure = () => {
    const element = viewport.current;
    if (!element) return;
    const next = {
      overflow: element.scrollWidth > element.clientWidth + 1,
      start: element.scrollLeft <= 1,
      end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    };
    setEdges((previous) =>
      previous.overflow === next.overflow &&
      previous.start === next.start &&
      previous.end === next.end
        ? previous
        : next,
    );
  };
  useEffect(() => {
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewport.current) observer?.observe(viewport.current);
    if (content.current) observer?.observe(content.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const scroll = (direction: -1 | 1) => {
    const element = viewport.current;
    if (element) element.scrollLeft += direction * element.clientWidth * 0.75;
  };
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="profile-navigation-row">
      {edges.overflow ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t`Scroll navigation left`}
          disabled={edges.start}
          onClick={() => scroll(-1)}
        >
          <ChevronLeft size={16} aria-hidden />
        </Button>
      ) : null}
      <div
        ref={viewport}
        className="min-w-0 flex-1 overflow-x-auto"
        onScroll={measure}
        onFocusCapture={(event) => {
          const element = viewport.current;
          if (!element || !(event.target instanceof HTMLElement)) return;
          const bounds = element.getBoundingClientRect();
          const target = event.target.getBoundingClientRect();
          if (target.left < bounds.left) element.scrollLeft += target.left - bounds.left;
          else if (target.right > bounds.right) element.scrollLeft += target.right - bounds.right;
        }}
      >
        <div ref={content} className="flex w-max gap-1">
          {children}
        </div>
      </div>
      {edges.overflow ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t`Scroll navigation right`}
          disabled={edges.end}
          onClick={() => scroll(1)}
        >
          <ChevronRight size={16} aria-hidden />
        </Button>
      ) : null}
    </div>
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
  const panelSize = useContext(SidePanelSizeContext);
  const current = controller.current;
  const heading = useRef<HTMLHeadingElement>(null);
  const person = current?.person;
  const profileView = useProfileView({
    spaceId: current?.role?.spaceId,
    roleId: current?.role?.roleId,
    candidateKey:
      reminderCandidateKeys(
        current?.candidate?.candidateKey ?? current?.person.searchCandidateKey,
        current?.crm !== false && person?.candidateId,
      )[0] ?? null,
    visible: current?.view === "contact",
  });
  const depth = controller.stack.length;
  const [sequencePerson, setSequencePerson] = useState<string>();
  const [shortlisted, setShortlisted] = useState<{ key: string; value: boolean }>();

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
  }, [depth, person?.candidateId]);

  if (!current || !person) return null;
  const crm = Boolean(current.role) && current.crm !== false;
  const reminderKeys = reminderCandidateKeys(
    current.candidate?.candidateKey ?? person.searchCandidateKey,
    crm && person.candidateId,
  );
  const reminderKey = current.role ? (reminderKeys[0] ?? null) : null;
  const views: { view: RecruitingDetailView; label: string }[] = [
    { view: "contact", label: t`Profile` },
    ...(person.roles?.length ? [{ view: "roles" as const, label: t`Roles` }] : []),
    ...(current.role ? [{ view: "activity" as const, label: t`Activity` }] : []),
    ...(crm &&
    sequencePerson ===
      JSON.stringify([current.role?.spaceId, current.role?.roleId, person.candidateId])
      ? [{ view: "sequences" as const, label: t`Sequences` }]
      : []),
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
  const savedProfile = candidate?.savedProfile ?? person.savedProfile;
  const fields = withSavedProfile(savedProfile, [
    ...(candidate?.latestSource?.report?.fields ?? []),
    ...storedProfileFields(person.profile),
  ]);
  const company = person.company ?? candidate?.company;
  const assets = profileAssets(fields, company);
  const sections = candidateSections(profileContentFields(fields), {
    roleRevisionId: candidate?.latestSource?.roleRevisionId,
    revision: current.criterionRevision,
  });
  const orgHosts = organizationHosts(sections.quick.entities, {
    name: company,
    host: sections.company.host,
  });
  const companyLogo =
    person.companyLogoUrl ?? organizationLogo(company ?? undefined, assets.company);
  const companySite =
    profileImageUrl(person.companyWebsiteUrl) ??
    organizationLogo(company ?? undefined, assets.companyLink) ??
    (sections.company.host ? `https://${sections.company.host}/` : null);
  const email = person.email ?? savedProfile?.email ?? sections.email;
  const socialLinks = new Map<string, string>();
  for (const [label, value] of [
    ["GitHub", savedProfile?.githubUrl],
    [t`Website`, savedProfile?.websiteUrl],
    ["Stack Overflow", savedProfile?.stackOverflowUrl],
  ]) {
    const href = profileLinkUrl(value);
    if (href && href !== person.linkedinUrl && !socialLinks.has(href))
      socialLinks.set(href, label!);
  }
  const phone = person.phone ?? sections.phone;
  const sizeFact = shortFact(sections.company.size);
  const companySize =
    sizeFact && !/employee|员工|人/i.test(sizeFact) ? t`${sizeFact} employees` : sizeFact;
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
  const extraSections = [
    { id: "projects", label: t`Projects`, pattern: /^projects?$/i },
    { id: "courses", label: t`Courses`, pattern: /^(?:courses?|certifications?)$/i },
    { id: "languages", label: t`Languages`, pattern: /^languages?$/i },
  ]
    .map((section) => ({
      ...section,
      fields: sections.findings.filter((field) => section.pattern.test(field.label.trim())),
    }))
    .filter((section) => section.fields.length);
  const findings = sections.findings.filter(
    (field) => !extraSections.some((section) => section.fields.includes(field)),
  );
  const anchors = [
    candidate && (sections.fit || sections.requirements.length || sections.summary)
      ? { id: "fit", label: t`Assessment` }
      : null,
    sections.experience.length || person.title || company
      ? { id: "experience", label: t`Experience` }
      : null,
    sections.education.length ? { id: "education", label: t`Education` } : null,
    sections.skills.length ? { id: "skills", label: t`Skills` } : null,
    ...extraSections.map(({ id, label }) => ({ id, label })),
    findings.length ? { id: "findings", label: t`Research findings` } : null,
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
      <header className="flex min-h-16 items-center gap-1 border-b border-sidebar-border px-4 py-2 sm:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Back`}
          onClick={depth > 1 ? controller.back : controller.close}
        >
          <ArrowLeft size={18} aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {current.collection
            ? `${current.collection.label} · ${current.collection.index + 1}/${current.collection.total}`
            : t`Profile`}
        </span>
        {panelSize ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="hidden md:inline-flex"
            aria-label={panelSize.expanded ? t`Collapse profile` : t`Expand profile`}
            onClick={panelSize.toggle}
          >
            {panelSize.expanded ? (
              <Minimize2 size={16} aria-hidden />
            ) : (
              <Maximize2 size={16} aria-hidden />
            )}
          </Button>
        ) : null}
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
        <div className="space-y-3 px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h2
                ref={heading}
                tabIndex={-1}
                className="break-words text-xl font-semibold leading-tight outline-none"
                title={person.name}
              >
                {person.name}
              </h2>
              {role ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {company && (companyLogo || sections.company.host) ? (
                    <CompanyLogo name={company} src={companyLogo} host={sections.company.host} />
                  ) : (
                    <BriefcaseBusiness size={14} aria-hidden className="shrink-0" />
                  )}
                  <span className="min-w-0 break-words">
                    {company && companySite ? (
                      <>
                        {person.title ? `${person.title} · ` : ""}
                        <a
                          href={companySite}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          {company}
                        </a>
                      </>
                    ) : (
                      role
                    )}
                  </span>
                </p>
              ) : null}
              {company &&
              (sections.company.industry || sections.company.size || sections.company.host) ? (
                <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <OrgBadge
                    name={company}
                    src={companyLogo}
                    host={sections.company.host}
                    logo={false}
                    facts={[sections.company.industry, sections.company.size]}
                  />
                  {[shortFact(sections.company.industry), companySize]
                    .filter(Boolean)
                    .map((fact) => (
                      <span key={fact} className="shrink-0 truncate">
                        · {fact}
                      </span>
                    ))}
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
                      className="inline-flex min-w-0 items-center gap-1.5 break-all text-foreground underline"
                    >
                      <LinkedInIcon className="size-4 shrink-0" />
                      {handle}
                    </a>
                  ) : null}
                </p>
              ) : null}
              {socialLinks.size ? (
                <div className="flex flex-wrap gap-2">
                  {[...socialLinks].map(([href, label]) => (
                    <a
                      key={href}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm hover:underline"
                      aria-label={`${person.name} · ${label}`}
                    >
                      <ProfileSourceIcon href={href} className="size-4" />
                      {label}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
            <PersonAvatar
              key={person.candidateId}
              name={person.name}
              src={person.profileImageUrl ?? assets.photo ?? sections.photoUrl}
            />
          </div>
          {person.roles?.length ? (
            <ul className="flex flex-wrap gap-1" aria-label={t`Associated roles`}>
              {person.roles.map((role) => (
                <li
                  key={role.id}
                  className="max-w-full truncate rounded bg-muted px-2 py-0.5 text-xs"
                  title={role.title}
                >
                  {role.title}
                </li>
              ))}
            </ul>
          ) : null}
          <details open className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              <Trans>Contact details</Trans>
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <ProfileMailIcon className="size-3.5" />
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
                  <ProfileMailIcon className="size-4" />
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
        <nav
          aria-label={t`Profile navigation`}
          className="sticky top-0 z-10 flex flex-col gap-1 border-b border-sidebar-border bg-background px-3 pt-3 pb-2"
        >
          <NavigationRow>
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
          </NavigationRow>
          {view === "contact" && anchors.length > 1 ? (
            <NavigationRow>
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
            </NavigationRow>
          ) : null}
        </nav>
        <div className="px-4 py-3 sm:px-6">
          {view === "activity" && current.role ? (
            <ActivityTab
              key={person.candidateId}
              {...current.role}
              refreshSignal={profileView.status === "recorded" ? 1 : 0}
              person={person}
              crm={crm}
              candidateKey={current.candidate?.candidateKey ?? person.searchCandidateKey}
            />
          ) : view === "tasks" && reminderKey && current.role ? (
            <TasksTab
              key={reminderKey}
              roleId={current.role.roleId}
              candidateKey={reminderKey}
              candidateKeys={reminderKeys}
            />
          ) : view === "notes" && reminderKey && current.role ? (
            <NotesTab
              key={reminderKey}
              roleId={current.role.roleId}
              conversation={current.role.conversation}
              createKey={reminderKey}
              candidateKeys={noteCandidateKeys(
                current.candidate?.candidateKey ?? person.searchCandidateKey,
                crm && person.candidateId,
              )}
            />
          ) : view === "thread" && current.role ? (
            <InboxWithReply
              key={person.candidateId}
              {...current.role}
              candidateId={person.candidateId}
              onDraftReply={onDraftReply}
            />
          ) : view === "roles" && person.roles?.length ? (
            <section aria-label={t`Associated roles`} className="space-y-3">
              <h3 className="font-semibold">
                <Trans>Associated roles</Trans>
              </h3>
              <ul className="space-y-2">
                {person.roles.map((role) => (
                  <li
                    key={role.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 break-words">{role.title}</span>
                    {role.shortlisted ? (
                      <span className="rounded bg-muted px-2 py-1 text-xs">
                        <Trans>Shortlisted</Trans>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : view === "sequences" && crm && current.role ? (
            <ProfileSequenceHistory
              role={current.role}
              candidateId={person.candidateId}
              name={person.name}
              onAvailable={setSequencePerson}
              onAskChat={onAskChat}
              onReply={() => controller.replace({ ...current, view: "thread" })}
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
                    keywords={sections.skills}
                  />
                </Section>
              ) : null}
              {sections.experience.length ? (
                <Section id={anchorId("experience")} title={<Trans>Experience</Trans>}>
                  <ExperienceTimeline
                    fields={sections.experience}
                    Sources={Sources}
                    asset={assets.company}
                    link={assets.companyLink}
                    hosts={orgHosts}
                  />
                </Section>
              ) : person.title || company ? (
                <Section id={anchorId("experience")} title={<Trans>Experience</Trans>}>
                  <CurrentPosition
                    title={person.title}
                    company={company}
                    Sources={Sources}
                    asset={assets.company}
                    link={assets.companyLink}
                    hosts={orgHosts}
                  />
                  {onAskChat ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        onAskChat(
                          t`Find ${person.name}'s full work history and education and save it to their profile.`,
                        )
                      }
                    >
                      <Trans>Find work history</Trans>
                    </Button>
                  ) : null}
                </Section>
              ) : null}
              {sections.education.length ? (
                <Section id={anchorId("education")} title={<Trans>Education</Trans>}>
                  <EducationTimeline
                    fields={sections.education}
                    Sources={Sources}
                    asset={assets.school}
                    link={assets.schoolLink}
                    hosts={orgHosts}
                  />
                </Section>
              ) : null}
              {sections.skills.length ? (
                <Section id={anchorId("skills")} title={<Trans>Skills</Trans>}>
                  <SkillEvidence
                    key={`${current.role?.roleId ?? "contact"}:${person.candidateId}`}
                    skills={sections.skills}
                    evidence={sections.skillEvidence}
                  />
                </Section>
              ) : null}
              {extraSections.map((section) => (
                <Section key={section.id} id={anchorId(section.id)} title={section.label}>
                  <FieldList fields={section.fields} keywords={sections.skills} />
                </Section>
              ))}
              {anchors.some((anchor) => anchor.id === "findings") ? (
                <Section id={anchorId("findings")} title={<Trans>Research findings</Trans>}>
                  <FieldList fields={findings} keywords={sections.skills} />
                </Section>
              ) : null}
              {crm && current.role ? (
                <ProfileSequenceHistory
                  role={current.role}
                  candidateId={person.candidateId}
                  name={person.name}
                  onAvailable={setSequencePerson}
                  onAskChat={onAskChat}
                  onReply={() => controller.replace({ ...current, view: "thread" })}
                />
              ) : null}
              {current.role ? (
                <OutreachSection
                  id={anchorId("outreach")}
                  role={current.role}
                  candidateId={crm ? person.candidateId : null}
                  stage={stage.map(({ label, value }) => ({ label, value: statusText(value) }))}
                />
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
              {current.role ? (
                <InterviewTab
                  key={person.candidateId}
                  {...current.role}
                  candidateId={person.candidateId}
                  candidateEmail={person.email}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function FieldList({
  fields,
  keywords,
}: {
  fields: readonly {
    label: string;
    value: string | null;
    evidence?: string;
    reasoning?: string;
    structuredValue?: unknown;
    sourceUrls: readonly string[];
  }[];
  keywords: readonly string[];
}) {
  return (
    <dl className="space-y-3">
      {fields.map((field) => (
        <div key={field.label} className="space-y-1">
          <dt className="text-xs text-muted-foreground">{fieldLabel(field.label)}</dt>
          <dd className="space-y-1 break-words whitespace-pre-wrap">
            {[
              ...new Set(
                [field.value, field.evidence, field.reasoning].filter((text): text is string =>
                  Boolean(text?.trim()),
                ),
              ),
            ].map((text) => (
              <p key={text}>
                <HighlightText text={text} terms={keywords} />
              </p>
            ))}
            {field.structuredValue !== undefined ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  <Trans>Source text</Trans>
                </summary>
                <p className="mt-2">{recruitingCandidateSourceText(field.structuredValue)}</p>
              </details>
            ) : null}
          </dd>
          <Sources urls={field.sourceUrls} />
        </div>
      ))}
    </dl>
  );
}
