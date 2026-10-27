import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { LinkFaviconsContext } from "@rakazo/chat-ui/web-lazy";
import { attachmentsForThread, isActive, threadTailPhase } from "@rakazo/core";
import { BotAvatar, Button, cn, GroupAvatar } from "@rakazo/ui-web";
import {
  BriefcaseBusiness,
  Download,
  Menu,
  Monitor,
  PanelLeftOpen,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { MessageSkeleton } from "../../components/ai/primitives";
import { lazyPanel } from "../../components/ErrorBoundary";
import { PaneResizeHandle } from "../../components/PaneResizeHandle";
import { startCall } from "../../lib/call-session";
import { desktopBridge } from "../../lib/desktop";
import { clampWidth } from "../../lib/pane-width";
import { selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { CalibrationRoundCard } from "../recruiting/CalibrationRound";
import {
  readShortlistWeekFilter,
  writeShortlistWeekFilter,
} from "../recruiting/dashboard-drilldown";
import { RetryNotice } from "../recruiting/RetryNotice";
import { RoleSetupCard } from "../recruiting/RoleSetup";
import type { SchedulingPlanHandoff } from "../recruiting/SchedulingPlan";
import { TabLoading } from "../recruiting/shared";
import { Composer } from "../shell/Composer";
import { Transcript } from "../shell/Transcript";
import type { useShellController } from "../shell/useShellController";
import { WindowChrome } from "../WindowChrome";

const RecruitingPanel = lazyPanel(() =>
  import("../RecruitingPanel").then(
    (module) => (props: ComponentProps<typeof module.RecruitingPanel>) => (
      <module.RecruitingPanel {...props} />
    ),
  ),
);
const InterviewTab = lazyPanel(() =>
  import("../recruiting/InterviewTab").then((module) => module.InterviewTab),
);
const SequenceTab = lazyPanel(() =>
  import("../recruiting/SequenceTab").then((module) => module.SequenceTab),
);

import type { ReactNode } from "react";
export function ShellConversation({
  model,
  roleCreationForm,
  nativeCorrespondence,
  reviewSchedulingPlan,
}: {
  model: ReturnType<typeof useShellController>;
  roleCreationForm: ReactNode;
  nativeCorrespondence: ReactNode;
  reviewSchedulingPlan: (handoff: SchedulingPlanHandoff) => void;
}) {
  const {
    currentWorkspaceRead,
    t,
    linkFavicons,
    groupId,
    navigate,
    searchParams,
    setSearchParams,
    userId,
    enterToSend,
    pendingAttachments,
    setReplyTarget,
    setReplyQuote,
    sending,
    sendError,
    setSendError,
    exportingConversation,
    setExportingConversation,
    attachmentNotice,
    fileInputRef,
    panel,
    recruitingRefresh,
    setRecruitingRefresh,
    roleChatOpen,
    setRoleChatOpen,
    roleChatId,
    roleChatTrigger,
    roleChatSection,
    recruitingReadCache,
    setPanel,
    setPeerConversation,
    agentSkills,
    botsRefreshUser,
    voiceStatus,
    speakingMessageId,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    botsSidebarCollapsed,
    loadingOlder,
    initialBotsLoaded,
    bootstrapMe,
    showToolActivity,
    viewportWidth,
    roleChatWidth,
    setRoleChatWidth,
    roleChatMaxWidth,
    scrollRequest,
    clearScrollRequest,
    messageScroll,
    inGroup,
    active,
    activeGroup,
    archivedRouteGroup,
    activePendingAttachments,
    recordingSkill,
    refreshBots,
    refreshThread,
    refreshAgentSkills,
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
    composerRef,
    correspondenceScope,
    selectedCorrespondence,
    sendFromComposer,
    openRoleChat,
    candidateFeedbackRecipients,
    discussionScope,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    sendRoleText,
    activeReplyTarget,
    activeReplyQuote,
    clearReply,
    currentRuns,
    answerableAskIds,
    workingRuns,
    transcriptRunning,
    composerRunning,
    shownSteer,
    resuming,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    transcriptMessages,
    transcriptArtifactTarget,
    resolveTranscriptBot,
    workingBots,
    resolveTranscriptMemberName,
    replyTargetName,
    composerMentionTargets,
    openBot,
    loadOlder,
    jumpToReplyMessage,
    answerMessage,
    reactToMessage,
    onAttachmentPick,
    removeAttachment,
    openingCrmRole,
    openCrmRole,
    stopRun,
    refreshActiveThread,
    addSkillRoutine,
    speakMessage,
    restoreGroup,
    setBotsSidebarCollapsedPref,
    openSettings,
    onOpenComputer,
    dismissComposerError,
    userName,
  } = model;
  return (
    <main
      aria-hidden={mobileSidebarOpen || undefined}
      inert={mobileSidebarOpen}
      style={
        roleChatWorkspace
          ? ({
              "--hire-role-chat-width": `${clampWidth(roleChatWidth, 320, roleChatMaxWidth)}px`,
            } as CSSProperties)
          : undefined
      }
      className={cn(
        "isolate flex min-w-0 flex-1 flex-col bg-background",
        homeView && "hidden",
        roleChatWorkspace && "hire-role-chat-workspace",
        roleChatWorkspace && roleChatOpen && "hire-role-chat-open",
      )}
    >
      {workspaceFull ? (
        <div
          className={
            botsSidebarCollapsed
              ? "flex items-center px-4 pt-3"
              : "flex items-center px-4 pt-3 md:hidden"
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={botsSidebarCollapsed ? t`Show navigation` : t`Open navigation`}
            onClick={() => {
              setBotsSidebarCollapsedPref(false);
              setMobileSidebarOpen(true);
            }}
          >
            <PanelLeftOpen size={19} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {archivedRouteGroup ? (
        <div
          role="status"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>{archivedRouteGroup.name} is archived.</Trans>
          </p>
          <Button variant="outline" onClick={() => void restoreGroup(archivedRouteGroup.id)}>
            <Trans>Restore</Trans>
          </Button>
        </div>
      ) : workspaceFull &&
        !workspaceNewRole &&
        !activeSnapshot &&
        !(workspaceCandidates && knownThreadId) ? (
        <MessageSkeleton label={t`Loading…`} />
      ) : null}
      {roleChatWorkspace && (inGroup ? groupId : active?.id) ? (
        <RoleSetupCard
          conversation={inGroup ? { groupId: groupId! } : { botId: active!.id }}
          refreshSignal={recruitingRefresh}
          readCache={recruitingReadCache.current}
          readCacheScope={recruitingCacheScope}
        />
      ) : null}
      {openingCrmRole ? (
        <div className="px-6 py-3">
          {openingCrmRole.error ? (
            <RetryNotice
              onRetry={() => void openCrmRole(openingCrmRole.selection, openingCrmRole.view)}
            >
              {openingCrmRole.error}
            </RetryNotice>
          ) : (
            <p role="status">
              <Trans>Opening role…</Trans>
            </p>
          )}
        </div>
      ) : null}
      {workspaceNewRole ? (
        <div className="rk-scroll recruiting-workspace-main min-h-0 flex-1 overflow-y-auto">
          {roleCreationForm}
        </div>
      ) : null}
      {boundRoleView && currentBindingRead?.failed ? (
        <div className="px-6">
          <RetryNotice onRetry={() => setRecruitingRefresh((value) => value + 1)}>
            <Trans>Could not load this role’s candidate records.</Trans>
          </RetryNotice>
        </div>
      ) : boundRoleCrmMode && !effectiveCrmSelection ? (
        <div className="p-6">
          <TabLoading />
        </div>
      ) : null}
      {(crmMode || (boundRoleCrmMode && effectiveCrmSelection)) && activeSnapshot?.threadId ? (
        <div className="rk-scroll recruiting-workspace-main min-h-0 flex-1 overflow-y-auto">
          {effectiveCrmSelection ? (
            <RecruitingPanel
              workspaceRead={currentWorkspaceRead}
              threadId={activeSnapshot.threadId}
              botId={inGroup ? undefined : active?.id}
              groupId={inGroup ? groupId : undefined}
              readCache={recruitingReadCache.current}
              readCacheScope={recruitingCacheScope}
              refreshSignal={recruitingRefresh}
              onClose={() => {}}
              shortlistWeekFilter={
                recruitingWorkspaceView === "contacts"
                  ? readShortlistWeekFilter(searchParams)
                  : undefined
              }
              onClearShortlistWeekFilter={() =>
                setSearchParams((current) => writeShortlistWeekFilter(current))
              }
              onReviewSchedulingPlan={reviewSchedulingPlan}
              roleConversation={!emptyCrmChat}
              correspondence={nativeCorrespondence}
              onBrowseCandidates={() => openRecruitingView("results")}
              onDiscussCandidate={discussCandidate}
              onCandidateFeedback={feedbackCandidate}
              candidateFeedbackRecipients={candidateFeedbackRecipients}
              crmBrowse={{
                selection: effectiveCrmSelection,
                view: recruitingWorkspaceView,
                candidateId: searchParams.get("crmCandidate") ?? undefined,
                onSelectCandidate: (id, view = "inbox") =>
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    next.set("crmCandidate", id);
                    next.set("view", view);
                    return next;
                  }),
                onDraftReply: boundRoleCrmMode && !crmMode ? draftCrmReply : undefined,
              }}
            />
          ) : (
            <p role="alert">
              <Trans>Choose the role again.</Trans>
            </p>
          )}
        </div>
      ) : null}
      {workspaceCorrespondence && activeSnapshot?.threadId ? (
        <div className="rk-scroll recruiting-workspace-main min-h-0 flex-1 overflow-y-auto">
          {currentBindingRead?.workspace && recruitingWorkspaceView !== "inbox" ? (
            <div className="recruiting-workspace-content">
              {recruitingWorkspaceView === "sequence" ? (
                <>
                  <SequenceTab
                    roleId={currentBindingRead.workspace.role.id}
                    spaceId={currentBindingRead.workspace.role.spaceId}
                    conversation={inGroup ? { groupId: groupId! } : { botId: active!.id }}
                    crmTarget={currentBindingRead.workspace.crmTarget?.target ?? null}
                    refreshSignal={recruitingRefresh}
                    readCache={recruitingReadCache.current}
                    readCacheScope={recruitingCacheScope}
                  />
                  <details className="mt-6">
                    <summary>
                      <Trans>Outreach drafts</Trans>
                    </summary>
                    {nativeCorrespondence}
                  </details>
                </>
              ) : (
                <InterviewTab
                  onReviewSchedulingPlan={reviewSchedulingPlan}
                  threadId={knownThreadId}
                  roleId={currentBindingRead.workspace.role.id}
                  spaceId={currentBindingRead.workspace.role.spaceId}
                  conversation={inGroup ? { groupId: groupId! } : { botId: active!.id }}
                  crmTarget={currentBindingRead.workspace.crmTarget?.target ?? null}
                  refreshSignal={recruitingRefresh}
                  readCache={recruitingReadCache.current}
                  readCacheScope={recruitingCacheScope}
                />
              )}
            </div>
          ) : (
            nativeCorrespondence
          )}
        </div>
      ) : null}
      {workspaceCandidates && knownThreadId ? (
        <div className="rk-scroll recruiting-workspace-main min-h-0 flex-1 overflow-y-auto">
          <div className="recruiting-workspace-content">
            {recruitingWorkspaceView === "results" ? (
              <CalibrationRoundCard
                conversation={inGroup ? { groupId: groupId! } : { botId: active!.id }}
                refreshSignal={recruitingRefresh}
                readCache={recruitingReadCache.current}
                readCacheScope={recruitingCacheScope}
                onSend={sendRoleText}
              />
            ) : null}
            <RecruitingPanel
              workspaceRead={currentWorkspaceRead}
              key={`${userId}:${bootstrapMe?.spaceId}:${knownThreadId}:workspace`}
              presentation="workspace"
              view={
                recruitingWorkspaceView === "shortlist"
                  ? "shortlist"
                  : recruitingWorkspaceView === "workflow"
                    ? "results"
                    : "contacts"
              }
              shortlistWeekFilter={
                recruitingWorkspaceView === "contacts"
                  ? readShortlistWeekFilter(searchParams)
                  : undefined
              }
              onClearShortlistWeekFilter={() =>
                setSearchParams((current) => writeShortlistWeekFilter(current))
              }
              threadId={knownThreadId}
              botId={inGroup ? undefined : active?.id}
              groupId={inGroup ? groupId : undefined}
              readCache={recruitingReadCache.current}
              readCacheScope={recruitingCacheScope}
              refreshSignal={recruitingRefresh}
              tab={recruitingWorkspaceView === "workflow" ? "dashboard" : "evidence"}
              showDiagnostics={false}
              onClose={() => openRecruitingView("conversation")}
              onBrowseCandidates={() => openRecruitingView("results")}
              onDiscussCandidate={discussCandidate}
              onCandidateFeedback={feedbackCandidate}
              candidateFeedbackRecipients={candidateFeedbackRecipients}
              onRevealMessage={(target) =>
                navigate({
                  pathname: target.groupId ? `/app/g/${target.groupId}` : `/app/${target.botId}`,
                  search: `?${new URLSearchParams({ view: "conversation", m: target.messageId })}`,
                })
              }
            />
            <div className="flex justify-end py-4">
              <Button variant="outline" onClick={() => openRoleChat()}>
                <Trans>Refine in chat</Trans>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {roleChatWorkspace && !roleChatOpen ? (
        <Button
          ref={roleChatTrigger}
          className="hire-role-chat-trigger absolute bottom-4 end-4 z-20"
          aria-label={t`Open role chat`}
          aria-controls={roleChatId}
          aria-expanded={false}
          onClick={() => openRoleChat()}
        >
          <Sparkles size={17} aria-hidden />
          <Trans>Chat with WeKruit</Trans>
        </Button>
      ) : null}
      <div className={workspaceBrief ? "hire-brief-view rk-scroll" : "contents"}>
        {workspaceBrief ? (
          <div className="hire-brief-top">
            <div>
              <h1>
                {recruitingWorkspaceView === "brief" ? (
                  <Trans>Job Brief</Trans>
                ) : (
                  <Trans>Client feedback</Trans>
                )}
              </h1>
              <p className="hire-brief-role" dir="auto">
                {inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
              </p>
            </div>
            <Button
              variant="outline"
              className="hire-outline-button"
              onClick={() => openRecruitingView("results")}
            >
              <Trans>Back to results</Trans>
            </Button>
          </div>
        ) : null}
        <div className={workspaceBrief ? "hire-brief-grid" : "contents"}>
          <LinkFaviconsContext.Provider
            value={workspaceFull && !(roleChatWorkspace && roleChatOpen) ? null : linkFavicons}
          >
            <section
              ref={roleChatSection}
              id={roleChatId}
              hidden={roleChatHidden}
              inert={roleChatHidden}
              aria-label={t`Role conversation`}
              className={
                roleChatWorkspace
                  ? "hire-role-chat"
                  : workspaceFull
                    ? "hidden"
                    : workspaceBrief
                      ? "hire-chat-panel"
                      : "flex min-h-0 flex-1 flex-col"
              }
            >
              {roleChatWorkspace && roleChatOpen ? (
                <PaneResizeHandle
                  label={t`Resize chat`}
                  edge="start"
                  className="min-[941px]:block"
                  width={clampWidth(roleChatWidth, 320, roleChatMaxWidth)}
                  min={320}
                  max={roleChatMaxWidth}
                  onResize={setRoleChatWidth}
                  onReset={() => setRoleChatWidth(clampWidth(viewportWidth * 0.34, 320, 420))}
                />
              ) : null}
              {/* Inside main so the composer and its menus stay above it. */}
              {!mobileSidebarOpen ? (
                <div
                  data-testid="mobile-sidebar-swipe-edge"
                  aria-hidden="true"
                  className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
                />
              ) : null}
              <div
                className={
                  workspaceBrief
                    ? "app-drag hire-panel-heading justify-between"
                    : "app-drag flex items-center justify-between border-b border-sidebar-border px-3 py-[17px] md:px-[22px]"
                }
              >
                <div className="flex min-w-0 items-center gap-2">
                  {/* Collapsed bots sidebar: this header is the leading edge for window chrome. */}
                  {botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}
                  <button
                    type="button"
                    aria-label={t`Open navigation`}
                    onClick={() => setMobileSidebarOpen(true)}
                    className="app-no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:hidden"
                  >
                    <Menu size={19} strokeWidth={1.7} />
                  </button>
                  {botsSidebarCollapsed ? (
                    <button
                      type="button"
                      data-testid="restore-bots-sidebar"
                      aria-label={showToolActivity ? t`Show bots` : t`Show navigation`}
                      title={showToolActivity ? t`Show bots` : t`Show navigation`}
                      onClick={() => setBotsSidebarCollapsedPref(false)}
                      className="app-no-drag hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:grid"
                    >
                      <PanelLeftOpen size={19} strokeWidth={1.7} aria-hidden="true" />
                    </button>
                  ) : null}
                  {showToolActivity ? (
                    <button
                      type="button"
                      data-testid="bot-settings-trigger"
                      onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
                      className="app-no-drag flex min-w-0 items-center gap-3"
                    >
                      {inGroup ? (
                        <GroupAvatar
                          members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                          size={26}
                        />
                      ) : active ? (
                        <BotAvatar
                          color={active.color}
                          identity={active.id}
                          size={26}
                          status={active.status}
                        />
                      ) : null}
                      <span className="min-w-0">
                        <span
                          className="block truncate text-[16px] font-medium text-foreground"
                          dir="auto"
                        >
                          {inGroup
                            ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                            : (active?.name ?? t`Select a bot`)}
                        </span>
                      </span>
                    </button>
                  ) : roleChatWorkspace ? (
                    <div className="hire-assistant-identity">
                      <Sparkles size={18} aria-hidden />
                      <div>
                        <strong>WeKruit</strong>
                        <span>
                          {emptyCrmChat
                            ? t`Role conversation`
                            : inGroup
                              ? (activeGroup?.name ?? activeSnapshot?.groupName)
                              : active?.name}
                        </span>
                      </div>
                    </div>
                  ) : workspaceBrief ? (
                    <div className="hire-assistant-identity">
                      <Sparkles size={18} aria-hidden />
                      <div>
                        <strong>WeKruit</strong>
                        <span>
                          {recruitingWorkspaceView === "brief" ? (
                            <Trans>Recruiting assistant</Trans>
                          ) : (
                            <Trans>Search refinement</Trans>
                          )}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <h1
                      className="recruiting-heading min-w-0 truncate text-[27px] leading-none text-foreground"
                      dir="auto"
                    >
                      {inGroup
                        ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Role conversation`)
                        : t`Conversation`}
                    </h1>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {roleChatWorkspace ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Collapse role chat`}
                      onClick={() => {
                        setRoleChatOpen(false);
                        requestAnimationFrame(() => roleChatTrigger.current?.focus());
                      }}
                    >
                      <X size={18} aria-hidden />
                    </Button>
                  ) : null}
                  {activeSnapshot?.threadId && !emptyCrmChat ? (
                    <button
                      type="button"
                      aria-label={t`Export conversation`}
                      title={t`Export conversation`}
                      disabled={exportingConversation}
                      aria-busy={exportingConversation}
                      className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent disabled:opacity-50"
                      onClick={async () => {
                        const target = inGroup ? { groupId: groupId! } : { botId: active!.id };
                        const title = inGroup
                          ? (activeGroup?.name ?? activeSnapshot.groupName ?? t`Group`)
                          : active!.name;
                        setExportingConversation(true);
                        try {
                          const { downloadConversation } = await import(
                            "../../lib/conversation-export"
                          );
                          await downloadConversation({
                            target,
                            isCurrent: () =>
                              Boolean(
                                userId &&
                                  bootstrapMe?.spaceId &&
                                  discussionScope.current.active &&
                                  userId === botsRefreshUser.current.id &&
                                  (selectedSpaceId() ?? bootstrapMe.spaceId) ===
                                    bootstrapMe.spaceId,
                              ),
                            title,
                            userName,
                            locale: i18n.locale,
                            agentName: (botId) =>
                              showToolActivity
                                ? (resolveTranscriptBot(botId ?? "")?.name ?? t`Agent`)
                                : "WeKruit",
                          });
                        } catch (error) {
                          setSendError(errorText(error, t`Could not export conversation`));
                        } finally {
                          setExportingConversation(false);
                        }
                      }}
                    >
                      <Download
                        size={18}
                        strokeWidth={1.6}
                        className="text-foreground/75"
                        aria-hidden
                      />
                    </button>
                  ) : null}
                  {activeSnapshot?.threadId && !workspaceBrief && !roleChatWorkspace ? (
                    <button
                      type="button"
                      aria-label={t`Recruiting`}
                      title={t`Recruiting`}
                      onClick={() => setPanel(panel === "recruiting" ? null : "recruiting")}
                      aria-pressed={panel === "recruiting"}
                      data-active={panel === "recruiting" ? "" : undefined}
                      className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                    >
                      <BriefcaseBusiness
                        size={18}
                        strokeWidth={1.6}
                        className="text-foreground/75"
                        aria-hidden
                      />
                    </button>
                  ) : null}
                  {showToolActivity && !inGroup && active ? (
                    <button
                      type="button"
                      title={t`Agent computer`}
                      onClick={() => {
                        const next = panel === "computer" ? null : "computer";
                        setPanel(next);
                        if (next === "computer" && active) {
                          // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                          void refreshThread(active.id).catch(() => undefined);
                        }
                      }}
                      data-active={panel === "computer" ? "" : undefined}
                      className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                    >
                      <Monitor size={18} strokeWidth={1.6} className="text-foreground/75" />
                    </button>
                  ) : null}
                </div>
              </div>
              {!active && !activeGroup && initialBotsLoaded ? (
                <div className="grid flex-1 place-items-center">
                  <Button
                    onClick={() =>
                      showToolActivity ? setPanel("create") : navigate("/onboarding")
                    }
                  >
                    <Plus size={16} aria-hidden="true" />
                    {showToolActivity ? (
                      <Trans>Create new Bot</Trans>
                    ) : (
                      <Trans>Start recruiting</Trans>
                    )}
                  </Button>
                </div>
              ) : !activeSnapshot ? (
                <MessageSkeleton label={t`Loading…`} />
              ) : (
                <Transcript
                  key={emptyCrmChat ? composerDraftKey : activeSnapshot?.threadId}
                  narrow={roleChatWorkspace || !showToolActivity}
                  visible={!workspaceFull || (roleChatWorkspace && roleChatOpen)}
                  scrollRef={messageScroll}
                  scrollRequest={scrollRequest}
                  onScrollRequestHandled={clearScrollRequest}
                  artifactTarget={transcriptArtifactTarget}
                  messages={emptyCrmChat ? [] : transcriptMessages}
                  showToolActivity={showToolActivity}
                  olderCursor={emptyCrmChat ? null : (activeSnapshot?.olderCursor ?? null)}
                  loadingOlder={loadingOlder}
                  answerableAskMessageIds={emptyCrmChat ? [] : answerableAskIds}
                  running={!emptyCrmChat && transcriptRunning}
                  tailPhase={
                    emptyCrmChat ? null : threadTailPhase(activeSnapshot ?? null, { sending })
                  }
                  workingBots={emptyCrmChat ? [] : workingBots}
                  workRuns={emptyCrmChat ? [] : workingRuns}
                  onLoadOlder={loadOlder}
                  onOpenBot={openBot}
                  onAnswer={answerMessage}
                  onReply={(message) => {
                    setReplyTarget(message);
                    setReplyQuote(null);
                  }}
                  onQuote={(message, quote) => {
                    setReplyTarget(message);
                    setReplyQuote(quote);
                  }}
                  onReact={reactToMessage}
                  onJumpToMessage={jumpToReplyMessage}
                  onOpenPeerMessages={(peer) => {
                    setPeerConversation(peer);
                  }}
                  memberName={resolveTranscriptMemberName}
                  peerBot={resolveTranscriptBot}
                  onRefresh={refreshActiveThread}
                  onBotChanged={refreshBots}
                  onAddRoutine={addSkillRoutine}
                  voiceReady={Boolean(voiceStatus?.ready)}
                  speakingMessageId={speakingMessageId}
                  onSpeak={speakMessage}
                  onOpenComputer={onOpenComputer}
                />
              )}
              {showToolActivity && inGroup && composerRunning ? (
                <div className="flex flex-wrap gap-1 px-6 pb-2">
                  {currentRuns
                    .filter((run) => isActive(run.status))
                    .map((run) => {
                      const name = resolveTranscriptBot(run.botId)?.name ?? t`Agent`;
                      return (
                        <Button
                          key={run.id}
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t`Stop ${name}`}
                          disabled={sending}
                          onClick={() => void stopRun(run.id)}
                        >
                          <Trans>Stop {name}</Trans>
                        </Button>
                      );
                    })}
                </div>
              ) : null}
              {resuming || shownSteer ? (
                <div
                  role="status"
                  className="px-6 pb-2 text-center text-[13px] text-muted-foreground"
                >
                  {resuming ? (
                    <Trans>Interrupted, resuming…</Trans>
                  ) : shownSteer === "applied" ? (
                    <Trans>Interjection applied</Trans>
                  ) : (
                    <Trans>Interjection queued</Trans>
                  )}
                </div>
              ) : null}
              {recordingSkill ? (
                <div className="px-6 pb-2 text-center text-[13px] text-destructive">
                  <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
                </div>
              ) : null}
              {active || activeGroup ? (
                <Composer
                  key={`${userId}:${bootstrapMe?.spaceId}:${composerDraftKey}:${showToolActivity ? "developer" : "recruiting"}`}
                  ref={composerRef}
                  draftKey={composerDraftKey}
                  contextKey={
                    selectedCorrespondence?.scope === correspondenceScope
                      ? JSON.stringify([
                          userId,
                          bootstrapMe?.spaceId,
                          selectedCorrespondence.reference.threadId,
                          selectedCorrespondence.reference.roleId,
                          selectedCorrespondence.reference.sourceId,
                          selectedCorrespondence.reference.providerMessageId,
                          selectedCorrespondence.reference.emailId,
                        ])
                      : undefined
                  }
                  enterToSend={enterToSend}
                  compact={!showToolActivity}
                  activeName={
                    emptyCrmChat
                      ? t`Role conversation`
                      : inGroup
                        ? (activeGroup?.name ?? activeSnapshot?.groupName)
                        : active?.name
                  }
                  running={!emptyCrmChat && composerRunning}
                  disabled={
                    Boolean(recordingSkill) ||
                    Boolean(openingCrmRole && !openingCrmRole.error) ||
                    (emptyCrmChat && !crmSelection?.crmRoleId)
                  }
                  pendingAttachments={
                    emptyCrmChat
                      ? attachmentsForThread(pendingAttachments, composerDraftKey)
                      : activePendingAttachments
                  }
                  attachmentNotice={attachmentNotice}
                  sendError={sendError}
                  runError={emptyCrmChat ? null : displayedRunError}
                  runErrorId={emptyCrmChat ? null : displayedRunErrorId}
                  onRunErrorPresented={handleRunErrorPresented}
                  onDismissError={dismissComposerError}
                  sending={sending}
                  fileInputRef={fileInputRef}
                  onAttachmentPick={
                    emptyCrmChat
                      ? (files) => onAttachmentPick(files, composerDraftKey)
                      : onAttachmentPick
                  }
                  onRemoveAttachment={removeAttachment}
                  onSend={sendFromComposer}
                  onStop={stopRun}
                  onVoice={
                    !emptyCrmChat && !inGroup && active
                      ? () => {
                          if (!userId || !bootstrapMe?.spaceId) return;
                          if (!voiceStatus?.ready) {
                            openSettings("voice");
                            return;
                          }
                          startCall({
                            userId,
                            spaceId: bootstrapMe.spaceId,
                            botId: active.id,
                            botName: active.name,
                            botColor: active.color,
                            transcribe: voiceStatus ? Boolean(voiceStatus.transcribe) : undefined,
                          });
                        }
                      : undefined
                  }
                  artifactTarget={transcriptArtifactTarget}
                  replyTarget={emptyCrmChat ? null : activeReplyTarget}
                  replyQuote={emptyCrmChat ? null : activeReplyQuote}
                  replyTargetName={emptyCrmChat ? undefined : replyTargetName}
                  onClearReply={clearReply}
                  mentionTargets={showToolActivity ? composerMentionTargets : []}
                  agentSkills={showToolActivity ? agentSkills : []}
                  onSlashOpen={showToolActivity ? refreshAgentSkills : undefined}
                  onSlashAction={
                    showToolActivity
                      ? (action) => {
                          if (action === "chat-settings") {
                            setPanel(inGroup ? "group-settings" : "settings");
                            return;
                          }
                          if (action === "settings-general") {
                            openSettings("general");
                            return;
                          }
                          if (action === "settings-usage") {
                            openSettings("usage");
                          }
                        }
                      : undefined
                  }
                />
              ) : !initialBotsLoaded ? (
                <div
                  aria-hidden="true"
                  className="mx-6 mb-6 h-[54px] rounded-3xl border border-border bg-background"
                />
              ) : null}
            </section>
          </LinkFaviconsContext.Provider>
          {workspaceBrief && activeSnapshot?.threadId ? (
            <aside aria-label={t`Saved role summary`}>
              {recruitingWorkspaceView === "feedback" ? (
                <CalibrationRoundCard
                  conversation={inGroup ? { groupId: groupId! } : { botId: active!.id }}
                  refreshSignal={recruitingRefresh}
                  readCache={recruitingReadCache.current}
                  readCacheScope={recruitingCacheScope}
                  onSend={sendRoleText}
                />
              ) : null}
              <RecruitingPanel
                workspaceRead={currentWorkspaceRead}
                key={`${userId}:${bootstrapMe?.spaceId}:${activeSnapshot.threadId}:summary`}
                presentation="workspace"
                summary={recruitingWorkspaceView === "brief" ? "brief" : "feedback"}
                readCache={recruitingReadCache.current}
                readCacheScope={recruitingCacheScope}
                threadId={activeSnapshot.threadId}
                botId={inGroup ? undefined : active?.id}
                refreshSignal={recruitingRefresh}
                showDiagnostics={false}
                onClose={() => openRecruitingView("conversation")}
              />
            </aside>
          ) : null}
        </div>
      </div>
    </main>
  );
}
