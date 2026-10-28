import { useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type {
  Bot,
  Group,
  Me,
  RecruitingCorrespondenceReference,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  attachmentsForThread,
  inferAttachmentMimeType,
  isXlsxFileName,
  userVisibleMessages,
} from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  createRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NavigateFunction, SetURLSearchParams } from "react-router-dom";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { newClientId } from "../../lib/client-id";
import { readFileAsBase64, revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import { retryTransientRead } from "../../lib/read-retry";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import {
  clearRecruitingReads,
  fetchRecruitingRead,
  rememberRecruitingRead,
  savedRecruitingRead,
} from "../../lib/recruiting-read-cache";
import type { Panel, RecruitingPanelState } from "../../lib/right-panel-state";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { RecruitingSequenceSaveInput } from "../RecruitingCorrespondence";
import type {
  CandidateDiscussionContext,
  CandidateFeedback,
  CrmBrowseSelection,
  CrmReplyDraftContext,
} from "../RecruitingPanel";
import { useRecruitingDetailController } from "../recruiting/detail";
import type { ComposerHandle, PendingAttachment } from "../shell/Composer";
import { candidateReferenceText } from "../shell/Composer";
import type { RecruitingWorkspaceView } from "../shell/RecruitingNavigation";
import type { RecruitingChatContact } from "../shell/recruiting-chat-context";
import { recruitingChatContext } from "../shell/recruiting-chat-context";

export function useShellRecruiting({
  inGroup,
  snapshot,
  groupId,
  active,
  threadSnapshotCache,
  searchParams,
  showToolActivity,
  panel,
  groups,
  activeGroup,
  userId,
  bootstrapMe,
  recruitingRefresh,
  recruitingReadCache,
  botsRefreshUser,
  activeGroupId,
  roleChatOpen,
  roleChatSection,
  setSearchParams,
  setMobileSidebarOpen,
  setPanel,
  recruitingTab,
  setRecruitingTab,
  sendMessage,
  setRoleChatOpen,
  snapshotRef,
  setSendError,
  activeBotId,
  sendingRef,
  validatedThreadEpoch,
  historyEpoch,
  setSending,
  canCreateRoleFrom,
  setGroups,
  navigate,
  refreshBots,
  initialBotsLoaded,
  sending,
  pendingAttachments,
  setPendingAttachments,
  booting,
  bots,
  refreshGroupThread,
  refreshThread,
}: {
  inGroup: boolean;
  snapshot: ThreadSnapshot | null;
  groupId: string | undefined;
  active: Bot | undefined;
  threadSnapshotCache: RefObject<Map<string, ThreadSnapshot>>;
  searchParams: URLSearchParams;
  showToolActivity: boolean;
  panel: Panel;
  groups: Group[];
  activeGroup: Group | undefined;
  userId: string | undefined;
  bootstrapMe: Me | null | undefined;
  recruitingRefresh: number;
  recruitingReadCache: RefObject<RecruitingReadCache>;
  botsRefreshUser: RefObject<{ id: string | undefined }>;
  activeGroupId: RefObject<string | undefined>;
  roleChatOpen: boolean;
  roleChatSection: RefObject<HTMLElement | null>;
  setSearchParams: SetURLSearchParams;
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setPanel: (next: Panel | ((current: Panel) => Panel)) => void;
  recruitingTab: { threadId: string; tab: RecruitingPanelState["tab"] } | null;
  setRecruitingTab: Dispatch<
    SetStateAction<{ threadId: string; tab: RecruitingPanelState["tab"] } | null>
  >;
  sendMessage: (text: string, mentions: ComposerMention[], clientNonce: string) => Promise<boolean>;
  setRoleChatOpen: Dispatch<SetStateAction<boolean>>;
  snapshotRef: RefObject<ThreadSnapshot | null>;
  setSendError: Dispatch<SetStateAction<string | null>>;
  activeBotId: RefObject<string | undefined>;
  sendingRef: RefObject<boolean>;
  validatedThreadEpoch: RefObject<number | null>;
  historyEpoch: RefObject<number>;
  setSending: Dispatch<SetStateAction<boolean>>;
  canCreateRoleFrom: (id: string) => boolean;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  navigate: NavigateFunction;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  initialBotsLoaded: boolean;
  sending: boolean;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  booting: boolean;
  bots: Bot[];
  refreshGroupThread: (id: string) => Promise<ThreadSnapshot>;
  refreshThread: (id: string) => Promise<ThreadSnapshot>;
}) {
  const { t } = useLingui();
  const activeSnapshot =
    (inGroup
      ? snapshot?.groupId === groupId
        ? snapshot
        : null
      : snapshot?.botId === active?.id
        ? snapshot
        : null) ??
    threadSnapshotCache.current.get(inGroup ? `group:${groupId}` : `bot:${active?.id}`) ??
    null;
  const workspaceViews: readonly RecruitingWorkspaceView[] = [
    "home",
    "conversation",
    "results",
    "brief",
    "feedback",
    "shortlist",
    "contacts",
    "sequence",
    "inbox",
    "interview",
    "workflow",
  ];
  const requestedWorkspaceView = searchParams.get("view") as RecruitingWorkspaceView | null;
  const recruitingWorkspaceView: RecruitingWorkspaceView =
    requestedWorkspaceView && workspaceViews.includes(requestedWorkspaceView)
      ? requestedWorkspaceView
      : inGroup
        ? "results"
        : "conversation";
  const workspaceNewRole = !showToolActivity && panel === "create-group";
  const crmMode = !showToolActivity && !workspaceNewRole && searchParams.has("crmServer");
  const homeView =
    !showToolActivity &&
    !workspaceNewRole &&
    !crmMode &&
    recruitingWorkspaceView === "home" &&
    groups.length > 0;
  const crmRevision = Number(searchParams.get("crmRevision"));
  const crmSelection: CrmBrowseSelection | undefined =
    crmMode &&
    searchParams.get("crmServer") &&
    searchParams.get("crmOrganization") &&
    Number.isSafeInteger(crmRevision) &&
    crmRevision > 0
      ? {
          serverId: searchParams.get("crmServer")!,
          serverRevision: crmRevision,
          organizationId: searchParams.get("crmOrganization")!,
          ...(searchParams.get("crmRole") ? { crmRoleId: searchParams.get("crmRole")! } : {}),
        }
      : undefined;
  // The authorized navigation already names the thread, so role reads need not wait for threads.get.
  const knownThreadId =
    activeSnapshot?.threadId ?? (inGroup ? activeGroup?.threadId : active?.threadId);
  const knownThreadIdRef = useRef(knownThreadId);
  knownThreadIdRef.current = knownThreadId;
  const recruitingCacheScope =
    userId && bootstrapMe?.spaceId && knownThreadId
      ? JSON.stringify([userId, bootstrapMe.spaceId, knownThreadId])
      : undefined;
  const boundRoleView =
    !showToolActivity &&
    !crmMode &&
    !workspaceNewRole &&
    inGroup &&
    recruitingWorkspaceView !== "conversation";
  const bindingReadKey = JSON.stringify([recruitingCacheScope, recruitingRefresh]);
  const [bindingRead, setBindingRead] = useState<{
    key: string;
    scope: string;
    workspace?: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!boundRoleView || !recruitingCacheScope || !knownThreadId) {
      setBindingRead(undefined);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    const cache = recruitingReadCache.current;
    const epoch = cache.epoch;
    const threadId = knownThreadId;
    const isCurrent = () =>
      !cancelled &&
      botsRefreshUser.current.id === userId &&
      (selectedSpaceId() ?? bootstrapMe?.spaceId) === bootstrapMe?.spaceId &&
      knownThreadIdRef.current === threadId &&
      activeGroupId.current === groupId;
    const cached = savedRecruitingRead(cache, `${recruitingCacheScope}:workspace`) as
      | { workspace?: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>> }
      | undefined;
    setBindingRead({
      key: bindingReadKey,
      scope: recruitingCacheScope,
      workspace: cached?.workspace,
    });
    void fetchRecruitingRead(cache, recruitingCacheScope, "getWorkspace", { threadId }, () =>
      retryTransientRead(() => rpc.recruiting.getWorkspace({ threadId }), abort.signal),
    )
      .then((workspace) => {
        if (!isCurrent()) return;
        // A read invalidated in flight is not trusted, but must not leave the view loading.
        if (epoch !== cache.epoch)
          return setBindingRead({ key: bindingReadKey, scope: recruitingCacheScope, failed: true });
        rememberRecruitingRead(cache, `${recruitingCacheScope}:workspace`, { workspace }, epoch);
        setBindingRead({ key: bindingReadKey, scope: recruitingCacheScope, workspace });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        // An outage keeps sibling reads; only a denial drops this conversation's saved reads.
        if (
          error instanceof ORPCError &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
        )
          clearRecruitingReads(cache, recruitingCacheScope);
        // A conversation without a recruiting role has no CRM binding; that is not a failure.
        if (error instanceof ORPCError && error.code === "NOT_FOUND")
          return setBindingRead({
            key: bindingReadKey,
            scope: recruitingCacheScope,
            workspace: null,
          });
        setBindingRead({ key: bindingReadKey, scope: recruitingCacheScope, failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
      const queryKey = ["recruiting", `${recruitingCacheScope}:rpc`, "getWorkspace", { threadId }];
      void cache.client.cancelQueries({ queryKey, exact: true });
      cache.client.removeQueries({ queryKey, exact: true });
    };
  }, [
    boundRoleView,
    recruitingCacheScope,
    bindingReadKey,
    knownThreadId,
    userId,
    bootstrapMe?.spaceId,
    groupId,
  ]);
  // Until a refresh's effect runs, keep this conversation's binding so the workbench is not remounted.
  const currentBindingRead =
    bindingRead?.key === bindingReadKey
      ? bindingRead
      : bindingRead?.workspace && bindingRead.scope === recruitingCacheScope
        ? { key: bindingReadKey, scope: bindingRead.scope, workspace: bindingRead.workspace }
        : undefined;
  const currentWorkspaceRead = useMemo(
    () =>
      boundRoleView && knownThreadId
        ? {
            threadId: knownThreadId,
            refreshSignal: recruitingRefresh,
            workspace: bindingRead?.key === bindingReadKey ? bindingRead.workspace : undefined,
          }
        : undefined,
    [boundRoleView, knownThreadId, recruitingRefresh, bindingRead, bindingReadKey],
  );
  const boundCrmTarget = currentBindingRead?.workspace?.crmTarget;
  const boundCrmSelection: CrmBrowseSelection | undefined = boundCrmTarget
    ? {
        serverId: boundCrmTarget.target.mcpServerId,
        serverRevision: boundCrmTarget.target.serverRevision,
        organizationId: boundCrmTarget.target.organizationId,
        crmRoleId: boundCrmTarget.target.crmRoleId,
      }
    : undefined;
  const groupCrmReference = activeGroup?.crmRoleReference;
  const groupCrmSelection: CrmBrowseSelection | undefined = groupCrmReference
    ? {
        serverId: groupCrmReference.sourceId,
        serverRevision: groupCrmReference.serverRevision,
        organizationId: groupCrmReference.organizationId,
        crmRoleId: groupCrmReference.crmRoleId,
      }
    : undefined;
  const matchesCrmRole = (
    left: CrmBrowseSelection | undefined,
    right: CrmBrowseSelection | undefined,
  ) =>
    Boolean(
      left &&
        right &&
        left.serverId === right.serverId &&
        left.organizationId === right.organizationId &&
        left.crmRoleId === right.crmRoleId,
    );
  const emptyCrmChat =
    crmMode &&
    !matchesCrmRole(crmSelection, groupCrmSelection) &&
    !matchesCrmRole(crmSelection, boundCrmSelection);
  const composerDraftKey = emptyCrmChat
    ? `crm-role:${JSON.stringify([userId, bootstrapMe?.spaceId, crmSelection])}`
    : inGroup
      ? `group:${groupId}`
      : `bot:${active?.id}`;
  const crmComposerScope = JSON.stringify([
    userId,
    bootstrapMe?.spaceId,
    groupId,
    composerDraftKey,
  ]);
  const currentCrmComposerScope = useRef(crmComposerScope);
  currentCrmComposerScope.current = crmComposerScope;
  // A failed binding read keeps the role's own results on screen with a retry for its CRM part.
  const boundRoleCrmMode =
    boundRoleView &&
    !currentBindingRead?.failed &&
    (!currentBindingRead ||
      currentBindingRead.workspace === undefined ||
      Boolean(boundCrmSelection || groupCrmSelection));
  const effectiveCrmSelection = crmMode
    ? crmSelection
    : (boundCrmSelection ??
      (currentBindingRead &&
      !currentBindingRead.failed &&
      currentBindingRead.workspace !== undefined
        ? groupCrmSelection
        : undefined));
  const workspaceCandidates =
    !showToolActivity &&
    !crmMode &&
    !boundRoleCrmMode &&
    !workspaceNewRole &&
    ["results", "shortlist", "contacts", "workflow"].includes(recruitingWorkspaceView);
  const workspaceCorrespondence =
    !showToolActivity &&
    !crmMode &&
    !boundRoleCrmMode &&
    !workspaceNewRole &&
    ["sequence", "inbox", "interview"].includes(recruitingWorkspaceView);
  const workspaceFull =
    crmMode ||
    boundRoleCrmMode ||
    workspaceNewRole ||
    workspaceCandidates ||
    workspaceCorrespondence;
  const roleChatWorkspace = workspaceFull && !workspaceNewRole && Boolean(activeSnapshot?.threadId);
  // Hidden and inert together: a closed role chat's composer must not be reachable or typed into.
  const roleChatHidden = workspaceFull && !(roleChatWorkspace && roleChatOpen);
  useEffect(() => {
    if (roleChatWorkspace && roleChatOpen)
      roleChatSection.current
        ?.querySelector<HTMLTextAreaElement>('textarea[name="chat-message"]')
        ?.focus();
  }, [roleChatWorkspace, roleChatOpen, activeSnapshot?.threadId]);
  const workspaceBrief =
    !showToolActivity &&
    !crmMode &&
    !boundRoleCrmMode &&
    !workspaceNewRole &&
    ["brief", "feedback"].includes(recruitingWorkspaceView);
  function openRecruitingView(view: RecruitingWorkspaceView) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("view", view);
        return next;
      },
      { replace: true },
    );
    setMobileSidebarOpen(false);
    setPanel(null);
  }
  const activeRecruitingTab =
    recruitingTab?.threadId === activeSnapshot?.threadId ? recruitingTab?.tab : undefined;
  const changeRecruitingTab = useCallback(
    (tab: RecruitingPanelState["tab"]) => {
      const threadId = activeSnapshot?.threadId;
      if (!threadId) return;
      setRecruitingTab((current) =>
        current?.threadId === threadId && current.tab === tab ? current : { threadId, tab },
      );
    },
    [activeSnapshot?.threadId],
  );
  const composerRef = useMemo(
    () => createRef<ComposerHandle>(),
    [userId, bootstrapMe?.spaceId, composerDraftKey, activeSnapshot?.threadId],
  );
  const correspondenceScope = useMemo(
    () => ({}),
    [
      composerRef,
      recruitingWorkspaceView,
      recruitingRefresh,
      workspaceNewRole,
      boundRoleCrmMode,
      boundCrmTarget?.bindingEffectId,
      searchParams.get("crmCandidate"),
    ],
  );
  const currentCorrespondenceScope = useRef(correspondenceScope);
  currentCorrespondenceScope.current = correspondenceScope;
  const [selectedSchedulingPlan, setSelectedSchedulingPlan] = useState<{
    scope: string | undefined;
    threadId: string;
    emailId: string;
    id: string;
  } | null>(null);
  const [selectedCorrespondence, setSelectedCorrespondence] = useState<{
    scope: typeof correspondenceScope;
    reference: RecruitingCorrespondenceReference;
  } | null>(null);
  const selectCorrespondence = useCallback(
    (reference: RecruitingCorrespondenceReference | undefined) => {
      if (
        currentCorrespondenceScope.current !== correspondenceScope ||
        !discussionScope.current.active
      )
        return;
      setSelectedSchedulingPlan((current) =>
        current &&
        reference &&
        current.threadId === reference.threadId &&
        current.emailId === reference.emailId
          ? current
          : null,
      );
      setSelectedCorrespondence(
        reference && recruitingWorkspaceView === "inbox" && !workspaceNewRole
          ? { scope: correspondenceScope, reference }
          : null,
      );
    },
    [correspondenceScope, recruitingWorkspaceView, workspaceNewRole],
  );
  const currentRecruitingCacheScope = useRef(recruitingCacheScope);
  currentRecruitingCacheScope.current = recruitingCacheScope;
  const [selectedContact, setSelectedContact] = useState<{
    scope: string | undefined;
    contact: RecruitingChatContact;
  } | null>(null);
  const chatContextApi = useMemo(
    () => ({
      setSelectedContact: (contact: RecruitingChatContact | null) =>
        setSelectedContact(
          contact ? { scope: currentRecruitingCacheScope.current, contact } : null,
        ),
      setSelectedEmail: selectCorrespondence,
    }),
    [selectCorrespondence],
  );
  const recruitingDetail = useRecruitingDetailController(activeSnapshot?.threadId);
  // The candidate whose email the workbench (Inbox tab or detail panel) has selected.
  const selectedReplyCandidate = useRef<string>(undefined);
  selectedReplyCandidate.current =
    selectedContact && selectedContact.scope === recruitingCacheScope
      ? selectedContact.contact.reference
      : undefined;
  const chatRoleTitle =
    !showToolActivity && inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : undefined;
  // A message sent while the role chat is closed opens it, so the send and its reply are seen.
  const sendFromComposer: typeof sendMessage = (...args) => {
    if (roleChatWorkspace && !roleChatOpen) setRoleChatOpen(true);
    return (emptyCrmChat ? sendCrmRoleMessage : sendMessage)(...args);
  };
  function openRoleChat(text?: string) {
    if (text) composerRef.current?.insertContext({ draftKey: composerDraftKey, text });
    if (roleChatWorkspace) setRoleChatOpen(true);
    else openRecruitingView("conversation");
  }
  const candidateFeedbackRecipients = inGroup
    ? (activeSnapshot?.members ?? activeGroup?.members ?? [])
        .filter((_member, index) => showToolActivity || index === 0)
        .map((member) => ({
          id: member.botId,
          name: member.name,
        }))
    : undefined;
  const discussionScope = useRef({
    composerRef,
    panel,
    workspaceCandidates,
    active: true,
    candidateFeedbackRecipients,
  });
  discussionScope.current.composerRef = composerRef;
  discussionScope.current.panel = panel;
  discussionScope.current.workspaceCandidates = workspaceCandidates;
  discussionScope.current.candidateFeedbackRecipients = candidateFeedbackRecipients;
  useLayoutEffect(() => {
    discussionScope.current.active = true;
    return () => {
      discussionScope.current.active = false;
    };
  }, []);
  async function draftCrmReply(draft: CrmReplyDraftContext) {
    const role = currentBindingRead?.workspace;
    const bound = boundCrmTarget;
    const isCurrent = () =>
      Boolean(
        userId &&
          bootstrapMe?.spaceId &&
          boundRoleCrmMode &&
          !crmMode &&
          inGroup &&
          role &&
          bound &&
          discussionScope.current.active &&
          discussionScope.current.composerRef === composerRef &&
          currentCorrespondenceScope.current === correspondenceScope &&
          botsRefreshUser.current.id === userId &&
          (selectedSpaceId() ?? bootstrapMe.spaceId) === bootstrapMe.spaceId &&
          activeGroupId.current === groupId &&
          snapshotRef.current?.threadId === draft.threadId &&
          draft.threadId === activeSnapshot?.threadId &&
          ((recruitingWorkspaceView === "inbox" &&
            draft.candidateId === searchParams.get("crmCandidate")) ||
            draft.candidateId === selectedReplyCandidate.current) &&
          draft.source.serverId === bound.target.mcpServerId &&
          draft.source.serverRevision === bound.target.serverRevision &&
          draft.source.organizationId === bound.target.organizationId &&
          draft.crmRoleId === bound.target.crmRoleId,
      );
    if (!isCurrent() || !role || !bound) return;
    try {
      const workspace = await rpc.recruiting.getWorkspace({ threadId: draft.threadId });
      if (!isCurrent()) return;
      const target = workspace?.crmTarget?.target;
      if (
        workspace?.role.id !== role.role.id ||
        workspace.revision.id !== role.revision.id ||
        workspace.crmTarget?.bindingEffectId !== bound.bindingEffectId ||
        target?.mcpServerId !== bound.target.mcpServerId ||
        target.serverRevision !== bound.target.serverRevision ||
        target.organizationId !== bound.target.organizationId ||
        target.crmRoleId !== bound.target.crmRoleId ||
        target.crmClientId !== bound.target.crmClientId ||
        target.clientLabel !== bound.target.clientLabel ||
        target.roleLabel !== bound.target.roleLabel
      )
        throw new Error(t`This role changed. Select the candidate again.`);
      const reference = [
        t`Role: ${workspace.role.title}`,
        ...(draft.candidateName ? [t`Name: ${draft.candidateName}`] : []),
        ...(draft.candidateEmail ? [t`Email: ${draft.candidateEmail}`] : []),
        ...(draft.email.sender ? [t`Original sender: ${draft.email.sender}`] : []),
        ...(draft.email.recipients.length
          ? [t`Original recipients: ${draft.email.recipients.join(", ")}`]
          : []),
        ...(draft.email.subject ? [t`Subject: ${draft.email.subject}`] : []),
        ...(draft.email.date ? [t`Date: ${draft.email.date}`] : []),
      ].join("\n");
      openRoleChat(
        `${t`Reply to the selected email`}\n${reference.replace(/(^|\r\n|[\r\n\u2028\u2029])/g, "$1> ")}\n\n${t`Read this person's original email and complete conversation using the saved records and mailbox. Verify the person and current role, then prepare a reply here for me to edit. Only draft it; do not send.`}`,
      );
    } catch (error) {
      if (isCurrent()) setSendError(errorText(error, t`Failed to load recruiting data`));
    }
  }
  function candidateScopeCurrent(candidate: CandidateDiscussionContext) {
    return Boolean(
      userId &&
        bootstrapMe?.spaceId &&
        discussionScope.current.active &&
        discussionScope.current.composerRef === composerRef &&
        (discussionScope.current.panel === "recruiting" ||
          discussionScope.current.workspaceCandidates) &&
        (selectedSpaceId() ?? bootstrapMe.spaceId) === bootstrapMe.spaceId &&
        candidate.threadId === activeSnapshot?.threadId &&
        (inGroup ? activeGroupId.current === groupId : activeBotId.current === active?.id),
    );
  }
  const candidateRequests = useRef(new Map<string, string>());
  async function discussCandidate(candidate: CandidateDiscussionContext) {
    if (!candidateScopeCurrent(candidate)) return;
    const text =
      candidate.intent === "email_draft"
        ? `${candidateReferenceText(candidate)}${t`Prepare a personalized first email and follow-ups for this person using our saved evidence and playbook. Keep unknown facts marked, do not invent an email address, and save the drafts here without sending.`}`
        : candidate.intent === "contact_lookup"
          ? `${candidateReferenceText(candidate)}${t`Find this person's work email from saved evidence or available connected services. If a connection is missing, explain what needs connecting. Save the returned source and provider status, do not invent contact details, and do not send a message.`}`
          : candidateReferenceText(candidate);
    if (!candidate.intent) {
      composerRef.current?.insertContext({ draftKey: composerDraftKey, text });
      if (!showToolActivity) openRoleChat();
      return;
    }
    if (
      sendingRef.current ||
      !candidate.roleId ||
      !candidate.roleRevisionId ||
      !candidate.candidateKey ||
      validatedThreadEpoch.current !== historyEpoch.current
    )
      return;
    const key = JSON.stringify([
      userId,
      bootstrapMe?.spaceId,
      composerDraftKey,
      candidate.threadId,
      candidate.roleId,
      candidate.roleRevisionId,
      candidate.candidateKey,
      candidate.intent,
      text,
    ]);
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    if (!showToolActivity) openRoleChat();
    try {
      const workspace = await rpc.recruiting.getWorkspace({ threadId: candidate.threadId });
      if (!candidateScopeCurrent(candidate)) return;
      if (
        workspace?.role.id !== candidate.roleId ||
        workspace?.revision.id !== candidate.roleRevisionId
      )
        throw new Error(t`This role changed. Select the candidate again.`);
      const clientNonce = candidateRequests.current.get(key) ?? newClientId();
      candidateRequests.current.set(key, clientNonce);
      await rpc.threads.followUp({
        ...(inGroup ? { groupId: groupId! } : { botId: active!.id }),
        text,
        clientNonce,
      });
      if (candidateRequests.current.get(key) === clientNonce) candidateRequests.current.delete(key);
      if (candidateScopeCurrent(candidate)) {
        if (inGroup) void refreshGroupThread(groupId!).catch(() => undefined);
        else void refreshThread(active!.id).catch(() => undefined);
      }
    } catch (error) {
      if (candidateScopeCurrent(candidate))
        setSendError(errorText(error, t`Failed to send message`));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  async function feedbackCandidate(
    candidate: CandidateDiscussionContext,
    feedback: CandidateFeedback,
    clientNonce: string,
  ): Promise<boolean> {
    if (!candidateScopeCurrent(candidate)) return false;
    if (
      !candidate.roleId ||
      !candidate.roleRevisionId ||
      !candidate.roleVersion ||
      !candidate.candidateKey
    )
      return false;
    const decision =
      feedback.choice === "hold" || feedback.choice === "pass" || feedback.choice === "resume";
    if (
      decision &&
      (candidate.candidateRevision === undefined ||
        !Number.isSafeInteger(candidate.candidateRevision) ||
        candidate.candidateRevision < 0)
    )
      return false;
    if (feedback.recipientBotId && !inGroup) return false;
    if (
      inGroup &&
      !discussionScope.current.candidateFeedbackRecipients?.some(
        (member) => member.id === feedback.recipientBotId,
      )
    )
      return false;
    const choice = {
      good_example: t`Good example`,
      not_fit: t`Not a fit`,
      skip: t`Skip for now`,
      hold: t`Pause consideration`,
      pass: t`Stop considering`,
      resume: t`Resume consideration`,
    }[feedback.choice];
    const text = `${candidateReferenceText(candidate)}${t`Candidate feedback`}: ${choice}\n\n${feedback.reason}`;
    const receipt = await rpc.threads.followUp({
      ...(inGroup
        ? { groupId: groupId!, mentions: [feedback.recipientBotId!] }
        : { botId: active!.id }),
      text,
      recruitingFeedback: {
        roleId: candidate.roleId,
        roleRevisionId: candidate.roleRevisionId,
        expectedRoleRevision: candidate.roleVersion,
        candidateKeys: [candidate.candidateKey],
        ...(decision
          ? {
              candidateRevisions: [
                {
                  candidateKey: candidate.candidateKey,
                  expectedRevision: candidate.candidateRevision!,
                },
              ],
            }
          : {}),
        choice: feedback.choice,
      },
      clientNonce,
    });
    if (candidateScopeCurrent(candidate)) {
      if (inGroup) void refreshGroupThread(groupId!).catch(() => undefined);
      else void refreshThread(active!.id).catch(() => undefined);
    }
    return receipt.ok;
  }
  /** The recruiter's own text into the role conversation; the coordinator routes it. */
  async function sendRoleText(text: string): Promise<boolean> {
    if (!inGroup && !active) return false;
    const receipt = await rpc.threads.followUp({
      ...(inGroup ? { groupId: groupId! } : { botId: active!.id }),
      text,
      clientNonce: crypto.randomUUID(),
    });
    if (inGroup) void refreshGroupThread(groupId!).catch(() => undefined);
    else void refreshThread(active!.id).catch(() => undefined);
    return receipt.ok;
  }

  const managedConnectionBots =
    !booting &&
    bootstrapMe?.userId === userId &&
    (selectedSpaceId() ?? bootstrapMe?.spaceId) === bootstrapMe?.spaceId
      ? bots.filter((bot) => !bot.archivedAt && bot.spaceId === bootstrapMe?.spaceId)
      : [];
  const managedConnectionMain = managedConnectionBots.find(
    (bot) => bot.spawnKey === `recruiting:${userId}:main`,
  );
  const connectionMemberIds = workspaceNewRole
    ? managedConnectionMain
      ? ["main", "outreach", "scheduling"].flatMap((key) => {
          const bot = managedConnectionBots.find(
            (bot) => bot.spawnKey === `recruiting:${userId}:${key}`,
          );
          return bot ? [bot.id] : [];
        })
      : []
    : validatedThreadEpoch.current === historyEpoch.current &&
        (inGroup
          ? snapshotRef.current?.groupId === groupId
          : snapshotRef.current?.botId === active?.id)
      ? inGroup
        ? (snapshotRef.current?.members ?? []).map((member) => member.botId)
        : active
          ? [active.id]
          : []
      : [];
  const recruitingConnectionBot = (key: "outreach" | "scheduling") =>
    managedConnectionBots.find(
      (bot) =>
        connectionMemberIds.includes(bot.id) && bot.spawnKey === `recruiting:${userId}:${key}`,
    )?.id;

  const transcriptMessages = useMemo(
    () =>
      userVisibleMessages(activeSnapshot?.messages ?? [], {
        includePeerReceipts: showToolActivity,
      }),
    [activeSnapshot?.messages, showToolActivity],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const sequenceScopeKey = JSON.stringify([
    userId,
    bootstrapMe?.spaceId,
    activeSnapshot?.threadId,
    transcriptArtifactTarget,
    workspaceCorrespondence,
  ]);
  const sequenceScope = useRef(sequenceScopeKey);
  sequenceScope.current = sequenceScopeKey;
  async function saveSequenceDraft(input: RecruitingSequenceSaveInput) {
    const scopeCurrent = () =>
      discussionScope.current.active &&
      sequenceScope.current === sequenceScopeKey &&
      (selectedSpaceId() ?? bootstrapMe?.spaceId) === bootstrapMe?.spaceId;
    if (!userId || !bootstrapMe?.spaceId || !activeSnapshot?.threadId || !scopeCurrent())
      throw new Error(t`Return to the original role before saving this draft.`);
    const recipient = activeSnapshot.members?.[0] ?? activeGroup?.members?.[0];
    if (inGroup && !recipient)
      throw new Error(t`Wait for this role to finish loading before saving.`);
    const source = transcriptMessages
      .flatMap((message) => message.blocks)
      .find((block) => block.kind === "file" && block.artifactId === input.sourceArtifactId);
    if (source?.kind !== "file" || source.mimeType !== "application/json")
      throw new Error(t`Open the saved sequence before editing it.`);
    const { RecruitingOutreachSequenceSchema } = await import("./shell-action-validation");
    const sequence = RecruitingOutreachSequenceSchema.parse({
      ...input.sequence,
      revisesArtifactId: input.sourceArtifactId,
    });
    const contentBase64 = await readFileAsBase64(
      new File([JSON.stringify(sequence, null, 2)], source.name, { type: "application/json" }),
    );
    if (!scopeCurrent()) throw new Error(t`Return to the original role before saving this draft.`);
    const artifact = await rpc.artifacts.create({
      ...transcriptArtifactTarget,
      name: source.name,
      mimeType: "application/json",
      contentBase64,
      clientNonce: input.clientNonce,
    });
    if (!scopeCurrent())
      throw new Error(
        t`The file was saved. Return to the original role and retry to share it there.`,
      );
    await rpc.threads.followUp({
      ...transcriptArtifactTarget,
      ...(inGroup ? { mentions: [recipient!.botId] } : {}),
      artifactIds: [artifact.id],
      clientNonce: input.clientNonce,
      text: t`I edited the attached email sequence. Keep this as the current unsent draft for this role. Do not send or enroll anyone.`,
    });
    if (scopeCurrent()) {
      if (inGroup) void refreshGroupThread(groupId!).catch(() => undefined);
      else void refreshThread(active!.id).catch(() => undefined);
    }
  }

  const [openingCrmRole, setOpeningCrmRole] = useState<{
    selection: CrmBrowseSelection;
    view: RecruitingWorkspaceView;
    error?: string;
  } | null>(null);
  const crmRoleOpenRequest = useRef(0);
  const crmOpenLocation = JSON.stringify([groupId, active?.id, searchParams.toString()]);
  const currentCrmOpenLocation = useRef(crmOpenLocation);
  currentCrmOpenLocation.current = crmOpenLocation;
  function crmRoleBotIds() {
    return activeGroup && canCreateRoleFrom(activeGroup.id)
      ? activeGroup.members.map((member) => member.botId)
      : ["main", "outreach", "scheduling"].flatMap((key) => {
          const bot = managedConnectionBots.find(
            (bot) => bot.spawnKey === `recruiting:${userId}:${key}`,
          );
          return bot ? [bot.id] : [];
        });
  }
  async function openCrmRole(
    selection: CrmBrowseSelection,
    view: RecruitingWorkspaceView = "results",
  ) {
    const crmRoleId = selection.crmRoleId;
    if (!crmRoleId) return;
    const request = ++crmRoleOpenRequest.current;
    const submittedScope = crmComposerScope;
    const submittedUser = botsRefreshUser.current;
    const submittedSpace = bootstrapMe?.spaceId;
    const stillCurrent = () =>
      request === crmRoleOpenRequest.current &&
      currentCrmOpenLocation.current === crmOpenLocation &&
      currentCrmComposerScope.current === submittedScope &&
      botsRefreshUser.current === submittedUser &&
      (selectedSpaceId() ?? submittedSpace) === submittedSpace;
    const createGroup = (botIds: string[]) =>
      rpc.groups.create({
        name: t`Recruiting`,
        botIds,
        crmRoleReference: {
          sourceId: selection.serverId,
          serverRevision: selection.serverRevision,
          organizationId: selection.organizationId,
          crmRoleId,
        },
      });
    const remember = (group: Group) =>
      setGroups((current) =>
        current.some((item) => item.id === group.id)
          ? current.map((item) => (item.id === group.id ? group : item))
          : [group, ...current],
      );
    // A role that already has a conversation opens at once; the server refresh follows quietly.
    const opened = groups.find(
      (group) =>
        group.crmRoleReference &&
        matchesCrmRole(selection, {
          serverId: group.crmRoleReference.sourceId,
          serverRevision: group.crmRoleReference.serverRevision,
          organizationId: group.crmRoleReference.organizationId,
          crmRoleId: group.crmRoleReference.crmRoleId,
        }),
    );
    if (opened) {
      enterCrmRole(opened);
      const botIds = crmRoleBotIds();
      if (botIds.length >= GROUP_MEMBER_MIN)
        void createGroup(botIds)
          .then(remember)
          .catch(() => undefined);
      return;
    }
    setOpeningCrmRole({ selection, view });
    try {
      const botIds = crmRoleBotIds();
      if (botIds.length < GROUP_MEMBER_MIN)
        throw new Error(t`The recruiting team is not ready yet.`);
      const group = await createGroup(botIds);
      if (!stillCurrent()) return;
      remember(group);
      enterCrmRole(group);
    } catch (error) {
      if (stillCurrent())
        setOpeningCrmRole({
          selection,
          view,
          error: errorText(error, t`Could not open this role.`),
        });
    } finally {
      if (!stillCurrent() && request === crmRoleOpenRequest.current) setOpeningCrmRole(null);
    }

    function enterCrmRole(group: Group) {
      setSelectedContact(null);
      setSelectedCorrespondence(null);
      setPanel(null);
      setMobileSidebarOpen(false);
      setRoleChatOpen(true);
      setOpeningCrmRole(null);
      const search = new URLSearchParams({ view });
      // Preserve an exact person link while converting an older role URL.
      if (matchesCrmRole(selection, crmSelection) && searchParams.get("crmCandidate"))
        search.set("crmCandidate", searchParams.get("crmCandidate")!);
      navigate(`/app/g/${group.id}?${search}`);
      void refreshBots().catch(() => undefined);
    }
  }
  const legacyCrmOpenKey =
    crmMode && crmSelection?.crmRoleId
      ? JSON.stringify([userId, bootstrapMe?.spaceId, crmSelection])
      : null;
  const openedLegacyCrmKey = useRef<string | null>(null);
  useEffect(() => {
    if (!legacyCrmOpenKey) {
      openedLegacyCrmKey.current = null;
      return;
    }
    if (!initialBotsLoaded || !crmSelection || openedLegacyCrmKey.current === legacyCrmOpenKey)
      return;
    openedLegacyCrmKey.current = legacyCrmOpenKey;
    void openCrmRole(crmSelection, recruitingWorkspaceView);
  }, [legacyCrmOpenKey, initialBotsLoaded]);
  const pendingCrmRoleSends = useRef(
    new Map<
      string,
      {
        group: Awaited<ReturnType<typeof rpc.groups.create>>;
        artifactIds: string[];
      }
    >(),
  );
  async function sendCrmRoleMessage(
    text: string,
    mentions: ComposerMention[],
    clientNonce: string,
  ) {
    if (!crmSelection?.crmRoleId || !emptyCrmChat || sending || mentions.length) return false;
    const submittedScope = crmComposerScope;
    const submittedUser = botsRefreshUser.current;
    const submittedSpace = bootstrapMe?.spaceId;
    const stillCurrent = () =>
      currentCrmComposerScope.current === submittedScope &&
      botsRefreshUser.current === submittedUser &&
      (selectedSpaceId() ?? submittedSpace) === submittedSpace;
    const attachments = attachmentsForThread(pendingAttachments, composerDraftKey);
    if (!text.trim() && !attachments.length) return false;
    const botIds = crmRoleBotIds();
    if (botIds.length < GROUP_MEMBER_MIN) return false;
    const reference = {
      sourceId: crmSelection.serverId,
      serverRevision: crmSelection.serverRevision,
      organizationId: crmSelection.organizationId,
      crmRoleId: crmSelection.crmRoleId,
    };
    const key = JSON.stringify([
      submittedScope,
      clientNonce,
      text,
      attachments.map((item) => item.id),
    ]);
    setSending(true);
    sendingRef.current = true;
    setSendError(null);
    try {
      let attempt = pendingCrmRoleSends.current.get(key);
      if (!attempt) {
        const group = await rpc.groups.create({
          name: t`Recruiting`,
          botIds,
          crmRoleReference: reference,
        });
        attempt = { group, artifactIds: [] };
        pendingCrmRoleSends.current.set(key, attempt);
      }
      if (!stillCurrent()) return false;
      const group = attempt.group;
      setGroups((current) =>
        current.some((item) => item.id === group.id)
          ? current.map((item) => (item.id === group.id ? group : item))
          : [group, ...current],
      );
      for (const pending of attachments.slice(attempt.artifactIds.length)) {
        const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
        if (!mimeType)
          throw new Error(
            isXlsxFileName(pending.file.name)
              ? t`XLSX is not supported yet. Save as CSV and upload again.`
              : t`Unsupported file type: ${pending.file.name}`,
          );
        const contentBase64 = await readFileAsBase64(pending.file);
        if (!stillCurrent()) return false;
        const artifact = await rpc.artifacts.create({
          groupId: group.id,
          name: pending.file.name,
          mimeType,
          contentBase64,
        });
        attempt.artifactIds.push(artifact.id);
      }
      if (!stillCurrent()) return false;
      const recruitingContext = recruitingChatContext(
        group.name,
        selectedContact?.scope === currentRecruitingCacheScope.current
          ? selectedContact?.contact
          : undefined,
      );
      await rpc.threads.followUp({
        groupId: group.id,
        text: text.trim() ? text : t`Read the attached materials for this role.`,
        crmRoleReference: reference,
        ...(recruitingContext ? { recruitingContext } : {}),
        mentions: [group.members[0]!.botId],
        clientNonce,
        ...(attempt.artifactIds.length ? { artifactIds: attempt.artifactIds } : {}),
      });
      pendingCrmRoleSends.current.delete(key);
      revokePendingAttachmentPreviews(attachments);
      setPendingAttachments((current) =>
        current.filter((item) => item.threadKey !== composerDraftKey),
      );
      if (stillCurrent()) {
        navigate(`/app/g/${group.id}?view=${recruitingWorkspaceView}`);
        void refreshBots().catch(() => undefined);
      }
      return true;
    } catch (error) {
      if (stillCurrent()) setSendError(errorText(error, t`Failed to send message`));
      return false;
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }

  return {
    currentWorkspaceRead,
    activeSnapshot,
    recruitingWorkspaceView,
    workspaceNewRole,
    crmMode,
    homeView,
    crmSelection,
    knownThreadId,
    recruitingCacheScope,
    boundRoleView,
    currentBindingRead,
    emptyCrmChat,
    composerDraftKey,
    boundRoleCrmMode,
    effectiveCrmSelection,
    workspaceCandidates,
    workspaceCorrespondence,
    workspaceFull,
    roleChatWorkspace,
    roleChatHidden,
    workspaceBrief,
    openRecruitingView,
    activeRecruitingTab,
    changeRecruitingTab,
    composerRef,
    correspondenceScope,
    currentCorrespondenceScope,
    selectedSchedulingPlan,
    setSelectedSchedulingPlan,
    selectedCorrespondence,
    selectCorrespondence,
    currentRecruitingCacheScope,
    selectedContact,
    chatContextApi,
    recruitingDetail,
    chatRoleTitle,
    sendFromComposer,
    openRoleChat,
    candidateFeedbackRecipients,
    discussionScope,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    sendRoleText,
    connectionMemberIds,
    recruitingConnectionBot,
    transcriptMessages,
    transcriptArtifactTarget,
    saveSequenceDraft,
    openingCrmRole,
    openCrmRole,
  };
}
