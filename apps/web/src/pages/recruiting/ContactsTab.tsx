import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCandidate, RecruitingCorrespondence } from "@rakazo/contracts";
import { Badge, Button } from "@rakazo/ui-web";
import { Bookmark, Building2, Mail, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { RecruitingDetailTarget } from "./detail";
import { detailKey, useRecruitingDetail } from "./detail";
import { PersonAvatar } from "./DetailPanel";
import { candidateSections } from "./profile";
import { RetryNotice } from "./RetryNotice";
import { linkedinIdentity } from "./roleCandidates";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useSavedCorrespondence,
} from "./shared";
import type { AutumnCandidatesRead, RoleCandidate } from "./useRoleCandidates";
import { useRoleCandidates } from "./useRoleCandidates";

type SavedContact = RecruitingCorrespondence["contacts"][number];

/** What only the workbench that owns Autumn results can do for one of them. */
export type AutumnCandidateActions = {
  /** Writes are allowed only while the shown results are the validated current read. */
  ready: boolean;
  shortlistFailedKey: string | null;
  setShortlist: (candidate: RecruitingCandidate, shortlisted: boolean) => void;
  /** Asks the role chat for a draft to approve; never sends. */
  sendEmail?: (candidate: RecruitingCandidate) => void;
  findEmail?: (candidate: RecruitingCandidate) => void;
  /** The full saved evidence, assessment and feedback for the result. */
  openEvidence: (candidate: RecruitingCandidate, trigger: HTMLElement) => void;
  selectedKey?: string;
};

const clamp1 = "block truncate";
const clamp2 = "line-clamp-2 break-words";

function Fit({ candidate }: { candidate: RecruitingCandidate | null }) {
  const { t } = useLingui();
  const sections = candidateSections(candidate?.latestSource?.report?.fields);
  const badge = [sections.fit?.score?.value, sections.fit?.tier?.value].filter(Boolean).join(" · ");
  if (!badge && !sections.criteria.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {badge ? (
        <Badge variant="secondary" title={sections.fit?.score?.label ?? sections.fit?.tier?.label}>
          {badge}
        </Badge>
      ) : null}
      {sections.criteria.slice(0, 3).map((field) => (
        <Badge
          key={field.label}
          variant={field.providerStatus === "miss" ? "destructive" : "outline"}
          className="max-w-28"
          title={`${field.label}: ${
            field.providerStatus === "match"
              ? t`Match`
              : field.providerStatus === "miss"
                ? t`Does not match`
                : t`Unclear`
          }`}
        >
          <span className="truncate">{field.label}</span>
        </Badge>
      ))}
    </div>
  );
}

/**
 * The role's one candidate list: Autumn search results and the role's CRM contacts with the same
 * columns and one row per person. Each source renders when it loads and retries on its own; a row
 * opens the person in the detail panel beside the page.
 */
export function ContactsTab(
  props: RecruitingTabProps & {
    autumn?: AutumnCandidatesRead & AutumnCandidateActions;
    onRefine?: () => void;
  },
) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const { autumn } = props;
  const [lookupReload, setLookupReload] = useState(0);
  const saved = useSavedCorrespondence(
    { ...props, refreshSignal: (props.refreshSignal ?? 0) + lookupReload },
    "contacts",
  );
  const lookups = saved.data?.contacts ?? [];
  const lookupsFor = (row: RoleCandidate): SavedContact[] =>
    lookups.filter((contact) =>
      row.autumn
        ? contact.candidateKey === row.autumn.candidateKey
        : linkedinIdentity(contact.linkedinUrl) !== null &&
          linkedinIdentity(contact.linkedinUrl) === linkedinIdentity(row.linkedinUrl),
    );
  const list = useRoleCandidates({
    ...props,
    autumn: autumn && {
      ...autumn,
      email: (candidate) =>
        lookups.find((contact) => contact.candidateKey === candidate.candidateKey)?.emails[0]
          ?.address ?? null,
    },
  });
  const { rows } = list;
  const unmatched = lookups.filter(
    (contact) => !rows.some((row) => lookupsFor(row).includes(contact)),
  );
  const failures = [
    list.autumn?.failed ? (
      <RetryNotice key="autumn" onRetry={list.autumn.retry}>
        <Trans>Could not load search results</Trans>
      </RetryNotice>
    ) : null,
    list.crmRead.failed ? (
      <RetryNotice key="crm" onRetry={list.crmRead.retry}>
        <Trans>Could not load CRM records</Trans>
      </RetryNotice>
    ) : null,
    saved.failed || saved.data?.status === "failed" ? (
      <RetryNotice key="lookups" onRetry={() => setLookupReload((value) => value + 1)}>
        <Trans>Could not load contact details</Trans>
      </RetryNotice>
    ) : null,
  ].filter(Boolean);
  // A failed read never sits next to a loading one: retry first, then rows fill in.
  const loading = !failures.length && Boolean(list.autumn?.loading || list.crmRead.loading);
  const empty = !loading && !failures.length && !rows.length;
  const role = { roleId: props.roleId, spaceId: props.spaceId, conversation: props.conversation };
  const education = (row: RoleCandidate) =>
    candidateSections(row.autumn?.latestSource?.report?.fields).education[0]?.value ?? null;
  const showEducation = rows.some((row) => education(row));

  function target(index: number): RecruitingDetailTarget | undefined {
    const row = rows[index];
    if (!row) return undefined;
    const crm = row.crm;
    const candidate = row.autumn;
    const rowLookups = lookupsFor(row);
    const sections = candidateSections(candidate?.latestSource?.report?.fields);
    return {
      view: "contact",
      role,
      crm: Boolean(crm),
      ...(candidate ? { candidate } : {}),
      person: {
        candidateId: crm?.candidateId ?? candidate!.candidateKey,
        name: row.name ?? t`Unnamed candidate`,
        email: crm?.email ?? rowLookups[0]?.emails[0]?.address ?? sections.email,
        phone: crm?.phone ?? rowLookups[0]?.phones[0]?.number ?? sections.phone,
        title: row.title,
        company: candidate?.company ?? null,
        location: row.location,
        linkedinUrl: row.linkedinUrl,
        stage: crm?.stage ?? null,
        contactStatus: crm?.contactStatus ?? null,
        outreachStatus: crm?.outreachStatus ?? null,
      },
      ...(candidate && autumn
        ? {
            actions: {
              ...(autumn.sendEmail ? { emailDraft: () => autumn.sendEmail!(candidate) } : {}),
              ...(autumn.findEmail ? { findEmail: () => autumn.findEmail!(candidate) } : {}),
              shortlist: {
                shortlisted: candidate.shortlisted,
                disabled: !autumn.ready,
                set: (value: boolean) => autumn.setShortlist(candidate, value),
              },
              openEvidence: (trigger: HTMLElement) => autumn.openEvidence(candidate, trigger),
            },
          }
        : {}),
      walk: (step) => target(index + step),
    };
  }
  const openRow = (index: number, trigger: HTMLElement) => {
    const row = rows[index]!;
    const next = target(index);
    if (detail && next) detail.open(next);
    else if (row.autumn) autumn?.openEvidence(row.autumn, trigger);
  };
  const openId = detail?.current?.person.candidateId;
  // A shared or reloaded link reopens its person once the list shows them.
  const pendingDetail = detail?.pending;
  useEffect(() => {
    if (!pendingDetail || !detail) return;
    for (let index = 0; index < rows.length; index += 1) {
      const candidate = target(index);
      if (candidate && detailKey(candidate) === pendingDetail) return detail.restore(candidate);
    }
  }, [pendingDetail, rows]);

  const columns = [
    { label: t`Name`, width: "w-52" },
    { label: t`Current role`, width: "w-48" },
    ...(showEducation ? [{ label: t`Education`, width: "w-44" }] : []),
    { label: t`Location`, width: "w-36" },
    { label: t`Activity`, width: "w-32" },
    { label: t`Fit`, width: "w-48" },
    { label: t`Actions`, width: "w-60" },
  ];
  return (
    <section aria-label={t`Contacts`}>
      {autumn ? (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            {list.total !== null ? (
              <p className="text-base font-semibold">
                <Plural value={list.total} _1="# candidate" other="# candidates" />
              </p>
            ) : null}
            {list.total !== null && list.total > rows.length && rows.length ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Showing the first {rows.length}</Trans>
              </p>
            ) : null}
          </div>
          {props.onRefine ? (
            <Button onClick={props.onRefine}>
              <Sparkles size={15} aria-hidden />
              <Trans>Refine in chat</Trans>
            </Button>
          ) : null}
        </header>
      ) : (
        <TabHeader title={<Trans>Contacts</Trans>}>
          {list.total !== null ? (
            <span className="text-sm text-muted-foreground">{list.total}</span>
          ) : null}
        </TabHeader>
      )}
      {!autumn && list.crm.status !== "loading" && list.crm.status !== "failed" ? (
        <CrmGate crm={list.crm} />
      ) : null}
      {autumn && (saved.data?.partial || saved.data?.status === "unsupported") ? (
        <p className="text-muted-foreground">
          <Trans>Some saved contact details could not be displayed.</Trans>
        </p>
      ) : null}
      {autumn && saved.data?.status === "not_checked" ? (
        <p className="text-muted-foreground">
          <Trans>Contact details have not been checked yet.</Trans>
        </p>
      ) : null}
      {rows.length ? (
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-border">
          <table className="w-full min-w-[960px] table-fixed border-collapse text-left text-sm">
            <colgroup>
              {columns.map((column) => (
                <col key={column.label} className={column.width} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                {columns.map((column) => (
                  <th scope="col" key={column.label} className="px-3 py-2.5 font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const person = row.crm;
                const candidate = row.autumn;
                const name = row.name ?? t`Unnamed candidate`;
                const rowId = person?.candidateId ?? candidate?.candidateKey;
                const selected =
                  openId === rowId ||
                  (!detail && candidate && autumn?.selectedKey === candidate.candidateKey);
                const activity = person?.stage || person?.outreachStatus;
                const shortlistFailed =
                  candidate && autumn?.shortlistFailedKey === candidate.candidateKey;
                const school = showEducation ? education(row) : null;
                return (
                  <tr
                    key={row.key}
                    data-selected={selected || undefined}
                    className="cursor-pointer border-t border-border align-middle hover:bg-muted/50 data-selected:bg-muted"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button, a")) return;
                      openRow(index, event.currentTarget);
                    }}
                  >
                    <th scope="row" className="px-3 py-3 font-medium">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <PersonAvatar name={name} size="sm" />
                        <button
                          type="button"
                          className="min-w-0 truncate text-left hover:underline"
                          aria-haspopup="dialog"
                          onClick={(event) => openRow(index, event.currentTarget)}
                        >
                          {name}
                        </button>
                      </span>
                    </th>
                    <td className="px-3 py-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <Building2
                          size={16}
                          aria-hidden
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0">
                          <span className={clamp1} title={row.title ?? undefined}>
                            {row.title ?? "—"}
                          </span>
                          {candidate?.company ? (
                            <span
                              className={`${clamp1} text-xs text-muted-foreground`}
                              title={candidate.company}
                            >
                              {candidate.company}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </td>
                    {showEducation ? (
                      <td className="px-3 py-3">
                        <span className={clamp2} title={school ?? undefined}>
                          {school ?? "—"}
                        </span>
                      </td>
                    ) : null}
                    <td className="px-3 py-3">
                      <span className={clamp2} title={row.location ?? undefined}>
                        {row.location ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      {activity ? (
                        <Badge variant="outline" className="max-w-full">
                          <span className="truncate">{statusText(activity)}</span>
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Fit candidate={candidate} />
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-2">
                        {candidate && autumn ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-pressed={candidate.shortlisted}
                            aria-label={
                              candidate.shortlisted
                                ? t`Remove ${name} from shortlist`
                                : t`Add ${name} to shortlist`
                            }
                            disabled={!autumn.ready}
                            onClick={() => autumn.setShortlist(candidate, !candidate.shortlisted)}
                          >
                            <Bookmark
                              size={14}
                              aria-hidden
                              fill={candidate.shortlisted ? "currentColor" : "none"}
                            />
                            {candidate.shortlisted ? (
                              <Trans>Shortlisted</Trans>
                            ) : (
                              <Trans>Shortlist</Trans>
                            )}
                          </Button>
                        ) : null}
                        {candidate && autumn?.sendEmail ? (
                          <Button
                            size="sm"
                            disabled={!autumn.ready || (!candidate.name && !candidate.linkedinUrl)}
                            onClick={() => autumn.sendEmail!(candidate)}
                          >
                            <Mail size={14} aria-hidden />
                            <Trans>Email draft</Trans>
                          </Button>
                        ) : !candidate && person && detail ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              const next = target(index);
                              if (next) detail.open({ ...next, view: "thread" });
                            }}
                          >
                            <Mail size={14} aria-hidden />
                            <Trans>Email draft</Trans>
                          </Button>
                        ) : null}
                      </span>
                      {shortlistFailed ? (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          <Trans>Could not save shortlist</Trans>
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {loading ? <TabLoading /> : null}
      {failures}
      {empty ? (
        <TabNotice>
          {autumn ? (
            <Trans>No saved candidates</Trans>
          ) : (
            <Trans>No CRM contacts for this role yet.</Trans>
          )}
        </TabNotice>
      ) : null}
      {!loading ? <LoadMore pages={list.more} /> : null}
      {unmatched.length ? (
        <section className="mt-6" aria-label={t`Saved contact lookups`}>
          <h3 className="mb-2 text-sm font-semibold">
            <Trans>Saved contact lookups</Trans>
          </h3>
          <ul className="space-y-2 text-sm">
            {unmatched.map((contact, index) => (
              <li
                key={`${contact.candidateKey}:${index}`}
                className="rounded-lg border border-border p-3"
              >
                <a
                  href={contact.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  <Trans>LinkedIn</Trans>
                </a>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {contact.emails.map((email, emailIndex) => (
                    <li key={`${email.address}:${emailIndex}`}>
                      {email.address} · {statusText(email.status)}
                    </li>
                  ))}
                  {contact.phones.length ? (
                    <li>{contact.phones.map((phone) => phone.number).join(", ")}</li>
                  ) : null}
                  <li>
                    {contact.source} · {formatDate(contact.checkedAt)}
                  </li>
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
