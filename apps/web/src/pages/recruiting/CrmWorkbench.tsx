import { lazyPanel } from "../../components/ErrorBoundary";
import type { RecruitingInboxEmail, RecruitingTabProps } from "../recruiting";

const CorrespondenceEmails = lazyPanel(() =>
  import("../RecruitingCorrespondence").then((m) => m.CorrespondenceEmails),
);
const SequenceTab = lazyPanel(() => import("./SequenceTab").then((m) => m.SequenceTab));
const InterviewTab = lazyPanel(() => import("./InterviewTab").then((m) => m.InterviewTab));
const InboxWithReply = lazyPanel(() => import("./InboxTab").then((m) => m.InboxWithReply));

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type {
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmTarget,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { retryTransientRead } from "../../lib/read-retry";
import { clearRecruitingReads, rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";
import type { RecruitingDetailPerson } from "../recruiting/detail";
import { useRecruitingDetail } from "../recruiting/detail";
import { TabLoading, tabCacheSlot, useKeyedRead } from "../recruiting/shared";
import type { Props } from "../recruiting/workspace-types";
import type { RecruitingWorkspaceView } from "../shell/RecruitingNavigation";

type BoundRole = {
  roleId: string;
  spaceId: string;
  title: string;
  crmTarget: RecruitingCrmTarget;
};

/**
 * The role conversation's native role when it is bound to a CRM role; `done` once known. The
 * binding is handed to the role tabs so they read CRM rows without re-reading it.
 */
function useBoundRole(
  threadId: string,
  enabled: boolean,
  refreshSignal: number,
  cache: Pick<Props, "readCache" | "readCacheScope">,
): { done: boolean; role?: BoundRole; title?: string } {
  const read = useKeyedRead(
    enabled ? JSON.stringify([threadId, refreshSignal]) : null,
    async (): Promise<{ role?: BoundRole; title?: string }> => {
      const workspace = await rpc.recruiting.getWorkspace({ threadId });
      // The native role names the workbench, bound to a CRM role or not.
      const title = workspace?.role.title;
      return workspace?.crmTarget
        ? {
            title,
            role: {
              roleId: workspace.role.id,
              spaceId: workspace.role.spaceId,
              title: workspace.role.title,
              crmTarget: workspace.crmTarget.target,
            },
          }
        : { title };
    },
    tabCacheSlot(cache, ["boundRole", threadId]),
  );
  return {
    done: !enabled || Boolean(read.data) || read.failed,
    role: read.data?.role,
    title: read.data?.title,
  };
}

export function CrmRecruitingPanel({
  onReviewSchedulingPlan,
  browse,
  agent,
  threadId,
  botId,
  groupId,
  readCache,
  readCacheScope,
  showDiagnostics = false,
  refreshSignal = 0,
}: Props & { browse: NonNullable<Props["crmBrowse"]>; agent?: ReactNode }) {
  const { t } = useLingui();
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const bound = useBoundRole(threadId, Boolean(agent), refreshSignal + refresh, {
    readCache,
    readCacheScope,
  });
  const boundRole = bound.role && {
    roleId: bound.role.roleId,
    spaceId: bound.role.spaceId,
    crmTarget: bound.role.crmTarget,
    readCache,
    readCacheScope,
  };
  // The role tabs read their own CRM data; stored CRM views read only when they are shown.
  const storedCrmReads = !agent || (bound.done && !bound.role);
  const [mailPageSelection, setMailPageSelection] = useState<{
    candidateId: string;
    cursor: Extract<RecruitingCrmDataInput, { operation: "mail" }>["cursor"];
  }>();
  const mailCursor =
    mailPageSelection?.candidateId === browse.candidateId ? mailPageSelection?.cursor : undefined;
  const setMailCursor = (
    cursor: Extract<RecruitingCrmDataInput, { operation: "mail" }>["cursor"],
  ) =>
    setMailPageSelection(
      browse.candidateId ? { candidateId: browse.candidateId, cursor } : undefined,
    );
  const [selectedMail, setSelectedMail] = useState<string>();
  type CandidatePage = Extract<RecruitingCrmDataOutput, { operation: "candidates" }>;
  type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
  const target = groupId ? { groupId } : { botId: botId! };
  const input = {
    ...target,
    operation: "candidates" as const,
    ...browse.selection,
    query,
    limit: 30,
    offset,
  };
  const key = JSON.stringify([readCacheScope, input, refreshSignal, refresh]);
  const cacheKey = readCacheScope ? `${readCacheScope}:crm:${JSON.stringify(input)}` : undefined;
  const [read, setRead] = useState<{
    key: string;
    data?: CandidatePage;
    failed?: boolean;
    loading?: boolean;
  }>();
  useEffect(() => {
    if (!storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    setRead({
      key,
      loading: true,
      data: cacheKey ? (readCache?.entries.get(cacheKey) as CandidatePage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(input), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch) return setRead({ key, failed: true });
        if (
          value.operation !== "candidates" ||
          value.source.serverId !== browse.selection.serverId ||
          value.source.serverRevision !== browse.selection.serverRevision ||
          value.source.organizationId !== browse.selection.organizationId ||
          (browse.selection.crmRoleId &&
            value.selectedRole?.crmRoleId !== browse.selection.crmRoleId)
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, cacheKey, value, epoch);
        setRead({ key, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setRead({ key, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [key, cacheKey, readCache, readCacheScope, storedCrmReads]);
  const page = read?.key === key ? read.data : undefined;
  const mailInput = {
    ...target,
    operation: "mail" as const,
    serverId: browse.selection.serverId,
    serverRevision: browse.selection.serverRevision,
    organizationId: browse.selection.organizationId,
    candidateId: browse.candidateId ?? "",
    ...(browse.selection.crmRoleId ? { crmRoleId: browse.selection.crmRoleId } : {}),
    limit: 30,
    ...(mailCursor ? { cursor: mailCursor } : {}),
  };
  const mailKey = JSON.stringify([readCacheScope, mailInput, refreshSignal, refresh]);
  const [mail, setMail] = useState<{
    key: string;
    data?: MailPage;
    failed?: boolean;
    validated?: boolean;
  }>();
  useEffect(() => {
    setSelectedMail(undefined);
  }, [browse.candidateId]);
  useEffect(() => {
    if (browse.view !== "inbox" || !browse.candidateId || !storedCrmReads) {
      setMail(undefined);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(mailInput)}`
      : undefined;
    setMail({
      key: mailKey,
      data: savedKey ? (readCache?.entries.get(savedKey) as MailPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(mailInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch) return setMail({ key: mailKey, failed: true });
        if (
          value.operation !== "mail" ||
          value.source.serverId !== browse.selection.serverId ||
          value.source.serverRevision !== browse.selection.serverRevision ||
          value.source.organizationId !== browse.selection.organizationId ||
          value.candidateId !== browse.candidateId ||
          value.nativeCorrespondence.some(
            (entry) =>
              entry.candidateId !== browse.candidateId ||
              entry.crmRoleId !== browse.selection.crmRoleId,
          )
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setMail({ key: mailKey, data: value, validated: true });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setMail({ key: mailKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [mailKey, browse.view, readCache, readCacheScope, storedCrmReads]);
  const currentMail = mail?.key === mailKey ? mail : undefined;
  const mailPage = currentMail?.data;
  const nativeMail = mailPage?.nativeCorrespondence ?? [];
  const nativeByEmail = new Map<string, (typeof nativeMail)[number]>();
  for (const entry of nativeMail) {
    if (!entry.email) continue;
    const previous = nativeByEmail.get(entry.email.id);
    if (!previous || Date.parse(entry.checkedAt) > Date.parse(previous.checkedAt))
      nativeByEmail.set(entry.email.id, entry);
  }
  const nativeEmails = [...nativeByEmail.values()];
  const inboxEmails = [
    ...nativeEmails.flatMap((entry) =>
      entry.email ? [{ ...entry.email, id: `native:${entry.email.id}` }] : [],
    ),
    ...(mailPage?.items.map((item) => ({
      id: `crm:${item.id}`,
      sender: item.sender,
      recipients: item.recipients,
      subject: item.subject ?? "",
      body: item.body ?? "",
      snippet: item.partial,
      date: item.date,
      url: null,
    })) ?? []),
  ];
  const selectedInboxEmail = inboxEmails.find((item) => item.id === selectedMail) ?? inboxEmails[0];
  const selectedNativeMail = nativeEmails.find(
    (entry) => entry.email && `native:${entry.email.id}` === selectedInboxEmail?.id,
  );
  const nativeMailStatus = {
    read: t`Saved email`,
    sent_recorded: t`Send recorded`,
    scheduled: t`Scheduled`,
    unknown: t`Send outcome unknown`,
  };
  const draftEmail = currentMail?.validated ? selectedInboxEmail : undefined;
  const people = page?.items ?? [];
  const selectedPerson = people.find((person) => person.candidateId === browse.candidateId);
  const importantView = ["shortlist", "interview", "workflow"].includes(browse.view);
  type ImportantStatus = NonNullable<
    Extract<RecruitingCrmDataInput, { operation: "important" }>["status"]
  >;
  const workflowLabels = {
    waiting_resume: t`Waiting for resume`,
    resume_ready: t`Resume ready`,
    introduced: t`Introduced`,
    needs_scheduling: t`Needs scheduling`,
    scheduled: t`Scheduled`,
    awaiting_feedback: t`Awaiting feedback`,
  };
  const [statusSelection, setStatusSelection] = useState<{
    view: RecruitingWorkspaceView;
    status: ImportantStatus | "";
  }>();
  const importantStatus =
    statusSelection?.view === browse.view
      ? statusSelection.status
      : browse.view === "shortlist"
        ? "high_signal"
        : browse.view === "interview"
          ? "needs_scheduling"
          : "";
  const [sectionPage, setSectionPage] = useState<{ key: string; offset: number }>();
  const sectionScope = JSON.stringify([browse.view, importantStatus]);
  const sectionOffset = sectionPage?.key === sectionScope ? sectionPage.offset : 0;
  const pinned = {
    serverId: browse.selection.serverId,
    serverRevision: browse.selection.serverRevision,
    organizationId: browse.selection.organizationId,
  };
  const sectionInput = importantView
    ? {
        ...target,
        ...pinned,
        operation: "important" as const,
        ...(importantStatus ? { status: importantStatus } : {}),
        limit: 30,
        offset: sectionOffset,
      }
    : browse.view === "sequence" && browse.selection.crmRoleId
      ? {
          ...target,
          ...pinned,
          operation: "roleCampaigns" as const,
          crmRoleId: browse.selection.crmRoleId,
          limit: 30,
          offset: sectionOffset,
        }
      : undefined;
  const sectionKey = JSON.stringify([readCacheScope, sectionInput, refreshSignal, refresh]);
  type SectionPage = Extract<RecruitingCrmDataOutput, { operation: "important" | "roleCampaigns" }>;
  const [sectionRead, setSectionRead] = useState<{
    key: string;
    data?: SectionPage;
    loading?: boolean;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!sectionInput || !storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(sectionInput)}`
      : undefined;
    setSectionRead({
      key: sectionKey,
      loading: true,
      data: savedKey ? (readCache?.entries.get(savedKey) as SectionPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(sectionInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch)
          return setSectionRead({ key: sectionKey, failed: true });
        if (
          (value.operation !== "important" && value.operation !== "roleCampaigns") ||
          value.operation !== sectionInput.operation ||
          value.source.serverId !== pinned.serverId ||
          value.source.serverRevision !== pinned.serverRevision ||
          value.source.organizationId !== pinned.organizationId ||
          (value.operation === "roleCampaigns" && value.crmRoleId !== browse.selection.crmRoleId)
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setSectionRead({ key: sectionKey, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setSectionRead({ key: sectionKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [sectionKey, readCache, readCacheScope, storedCrmReads]);
  const section = sectionRead?.key === sectionKey ? sectionRead : undefined;
  const important = section?.data?.operation === "important" ? section.data : undefined;
  const campaigns = section?.data?.operation === "roleCampaigns" ? section.data : undefined;
  const [detailsPage, setDetailsPage] = useState<{ candidateId: string; offset: number }>();
  const detailsOffset =
    detailsPage?.candidateId === browse.candidateId ? (detailsPage?.offset ?? 0) : 0;
  const detailsInput =
    browse.candidateId && ["feedback", "sequence"].includes(browse.view)
      ? {
          ...target,
          ...pinned,
          operation: "candidateDetails" as const,
          candidateId: browse.candidateId,
          limit: 30,
          offset: detailsOffset,
        }
      : undefined;
  const detailsKey = JSON.stringify([readCacheScope, detailsInput, refreshSignal, refresh]);
  type DetailsPage = Extract<RecruitingCrmDataOutput, { operation: "candidateDetails" }>;
  const [detailsRead, setDetailsRead] = useState<{
    key: string;
    data?: DetailsPage;
    loading?: boolean;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!detailsInput || !storedCrmReads) return;
    let cancelled = false;
    const abort = new AbortController();
    const epoch = readCache?.epoch;
    const savedKey = readCacheScope
      ? `${readCacheScope}:crm:${JSON.stringify(detailsInput)}`
      : undefined;
    setDetailsRead({
      key: detailsKey,
      loading: true,
      data: savedKey ? (readCache?.entries.get(savedKey) as DetailsPage | undefined) : undefined,
    });
    void retryTransientRead(() => rpc.recruiting.crmData(detailsInput), abort.signal)
      .then((value) => {
        if (cancelled) return;
        // Invalidated in flight: not trusted, but the view must not stay loading.
        if (readCache && epoch !== readCache.epoch)
          return setDetailsRead({ key: detailsKey, failed: true });
        if (
          value.operation !== "candidateDetails" ||
          value.source.serverId !== pinned.serverId ||
          value.source.serverRevision !== pinned.serverRevision ||
          value.source.organizationId !== pinned.organizationId ||
          value.candidateId !== browse.candidateId
        )
          throw new Error("CRM scope changed");
        rememberRecruitingRead(readCache, savedKey, value, epoch);
        setDetailsRead({ key: detailsKey, data: value });
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(readCache, readCacheScope);
        setDetailsRead({ key: detailsKey, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [detailsKey, readCache, readCacheScope, storedCrmReads]);
  const currentDetails = detailsRead?.key === detailsKey ? detailsRead : undefined;
  const details = currentDetails?.data;
  const contactRegion = useRef<HTMLElement>(null);
  const contactHeadingId = useId();
  const revealedContact = useRef<string | null>(null);
  const contactRead = browse.view === "inbox" ? currentMail : currentDetails;
  const outbox = contactRead?.data?.outbox;
  const queueStatusLabels = {
    pending: t`Saved, not sent`,
    processing: t`Previously processing`,
    sent: t`Marked as sent`,
    failed: t`Send failed`,
  };
  const outboxContent = outbox ? (
    <section className="my-6 space-y-3" aria-label={t`Recruiter messages`}>
      <h3 className="font-semibold">
        <Trans>Recruiter messages</Trans>
      </h3>
      {contactRead?.data &&
      "outboxScope" in contactRead.data &&
      contactRead.data.outboxScope === "unavailable_for_role" ? (
        <p>
          <Trans>Recruiter messages are unavailable for this role.</Trans>
        </p>
      ) : outbox.length ? (
        outbox.map((message) => (
          <article key={message.id} className="space-y-2 border-t pt-3">
            <p>
              {queueStatusLabels[message.status]} ·{" "}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </p>
            <h4 className="font-semibold">
              <Trans>Original message</Trans>
            </h4>
            <p className="whitespace-pre-wrap">{message.body}</p>
            {message.polishedBody !== null ? (
              <>
                <h4 className="font-semibold">
                  <Trans>Polished message</Trans>
                </h4>
                <p className="whitespace-pre-wrap">{message.polishedBody}</p>
              </>
            ) : null}
            {message.error !== null ? (
              <>
                <p>
                  <Trans>There was a problem sending this message.</Trans>
                </p>
                {showDiagnostics ? (
                  <details>
                    <summary>
                      <Trans>Error details</Trans>
                    </summary>
                    <pre className="whitespace-pre-wrap">{message.error}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
            {message.sentAt !== null ? (
              <p>
                <Trans>Sent at</Trans>:{" "}
                <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time>
              </p>
            ) : null}
          </article>
        ))
      ) : (
        <p>
          <Trans>No recruiter messages were found.</Trans>
        </p>
      )}
    </section>
  ) : null;
  const contactReady = Boolean(contactRead?.data || contactRead?.failed);
  const contactKey = JSON.stringify([
    readCacheScope,
    browse.view,
    browse.view === "inbox" ? mailInput : detailsInput,
    browse.view === "inbox" ? selectedMail : undefined,
  ]);
  const revealContact = useCallback(() => {
    contactRegion.current?.scrollIntoView({ block: "start" });
    contactRegion.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!browse.candidateId || !["inbox", "feedback", "sequence"].includes(browse.view)) {
      revealedContact.current = null;
      return;
    }
    if (!contactReady || revealedContact.current === contactKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (!contactRegion.current) return;
      revealContact();
      revealedContact.current = contactKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [browse.candidateId, browse.view, contactKey, contactReady, revealContact]);
  const detail = useRecruitingDetail();
  function selectContact(
    id: string,
    view?: RecruitingWorkspaceView,
    person?: RecruitingDetailPerson,
  ) {
    // A role with its own workbench opens the person beside the page instead of switching tabs.
    if (detail && boundRole && person && (!view || view === "inbox")) {
      detail.open({ view: "thread", person, role: { ...boundRole, conversation: target } });
      return;
    }
    if (browse.view === (view ?? "inbox") && browse.candidateId === id && contactReady)
      revealContact();
    if (view) browse.onSelectCandidate(id, view);
    else browse.onSelectCandidate(id);
  }
  const selectedRole = page?.selectedRole;
  const roleJdUrl =
    selectedRole?.jdUrl && /^https?:\/\//i.test(selectedRole.jdUrl) ? selectedRole.jdUrl : null;
  const initialDescription = selectedRole
    ? [`${selectedRole.roleLabel} · ${selectedRole.clientLabel}`, selectedRole.jdText, roleJdUrl]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const crmHistory = (
    <>
      {agent ? (
        <h2 className="mt-8 mb-3 font-semibold">
          <Trans>Earlier history</Trans>
        </h2>
      ) : (
        <span className="hire-eyebrow">
          <Trans>Earlier history</Trans>
        </span>
      )}
      <div className="mb-5 flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
          <Trans>Refresh</Trans>
        </Button>
        {browse.onStartRecruiting ? (
          <Button
            disabled={!initialDescription || read?.loading || read?.failed}
            onClick={() => browse.onStartRecruiting?.(initialDescription)}
          >
            <Trans>Start recruiting</Trans>
          </Button>
        ) : null}
      </div>
      {read?.key !== key || read.loading ? (
        <p role="status" className="py-2 text-sm">
          <Shimmer>{t`Loading candidate records…`}</Shimmer>
        </p>
      ) : null}
      {read?.key === key && read.failed ? (
        <p role="alert">
          <Trans>Could not load candidate records. Try refreshing.</Trans>
        </p>
      ) : null}
      {page?.scope === "legacy_role_labels" && !importantView && browse.view !== "sequence" ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>
            Historical records matched to this client and role. These are not new search results or
            a verified shortlist.
          </Trans>
        </p>
      ) : null}
      {importantView ? (
        <section className="space-y-4">
          <h2 className="font-semibold">
            {browse.view === "interview" ? t`Interview workflow` : t`Important`}
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>Organization-wide candidate-role records.</Trans>
          </p>
          <NativeSelect
            aria-label={t`Workflow filter`}
            value={importantStatus}
            onChange={(event) => {
              setStatusSelection({
                view: browse.view,
                status: event.target.value as ImportantStatus | "",
              });
            }}
          >
            {browse.view !== "interview" ? (
              <NativeSelectOption value="">
                <Trans>All Important records</Trans>
              </NativeSelectOption>
            ) : null}
            {browse.view !== "interview" ? (
              <NativeSelectOption value="high_signal">
                <Trans>High signal</Trans>
              </NativeSelectOption>
            ) : null}
            {Object.entries(workflowLabels)
              .filter(
                ([status]) =>
                  browse.view !== "interview" ||
                  ["needs_scheduling", "scheduled", "awaiting_feedback"].includes(status),
              )
              .map(([status, label]) => (
                <NativeSelectOption key={status} value={status}>
                  {label}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          {!section || section.loading ? (
            <p role="status">
              <Trans>Loading candidate records…</Trans>
            </p>
          ) : null}
          {section?.failed ? (
            <p role="alert">
              <Trans>Could not load candidate records. Try refreshing.</Trans>
            </p>
          ) : null}
          {important ? (
            <>
              <p>
                <Plural
                  value={important.total}
                  _1="# candidate-role record"
                  other="# candidate-role records"
                />
              </p>
              <div className="hire-table-wrap overflow-x-auto">
                <table className="hire-table w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        t`Candidate`,
                        t`Client`,
                        t`Role`,
                        t`High signal`,
                        t`Workflow status`,
                        t`Updated`,
                        t`Messages`,
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {important.items.map((person) => (
                      <tr key={JSON.stringify([person.candidateId, person.roleKey])}>
                        <th scope="row">{person.name}</th>
                        <td>{person.clientLabel}</td>
                        <td>{person.roleLabel}</td>
                        <td>{person.highSignal ? t`High signal` : "—"}</td>
                        <td>
                          {person.workflowStatus ? workflowLabels[person.workflowStatus] : "—"}
                        </td>
                        <td>
                          {new Date(person.statusChangedAt ?? person.updatedAt).toLocaleString()}
                        </td>
                        <td>
                          <Button
                            variant="link"
                            onClick={() => selectContact(person.candidateId, undefined, person)}
                          >
                            <Trans>View messages</Trans>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!important.items.length ? (
                <p>
                  <Trans>No Important records matched this filter.</Trans>
                </p>
              ) : null}
            </>
          ) : null}
          <div className="flex gap-2">
            {sectionOffset > 0 ? (
              <Button
                variant="outline"
                onClick={() =>
                  setSectionPage({ key: sectionScope, offset: Math.max(0, sectionOffset - 30) })
                }
              >
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {important?.nextOffset != null ? (
              <Button
                variant="outline"
                onClick={() => setSectionPage({ key: sectionScope, offset: important.nextOffset! })}
              >
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "interview" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Calendar booking details are not included in these manual CRM workflow records.
              </Trans>
            </p>
          ) : null}
        </section>
      ) : browse.view === "brief" ? (
        <section className="space-y-4">
          {selectedRole &&
          ![selectedRole.summary, selectedRole.description, selectedRole.jdText, roleJdUrl].some(
            (value) => value?.trim(),
          ) ? (
            <p>
              <Trans>
                No job description is saved for this role. Add a JD or link when starting
                recruiting.
              </Trans>
            </p>
          ) : null}
          {page?.selectedRole?.summary ? <p>{page.selectedRole.summary}</p> : null}
          {page?.selectedRole?.description ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.description}</p>
          ) : null}
          {page?.selectedRole?.jdText ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.jdText}</p>
          ) : null}
          {roleJdUrl ? (
            <a className="underline" href={roleJdUrl} target="_blank" rel="noreferrer">
              <Trans>Original job description</Trans>
            </a>
          ) : null}
        </section>
      ) : (
        <>
          {browse.view === "sequence" ? (
            <section className="mb-6 space-y-4">
              <h2 className="font-semibold">
                <Trans>Role campaigns</Trans>
              </h2>
              {!browse.selection.crmRoleId ? (
                <p>
                  <Trans>Choose a role to see its outreach.</Trans>
                </p>
              ) : !section || section.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {section?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {campaigns ? (
                <>
                  <div className="hire-table-wrap overflow-x-auto">
                    <table className="hire-table w-full text-left text-sm">
                      <thead>
                        <tr>
                          {[t`Campaign`, t`Provider status code`, t`Last synced`].map((label) => (
                            <th scope="col" key={label}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {campaigns.items.map((campaign) => (
                          <tr key={campaign.id}>
                            <th scope="row">{campaign.name}</th>
                            <td>{campaign.status ?? "—"}</td>
                            <td>{new Date(campaign.syncedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!campaigns.items.length ? (
                    <p>
                      <Trans>No stored campaign associations were returned for this role.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {sectionOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({
                            key: sectionScope,
                            offset: Math.max(0, sectionOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous campaigns</Trans>
                      </Button>
                    ) : null}
                    {campaigns.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({ key: sectionScope, offset: campaigns.nextOffset! })
                        }
                      >
                        <Trans>Next campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Sequence steps and delivery status are not included in these stored campaign
                  associations.
                </Trans>
              </p>
            </section>
          ) : null}
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              setQuery(queryDraft.trim());
            }}
          >
            <Input
              aria-label={t`Search contacts`}
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Trans>Search</Trans>
            </Button>
          </form>
          {page ? (
            <p className="mb-3 text-sm">
              <Plural value={page.total} _1="# contact" other="# contacts" />
            </p>
          ) : null}
          {page ? (
            <div className="hire-table-wrap overflow-x-auto">
              <table className="hire-table w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      t`Candidate`,
                      t`Current role`,
                      t`Email`,
                      t`Phone`,
                      t`Stage`,
                      t`Contact status`,
                      t`Outreach status`,
                      browse.view === "feedback" || browse.view === "sequence"
                        ? t`Details`
                        : t`Messages`,
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.candidateId}>
                      <th scope="row">
                        {person.name}
                        {person.linkedinUrl && /^https?:\/\//i.test(person.linkedinUrl) ? (
                          <a
                            className="block text-xs underline"
                            href={person.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Trans>LinkedIn</Trans>
                          </a>
                        ) : null}
                      </th>
                      <td>
                        {person.title ?? "—"}
                        {person.location ? (
                          <small className="block">{person.location}</small>
                        ) : null}
                      </td>
                      <td>{person.email ?? "—"}</td>
                      <td>{person.phone ?? "—"}</td>
                      <td>{person.stage ?? "—"}</td>
                      <td>{person.contactStatus || "—"}</td>
                      <td>{person.outreachStatus || "—"}</td>
                      <td>
                        <Button
                          variant="link"
                          onClick={() =>
                            browse.view === "feedback" || browse.view === "sequence"
                              ? selectContact(person.candidateId, browse.view)
                              : selectContact(person.candidateId, undefined, person)
                          }
                        >
                          {browse.view === "feedback" || browse.view === "sequence" ? (
                            <Trans>View details</Trans>
                          ) : (
                            <Trans>View messages</Trans>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {page && !people.length ? (
            <p>
              <Trans>No records matched this search.</Trans>
            </p>
          ) : null}
          <div className="my-4 flex gap-2">
            {offset > 0 ? (
              <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 30))}>
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {page?.nextOffset !== null && page?.nextOffset !== undefined ? (
              <Button variant="outline" onClick={() => setOffset(page.nextOffset!)}>
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "feedback" || browse.view === "sequence" ? (
            <section
              ref={contactRegion}
              aria-labelledby={contactHeadingId}
              tabIndex={-1}
              className="my-6 space-y-4"
            >
              <h2 id={contactHeadingId} className="font-semibold">
                {selectedPerson?.name ?? details?.review?.candidateName ?? t`Candidate details`}
              </h2>
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored details.</Trans>
                </p>
              ) : !currentDetails || currentDetails.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {currentDetails?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {details && browse.view === "feedback" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Role interest</Trans>
                  </h3>
                  {details.roleInterests.length ? (
                    <div className="hire-table-wrap overflow-x-auto">
                      <table className="hire-table w-full text-left text-sm">
                        <thead>
                          <tr>
                            {[t`Client`, t`Role`, t`Interest`, t`Source`].map((label) => (
                              <th scope="col" key={label}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {details.roleInterests.map((interest) => (
                            <tr key={interest.roleKey}>
                              <th scope="row">{interest.clientLabel}</th>
                              <td>{interest.roleLabel}</td>
                              <td>
                                {interest.interest === "interested"
                                  ? t`Interested`
                                  : interest.interest === "declined"
                                    ? t`Declined`
                                    : t`Unknown`}
                              </td>
                              <td>
                                {interest.source === "manual"
                                  ? t`Human-entered`
                                  : interest.source === "ai"
                                    ? t`AI interpretation`
                                    : interest.source === "instantly"
                                      ? t`Email reply`
                                      : t`Unknown`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      <Trans>No stored role-interest records were returned.</Trans>
                    </p>
                  )}
                  <h3 className="font-semibold">
                    <Trans>Internal review</Trans>
                  </h3>
                  {details.review ? (
                    <div className="space-y-2">
                      {details.review.roleTitle ? <p>{details.review.roleTitle}</p> : null}
                      <p>
                        {details.review.stage ?? "—"} ·{" "}
                        {details.review.reviewed === true
                          ? t`Reviewed`
                          : details.review.reviewed === false
                            ? t`Not reviewed`
                            : t`Review status unknown`}
                      </p>
                      {details.review.result ? (
                        <p>
                          {details.review.result === "approved"
                            ? t`Approved in internal review`
                            : details.review.result === "rejected"
                              ? t`Rejected in internal review`
                              : t`Pooled in internal review`}
                        </p>
                      ) : null}
                      {details.review.notes ? (
                        <p className="whitespace-pre-wrap">{details.review.notes}</p>
                      ) : null}
                    </div>
                  ) : (
                    <p>
                      <Trans>No internal review was returned.</Trans>
                    </p>
                  )}
                </>
              ) : null}
              {details && browse.view === "sequence" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Contact campaign associations</Trans>
                  </h3>
                  {details.campaignAssociations.pipelineCampaign ? (
                    <p>
                      {details.campaignAssociations.pipelineCampaign.name} ·{" "}
                      <Trans>Primary pipeline campaign</Trans>
                    </p>
                  ) : null}
                  {details.campaignAssociations.leadCampaigns.map((association) => (
                    <p key={association.leadId}>
                      {association.campaign?.name ?? t`Campaign details unavailable`}
                      {association.campaign ? (
                        <>
                          {" "}
                          · <Trans>Provider status code</Trans>:{" "}
                          {association.campaign.status ?? "—"}
                        </>
                      ) : null}
                    </p>
                  ))}
                  {!details.campaignAssociations.pipelineCampaign &&
                  !details.campaignAssociations.leadCampaigns.length ? (
                    <p>
                      <Trans>No contact campaign associations were returned.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {detailsOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: Math.max(0, detailsOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous contact campaigns</Trans>
                      </Button>
                    ) : null}
                    {details.campaignAssociations.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: details.campaignAssociations.nextOffset!,
                          })
                        }
                      >
                        <Trans>Next contact campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              {outboxContent}
            </section>
          ) : null}
          {browse.view === "inbox" ? (
            <section ref={contactRegion} aria-labelledby={contactHeadingId} tabIndex={-1}>
              <h2 id={contactHeadingId} className="mb-3 font-semibold">
                {selectedPerson?.name ?? t`Candidate messages`}
              </h2>
              {browse.onDraftReply && draftEmail && browse.candidateId ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const person =
                      read?.key === key && !read.loading && !read.failed
                        ? selectedPerson
                        : undefined;
                    browse.onDraftReply?.({
                      threadId,
                      candidateId: browse.candidateId!,
                      ...(person
                        ? { candidateName: person.name, candidateEmail: person.email }
                        : {}),
                      email: {
                        sender: draftEmail.sender,
                        recipients: draftEmail.recipients,
                        subject: draftEmail.subject,
                        date: draftEmail.date,
                      },
                      source: {
                        serverId: browse.selection.serverId,
                        serverRevision: browse.selection.serverRevision,
                        organizationId: browse.selection.organizationId,
                      },
                      ...(browse.selection.crmRoleId
                        ? { crmRoleId: browse.selection.crmRoleId }
                        : {}),
                    });
                  }}
                >
                  <Trans>Draft reply</Trans>
                </Button>
              ) : null}
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored messages.</Trans>
                </p>
              ) : !currentMail || (!currentMail.data && !currentMail.failed) ? (
                <p role="status">
                  <Trans>Loading stored messages…</Trans>
                </p>
              ) : currentMail.failed ? (
                <p role="alert">
                  <Trans>Could not load stored messages. Try refreshing.</Trans>
                </p>
              ) : mailPage ? (
                <>
                  {inboxEmails.length ? (
                    <>
                      <p className="my-3 text-sm text-muted-foreground">
                        {selectedNativeMail?.email?.sourceName ?? mailPage.source.name}
                        {selectedNativeMail ? (
                          <> · {nativeMailStatus[selectedNativeMail.status]}</>
                        ) : null}
                      </p>
                      <CorrespondenceEmails
                        emails={inboxEmails}
                        selectedId={selectedInboxEmail?.id}
                        onSelect={setSelectedMail}
                      />
                    </>
                  ) : (
                    <p>
                      <Trans>No stored messages were returned for this contact.</Trans>
                    </p>
                  )}
                  {nativeMail
                    .filter((entry) => entry.status === "unknown")
                    .map((entry) => (
                      <p key={entry.id} role="status" className="my-3 text-sm">
                        {nativeMailStatus.unknown} ·{" "}
                        <time dateTime={entry.checkedAt}>
                          {new Date(entry.checkedAt).toLocaleString()}
                        </time>
                      </p>
                    ))}
                  {mailCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(undefined)}>
                      <Trans>Latest messages</Trans>
                    </Button>
                  ) : null}
                  {mailPage.nextCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(mailPage.nextCursor!)}>
                      <Trans>Older messages</Trans>
                    </Button>
                  ) : null}
                </>
              ) : null}
              {outboxContent}
            </section>
          ) : null}
        </>
      )}
    </>
  );
  const body = (
    <>
      {agent}
      {crmHistory}
    </>
  );
  const nestedWorkspaceHeading = Boolean(
    agent && bound.role && ["contacts", "shortlist"].includes(browse.view),
  );
  return (
    <div
      className={
        nestedWorkspaceHeading
          ? "hire-standard-view hire-standard-view-native"
          : "hire-standard-view"
      }
    >
      {!nestedWorkspaceHeading ? (
        <header className="hire-section-header">
          <h1>
            {bound.title ??
              (bound.done
                ? (page?.selectedRole?.roleLabel ??
                  (read?.key === key && !read.loading ? t`Contacts` : null))
                : null)}
          </h1>
          {page?.selectedRole ? <p>{page.selectedRole.clientLabel}</p> : null}
        </header>
      ) : null}
      {agent && !bound.done ? (
        <TabLoading />
      ) : bound.role && !["sequence", "interview"].includes(browse.view) ? (
        agent
      ) : ["sequence", "inbox", "interview"].includes(browse.view) ? (
        <>
          <CorrespondenceTabMount
            threadId={threadId}
            onReviewSchedulingPlan={onReviewSchedulingPlan}
            view={browse.view}
            role={boundRole}
            loading={!bound.done}
            conversation={target}
            refreshSignal={refreshSignal + refresh}
            onDraftReply={
              browse.onDraftReply
                ? ({ email, ...context }) =>
                    browse.onDraftReply?.({
                      ...context,
                      threadId,
                      email: {
                        sender: email.sender,
                        recipients: email.recipients,
                        subject: email.subject,
                        date: email.date,
                      },
                    })
                : undefined
            }
            fallback={agent ? crmHistory : body}
          />
          {browse.view === "sequence" && agent ? (
            <details className="mt-6">
              <summary>
                <Trans>Outreach drafts</Trans>
              </summary>
              {agent}
            </details>
          ) : null}
        </>
      ) : (
        body
      )}
    </div>
  );
}

function CorrespondenceTabMount({
  threadId,
  onReviewSchedulingPlan,
  view,
  role,
  conversation,
  refreshSignal,
  onDraftReply,
  loading,
  fallback,
}: {
  view: RecruitingWorkspaceView;
  threadId?: string;
  onReviewSchedulingPlan?: Props["onReviewSchedulingPlan"];
  role?: Omit<RecruitingTabProps, "conversation" | "refreshSignal">;
  conversation: { groupId: string } | { botId: string };
  refreshSignal: number;
  onDraftReply?: (email: RecruitingInboxEmail) => void;
  /** The role binding is still being read. */
  loading: boolean;
  fallback: ReactNode;
}) {
  if (!role && loading) return <TabLoading />;
  if (!role) return <>{fallback}</>;
  const props = { ...role, conversation, refreshSignal };
  if (view === "sequence") return <SequenceTab {...props} />;
  if (view === "interview")
    return (
      <InterviewTab
        {...props}
        threadId={threadId}
        onReviewSchedulingPlan={onReviewSchedulingPlan}
      />
    );
  return <InboxWithReply {...props} onDraftReply={onDraftReply} />;
}
