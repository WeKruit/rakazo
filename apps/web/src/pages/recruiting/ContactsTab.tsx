import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCandidate, RecruitingCorrespondence } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Bookmark, Mail, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandidateDirectory } from "./CandidateDirectory";
import type { ShortlistWeekFilter } from "./dashboard-drilldown";
import { isInShortlistWeek } from "./dashboard-drilldown";
import type { RecruitingDetailTarget } from "./detail";
import { pendingDetailTarget, useRecruitingDetail } from "./detail";
import type { ProfileCriterionRevision } from "./profile";
import { candidateSections } from "./profile";
import { RetryNotice } from "./RetryNotice";
import { linkedinIdentity } from "./roleCandidates";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
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

/**
 * The role's one candidate list: Autumn search results and the role's CRM contacts with the same
 * columns and one row per person. Each source renders when it loads and retries on its own; a row
 * opens the person in the detail panel beside the page.
 */
export function ContactsTab(
  props: RecruitingTabProps & {
    autumn?: AutumnCandidatesRead & AutumnCandidateActions;
    shortlistWeekFilter?: ShortlistWeekFilter;
    onClearShortlistWeekFilter?: () => void;
    criterionRevision?: ProfileCriterionRevision;
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
      ...(props.shortlistWeekFilter ? { includeCrm: false } : {}),
      email: (candidate) =>
        lookups.find((contact) => contact.candidateKey === candidate.candidateKey)?.emails[0]
          ?.address ?? null,
    },
  });
  const filter = props.shortlistWeekFilter;
  const rows = useMemo(
    () =>
      filter
        ? list.rows.filter(
            (row) =>
              props.roleId === filter.roleId &&
              row.autumn?.roleId === filter.roleId &&
              isInShortlistWeek(row.autumn, filter),
          )
        : list.rows,
    [list.rows, filter, props.roleId],
  );
  const loadedCount = rows.length;
  const total = filter
    ? list.more.hasMore || list.autumn?.loading || list.autumn?.failed
      ? null
      : rows.length
    : list.total;
  const unmatched = filter
    ? []
    : lookups.filter((contact) => !rows.some((row) => lookupsFor(row).includes(contact)));
  const failures = [
    list.autumn?.failed ? (
      <RetryNotice key="autumn" onRetry={list.autumn.retry}>
        <Trans>Could not load search results</Trans>
      </RetryNotice>
    ) : null,
    list.crmRead.failed ? (
      <RetryNotice key="crm" onRetry={list.crmRead.retry}>
        <Trans>Could not load candidate records</Trans>
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
      criterionRevision: props.criterionRevision,
      crm: Boolean(crm),
      ...(candidate ? { candidate } : {}),
      person: {
        candidateId: crm?.candidateId ?? candidate!.candidateKey,
        name: row.name ?? t`Unnamed candidate`,
        email: crm?.email ?? rowLookups[0]?.emails[0]?.address ?? sections.email,
        phone: crm?.phone ?? rowLookups[0]?.phones[0]?.number ?? sections.phone,
        title: row.title,
        company: crm?.company ?? candidate?.company ?? null,
        profile: crm?.profile,
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
      const restored = candidate && pendingDetailTarget(candidate, pendingDetail);
      if (restored) return detail.restore(restored);
    }
  }, [pendingDetail, rows]);

  const toolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {total !== null ? (
        <p>
          <Plural value={total} _1="# candidate" other="# candidates" />
        </p>
      ) : null}
      {total !== null && total > rows.length && rows.length ? (
        <p>
          <Trans>Showing the first {rows.length}</Trans>
        </p>
      ) : null}
      {props.onRefine ? (
        <Button size="sm" variant="outline" className="ml-auto" onClick={props.onRefine}>
          <Sparkles size={14} aria-hidden />
          <Trans>Refine in chat</Trans>
        </Button>
      ) : null}
    </div>
  );

  return (
    <section aria-label={t`Contacts`}>
      {filter ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <p>
            <Trans>Shortlisted</Trans> · {new Date(filter.from).toLocaleDateString()} –{" "}
            {new Date(Date.parse(filter.before) - 1).toLocaleDateString()}
          </p>
          <Button size="sm" variant="outline" onClick={props.onClearShortlistWeekFilter}>
            <Trans>Clear date filter</Trans>
          </Button>
          {filter.roleId !== props.roleId ? (
            <p role="alert">
              <Trans>This filter belongs to another role.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {!rows.length && props.onRefine ? <div className="mb-2">{toolbar}</div> : null}
      {!autumn && list.crm.status !== "loading" && list.crm.status !== "failed" ? (
        <CrmGate crm={list.crm} />
      ) : null}
      {autumn && (saved.data?.partial || saved.data?.status === "unsupported") ? (
        <p className="text-muted-foreground">
          <Trans>Some saved contact details could not be displayed.</Trans>
        </p>
      ) : null}
      {total === null && loadedCount > 0 ? (
        <p className="mb-2 text-sm text-muted-foreground">
          <Trans>{loadedCount} loaded</Trans>
        </p>
      ) : null}
      {rows.length ? (
        <CandidateDirectory
          rows={rows}
          criterionRevision={props.criterionRevision}
          toolbar={toolbar}
          selectedKey={
            rows.find(
              (row) =>
                openId === (row.crm?.candidateId ?? row.autumn?.candidateKey) ||
                (!detail && row.autumn && autumn?.selectedKey === row.autumn.candidateKey),
            )?.key
          }
          onOpen={(_row, index, trigger) => openRow(index, trigger)}
          renderActions={(row, index) => {
            const candidate = row.autumn;
            const person = row.crm;
            const name = row.name ?? t`Unnamed candidate`;
            return (
              <>
                <span className="flex flex-wrap items-center gap-2">
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
                {candidate && autumn?.shortlistFailedKey === candidate.candidateKey ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    <Trans>Could not save shortlist</Trans>
                  </p>
                ) : null}
              </>
            );
          }}
        />
      ) : null}
      {loading ? <TabLoading /> : null}
      {failures}
      {empty ? (
        <TabNotice>
          {filter ? (
            <Trans>No loaded candidates match this date filter.</Trans>
          ) : autumn ? (
            <Trans>No saved candidates</Trans>
          ) : (
            <Trans>No contacts for this role yet.</Trans>
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
                {contact.linkedinUrl ? (
                  <a
                    href={contact.linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    <Trans>LinkedIn</Trans>
                  </a>
                ) : null}
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
