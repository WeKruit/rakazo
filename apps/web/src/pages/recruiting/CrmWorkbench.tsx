import { lazyPanel } from "../../components/ErrorBoundary";
import { withFeatureMessages } from "../../lib/i18n";
import type { RecruitingInboxEmail, RecruitingTabProps } from "../recruiting";

const CrmHistory = lazyPanel(() =>
  withFeatureMessages(() => import("./CrmHistory")).then((m) => m.CrmHistory),
);
const SequenceTab = lazyPanel(() =>
  withFeatureMessages(() => import("./SequenceTab")).then((m) => m.SequenceTab),
);
const InterviewTab = lazyPanel(() =>
  withFeatureMessages(() => import("./InterviewTab")).then((m) => m.InterviewTab),
);
const InboxWithReply = lazyPanel(() => import("./InboxTab").then((m) => m.InboxWithReply));

import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type {
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmTarget,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { retryTransientRead } from "../../lib/read-retry";
import {
  clearRecruitingReads,
  fetchRecruitingRead,
  rememberRecruitingRead,
  savedRecruitingRead,
} from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";
import type { RecruitingDetailPerson } from "../recruiting/detail";
import { useRecruitingDetail } from "../recruiting/detail";
import { TabLoading, tabCacheSlot, useKeyedRead } from "../recruiting/shared";
import type { Props, RecruitingWorkspaceRead } from "../recruiting/workspace-types";
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
  workspaceRead?: RecruitingWorkspaceRead,
): { done: boolean; role?: BoundRole; title?: string } {
  const read = useKeyedRead(
    enabled && !workspaceRead ? JSON.stringify([threadId, refreshSignal]) : null,
    async (): Promise<{ role?: BoundRole; title?: string }> => {
      const workspace = await fetchRecruitingRead(
        cache.readCache,
        cache.readCacheScope,
        "getWorkspace",
        { threadId },
        () => rpc.recruiting.getWorkspace({ threadId }),
      );
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
  if (workspaceRead) {
    const workspace = workspaceRead.workspace;
    return {
      done: !enabled || workspace !== undefined,
      title: workspace?.role.title,
      role: workspace?.crmTarget
        ? {
            roleId: workspace.role.id,
            spaceId: workspace.role.spaceId,
            title: workspace.role.title,
            crmTarget: workspace.crmTarget.target,
          }
        : undefined,
    };
  }
  return {
    done: !enabled || Boolean(read.data) || read.failed,
    role: read.data?.role,
    title: read.data?.title,
  };
}

export function useCrmWorkbenchModel({
  workspaceRead,
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
  const bound = useBoundRole(
    threadId,
    Boolean(agent),
    refreshSignal + refresh,
    {
      readCache,
      readCacheScope,
    },
    workspaceRead?.threadId === threadId && workspaceRead.refreshSignal === refreshSignal + refresh
      ? workspaceRead
      : undefined,
  );
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
      data: cacheKey
        ? (savedRecruitingRead(readCache, cacheKey) as CandidatePage | undefined)
        : undefined,
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
      data: savedKey
        ? (savedRecruitingRead(readCache, savedKey) as MailPage | undefined)
        : undefined,
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
      data: savedKey
        ? (savedRecruitingRead(readCache, savedKey) as SectionPage | undefined)
        : undefined,
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
      data: savedKey
        ? (savedRecruitingRead(readCache, savedKey) as DetailsPage | undefined)
        : undefined,
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
  // A cold history chunk may mount after the initial reveal effect has run.
  const onHistoryMounted = useCallback(() => {
    if (!browse.candidateId || !["inbox", "feedback", "sequence"].includes(browse.view)) return;
    if (!contactReady || revealedContact.current === contactKey || !contactRegion.current) return;
    revealContact();
    revealedContact.current = contactKey;
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
  return {
    onHistoryMounted,
    onReviewSchedulingPlan,
    browse,
    agent,
    threadId,
    refreshSignal,
    bound,
    boundRole,
    mailCursor,
    setMailCursor,
    target,
    key,
    page,
    currentMail,
    mailPage,
    nativeMail,
    inboxEmails,
    selectedInboxEmail,
    selectedNativeMail,
    nativeMailStatus,
    draftEmail,
    people,
    selectedPerson,
    importantView,
    workflowLabels,
    importantStatus,
    sectionScope,
    sectionOffset,
    section,
    important,
    campaigns,
    detailsOffset,
    currentDetails,
    details,
    contactRegion,
    contactHeadingId,
    outbox,
    contactRead,
    showDiagnostics,
    selectedRole,
    roleJdUrl,
    initialDescription,
    selectContact,
    queryDraft,
    setQueryDraft,
    setQuery,
    offset,
    setOffset,
    refresh,
    setRefresh,
    setSelectedMail,
    read,
    setStatusSelection,
    setSectionPage,
    setDetailsPage,
  };
}

export function CrmRecruitingPanel(
  props: Props & { browse: NonNullable<Props["crmBrowse"]>; agent?: ReactNode },
) {
  const { t } = useLingui();
  const model = useCrmWorkbenchModel(props);
  const {
    onReviewSchedulingPlan,
    browse,
    agent,
    threadId,
    refreshSignal,
    bound,
    boundRole,
    target,
    key,
    page,
    refresh,
    read,
  } = model;
  const crmHistory = <CrmHistory model={model} />;
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
