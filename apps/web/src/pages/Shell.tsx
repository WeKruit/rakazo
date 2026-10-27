import { ATTACHMENT_ACCEPT } from "./shell/Composer";
import { ShellConversation } from "./shell/ShellConversation";
import { ShellOverlays } from "./shell/ShellOverlays";
import { ShellSidebar } from "./shell/ShellSidebar";
import { firstThreadRoute, useShellController } from "./shell/useShellController";

export type { ComposerHandle } from "./shell/Composer";
export { Composer, candidateReferenceText } from "./shell/Composer";

import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ComputerReleaseReason,
  ComputerStatus,
  Routine,
  ThinkingLevel,
} from "@rakazo/contracts";
import { cronFromPreset, isActive } from "@rakazo/core";
import { AvatarStyleProvider, BotAvatar, Button } from "@rakazo/ui-web";
import { Maximize2, Settings, X } from "lucide-react";
import type { ComponentProps } from "react";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import { ComputersUnavailableHint } from "../components/ComputersUnavailableHint";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { CallCard } from "../components/call/CallCard";
import { lazyPanel } from "../components/ErrorBoundary";
import { TeachCaptureOverlay } from "../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../components/teach/TeachRecordingChrome";
import { BOTS_SIDEBAR_EDGE_DRAG_PX } from "../lib/bots-sidebar-pref";
import { screenIframeSandbox } from "../lib/computer-screen";
import { localTimezone } from "../lib/local-timezone";
import { parseModelOptionKey } from "../lib/model-catalog";
import { rpc } from "../lib/rpc";
import { computerPanelNeedsMaintenance, computerTakeoverBlocked } from "../lib/thread-events";
import { errorText } from "../lib/user-error";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { ResizableSidePanel } from "./ResizableSidePanel";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "./RoutineList";
import { writeShortlistWeekFilter } from "./recruiting/dashboard-drilldown";
import { RecruitingDetailProvider } from "./recruiting/detail";
import type { SchedulingPlanHandoff } from "./recruiting/SchedulingPlan";
import { RecruitingChatContextProvider } from "./shell/recruiting-chat-context";

const CreateGroupForm = lazyPanel(() =>
  import("./GroupPanel").then((module) => module.CreateGroupForm),
);
const GroupSettings = lazyPanel(() =>
  import("./GroupPanel").then((module) => module.GroupSettings),
);
const ComputerWorkspace = lazyPanel(() =>
  import("../components/computer/ComputerWorkspace").then((module) => module.ComputerWorkspace),
);
const HomeDashboard = lazyPanel(() =>
  import("./recruiting/HomeDashboard").then((module) => module.HomeDashboard),
);
const BotSettings = lazyPanel(() =>
  import("./shell/bot-panel").then((module) => module.BotSettings),
);
const CreateBotForm = lazyPanel(() =>
  import("./shell/bot-panel").then((module) => module.CreateBotForm),
);
const RoutineEditor = lazyPanel(() =>
  import("./RoutineEditor").then((module) => module.RoutineEditor),
);
const RecruitingPanel = lazyPanel(() =>
  import("./RecruitingPanel").then(
    (module) => (props: ComponentProps<typeof module.RecruitingPanel>) => (
      <module.RecruitingPanel {...props} />
    ),
  ),
);
const RecruitingCorrespondence = lazyPanel(() =>
  import("./RecruitingCorrespondence").then(
    (module) => (props: ComponentProps<typeof module.RecruitingCorrespondence>) => (
      <module.RecruitingCorrespondence {...props} />
    ),
  ),
);
const RecruitingDetailPanel = lazyPanel(() =>
  import("./recruiting/DetailPanel").then((module) => module.RecruitingDetailPanel),
);

export { eventChangesRecruitingPanel } from "./shell/useShellController";

const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;

export function ShellPage() {
  const model = useShellController();
  const { t } = useLingui();
  const {
    currentWorkspaceRead,
    navigate,
    session,
    userId,
    groups,
    setGroups,
    bots,
    setBots,
    setNewRoleSourceId,
    newRoleDescription,
    setNewRoleDescription,
    snapshot,
    sending,
    sendError,
    attachmentNotice,
    setAttachmentNotice,
    panel,
    recruitingRefresh,
    recruitingReadCache,
    setPanel,
    setAgentSkills,
    teachBusy,
    computer,
    setPluginsOpen,
    messagingProviders,
    memoryProviderConfig,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSidebarSwipeRef,
    botsSidebarCollapsed,
    botsSidebarEdgeDragRef,
    setClearTarget,
    booting,
    bootstrapMe,
    setBootstrapMe,
    showToolActivity,
    visibleSidebarWidth,
    showComputerRecoveryHint,
    releaseComputerRecovery,
    holdComputerRecovery,
    routineDraft,
    setRoutineDraft,
    routineWebhookSecret,
    setRoutineWebhookSecret,
    editingRoutine,
    setEditingRoutine,
    setDeleteRoutineTarget,
    savingRoutine,
    setSavingRoutine,
    runningRoutine,
    setRunningRoutine,
    routineError,
    setRoutineError,
    computerOpen,
    setComputerOpen,
    computerViewport,
    routineSavePending,
    ensureWebhookSecret,
    routineSaveRequest,
    routineRunPending,
    inGroup,
    active,
    computerBot,
    activeGroup,
    roleSourceGroup,
    canCreateRoleFrom,
    roleCrewBots,
    activeRoutines,
    recordingSkill,
    activeBotId,
    refreshBots,
    refreshGroupThread,
    refreshThread,
    activeSnapshot,
    recruitingWorkspaceView,
    crmMode,
    homeView,
    knownThreadId,
    recruitingCacheScope,
    boundRoleCrmMode,
    workspaceFull,
    workspaceBrief,
    activeRecruitingTab,
    changeRecruitingTab,
    setSelectedSchedulingPlan,
    selectCorrespondence,
    chatContextApi,
    recruitingDetail,
    openRoleChat,
    candidateFeedbackRecipients,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    composerRunning,
    transcriptMessages,
    transcriptArtifactTarget,
    saveSequenceDraft,
    shellReady,
    onAttachmentPick,
    removeAttachment,
    stopRun,
    stopTeaching,
    refreshActiveTeaching,
    createGroup,
    setBotsSidebarCollapsedPref,
    openSettings,
    createBot,
    refreshComputerFor,
    openComputer,
    releaseComputer,
    embeddedScreenUrl,
    hasControl,
    computerScreenError,
    showingRecoveryHint,
    newRoleAttachmentKey,
    newRoleAttachments,
  } = model;
  const roleCreationForm = (
    <CreateGroupForm
      key={showToolActivity ? "group" : JSON.stringify([roleSourceGroup?.id, newRoleDescription])}
      bots={showToolActivity ? bots : roleCrewBots}
      recruiting={!showToolActivity}
      initialDescription={newRoleDescription}
      attachments={showToolActivity ? undefined : newRoleAttachments}
      attachmentNotice={attachmentNotice}
      attachmentAccept={ATTACHMENT_ACCEPT}
      onAttachmentPick={
        showToolActivity ? undefined : (files) => onAttachmentPick(files, newRoleAttachmentKey)
      }
      onRemoveAttachment={(id) => {
        const attachment = newRoleAttachments.find((item) => item.id === id);
        if (attachment) removeAttachment(attachment);
      }}
      onCancel={() => {
        for (const attachment of newRoleAttachments) removeAttachment(attachment);
        setAttachmentNotice(null);
        setPanel(null);
        setNewRoleSourceId(null);
        setNewRoleDescription("");
      }}
      onCreate={(input) => {
        if (
          !showToolActivity &&
          (!roleSourceGroup ||
            !canCreateRoleFrom(roleSourceGroup.id) ||
            roleCrewBots.length !== roleSourceGroup.members.length ||
            input.botIds.length !== roleSourceGroup.members.length ||
            !input.botIds.every((id, index) => id === roleSourceGroup.members[index]?.botId))
        ) {
          throw new Error(t`The recruiting team changed. Open the role again.`);
        }
        return createGroup(input);
      }}
    />
  );

  const reviewSchedulingPlan = (handoff: SchedulingPlanHandoff) => {
    if (handoff.plan.threadId !== knownThreadId) return;
    setSelectedSchedulingPlan({
      scope: recruitingCacheScope,
      threadId: handoff.plan.threadId,
      emailId: handoff.plan.originalEmail.emailId,
      id: handoff.plan.id,
    });
    openRoleChat(handoff.text);
  };

  // biome-ignore format: ponytail: preserve the native console markup when sharing this shell.
  const nativeCorrespondence =
    knownThreadId && ["sequence", "inbox", "interview"].includes(recruitingWorkspaceView) ? (
      <RecruitingCorrespondence
        view={recruitingWorkspaceView as "sequence" | "inbox" | "interview"}
        messages={transcriptMessages}
        artifactTarget={transcriptArtifactTarget}
        threadId={knownThreadId}
        onEmailSelection={selectCorrespondence}
        onReviewSchedulingPlan={reviewSchedulingPlan}
        outreachBotIds={(activeSnapshot?.members ?? []).filter((member) => member.name === "Outreach").map((member) => member.botId)}
        onConversation={(text) => {
          openRoleChat(text);
        }}
        onOpenConnections={() => setPluginsOpen(true)}
        onSaveDraft={saveSequenceDraft}
        refreshSignal={recruitingRefresh}
        readCache={recruitingReadCache.current}
        readCacheScope={recruitingCacheScope}
      />
    ) : null;
  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      data-product-view={showToolActivity ? "developer" : "recruiting"}
      className="relative flex h-full min-w-0 overflow-clip bg-background text-foreground/90"
      onTouchStartCapture={(event) => {
        if (
          mobileSidebarOpen ||
          event.touches.length !== 1 ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          mobileSidebarSwipeRef.current = null;
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const startsAtEdge = rtl
          ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
          : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
        mobileSidebarSwipeRef.current = startsAtEdge
          ? { startX: touch.clientX, startY: touch.clientY }
          : null;
      }}
      onTouchEndCapture={(event) => {
        const swipe = mobileSidebarSwipeRef.current;
        mobileSidebarSwipeRef.current = null;
        const touch = event.changedTouches[0];
        if (
          !swipe ||
          !touch ||
          mobileSidebarOpen ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          return;
        }
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const horizontal = rtl ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
        const vertical = Math.abs(touch.clientY - swipe.startY);
        if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
          setMobileSidebarOpen(true);
        }
      }}
      onTouchCancelCapture={() => {
        mobileSidebarSwipeRef.current = null;
      }}
    >
      {showToolActivity ? (
        <ComputerUpdateProgress
          onCompleted={() => {
            if (active) void refreshThread(active.id);
          }}
        />
      ) : null}
      {showToolActivity && bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label={t`Close navigation`}
          onClick={() => setMobileSidebarOpen(false)}
          className="absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay md:hidden"
        />
      ) : null}
      <ShellSidebar model={model} />

      {/* The full-screen computer covers the sidebar, so its edge must not catch clicks there. */}
      {computerOpen || booting || !botsSidebarCollapsed ? null : (
        <button
          type="button"
          data-testid="bots-sidebar-edge"
          aria-label={
            showToolActivity
              ? botsSidebarCollapsed
                ? t`Show bots`
                : t`Hide bots`
              : botsSidebarCollapsed
                ? t`Show navigation`
                : t`Hide navigation`
          }
          aria-pressed={!botsSidebarCollapsed}
          className="absolute inset-y-0 start-0 z-50 hidden w-2 cursor-ew-resize touch-none border-0 bg-transparent p-0 md:block"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            botsSidebarEdgeDragRef.current = {
              startX: event.clientX,
              mode: botsSidebarCollapsed ? "expand" : "collapse",
            };
          }}
          onPointerMove={(event) => {
            const drag = botsSidebarEdgeDragRef.current;
            if (!drag) return;
            const rtl =
              typeof document !== "undefined" &&
              document.documentElement.getAttribute("dir") === "rtl";
            const delta = rtl ? drag.startX - event.clientX : event.clientX - drag.startX;
            if (drag.mode === "expand" && delta >= BOTS_SIDEBAR_EDGE_DRAG_PX) {
              botsSidebarEdgeDragRef.current = null;
              setBotsSidebarCollapsedPref(false);
            } else if (drag.mode === "collapse" && delta <= -BOTS_SIDEBAR_EDGE_DRAG_PX) {
              botsSidebarEdgeDragRef.current = null;
              setBotsSidebarCollapsedPref(true);
            }
          }}
          onPointerUp={(event) => {
            const drag = botsSidebarEdgeDragRef.current;
            botsSidebarEdgeDragRef.current = null;
            if (!drag) return;
            if (Math.abs(event.clientX - drag.startX) < BOTS_SIDEBAR_EDGE_DRAG_PX) {
              setBotsSidebarCollapsedPref(!botsSidebarCollapsed);
            }
          }}
          onPointerCancel={() => {
            botsSidebarEdgeDragRef.current = null;
          }}
        />
      )}

      {homeView ? (
        <HomeDashboard
          userName={session.data?.user.name}
          groups={groups}
          readCache={recruitingReadCache.current}
          readCacheScope={
            userId && bootstrapMe?.spaceId
              ? JSON.stringify([userId, bootstrapMe.spaceId])
              : undefined
          }
          refreshSignal={recruitingRefresh}
          onOpenRole={(id, view = "results", filter) =>
            navigate(
              `/app/g/${id}?${writeShortlistWeekFilter(new URLSearchParams({ view }), filter)}`,
            )
          }
          navigationCollapsed={botsSidebarCollapsed}
          onOpenNavigation={() => {
            setBotsSidebarCollapsedPref(false);
            setMobileSidebarOpen(true);
          }}
        />
      ) : null}
      {/* Keep the composer's z-index inside the chat so phone overlays like the side panel cover it. */}
      <ShellConversation
        reviewSchedulingPlan={reviewSchedulingPlan}
        model={model}
        roleCreationForm={roleCreationForm}
        nativeCorrespondence={nativeCorrespondence}
      />

      <CallCard
        userId={userId}
        spaceId={bootstrapMe?.spaceId}
        onSettings={() => openSettings("voice")}
      />

      <ResizableSidePanel
        botsSidebarWidth={visibleSidebarWidth}
        open={Boolean(
          recruitingDetail.current ||
            (!workspaceFull &&
              !(workspaceBrief && panel === "recruiting") &&
              panel &&
              (active || activeGroup || panel === "create")),
        )}
        panel={recruitingDetail.current ? "recruiting-detail" : (panel ?? "closed")}
      >
        {recruitingDetail.current && activeSnapshot?.threadId ? (
          <RecruitingDetailPanel
            controller={recruitingDetail}
            onAskChat={(text) => openRoleChat(text)}
            onDraftReply={
              boundRoleCrmMode && !crmMode
                ? ({ email, ...context }) =>
                    void draftCrmReply({
                      ...context,
                      threadId: activeSnapshot.threadId,
                      email: {
                        sender: email.sender,
                        recipients: email.recipients,
                        subject: email.subject,
                        date: email.date,
                      },
                    })
                : undefined
            }
          />
        ) : !workspaceFull &&
          !(workspaceBrief && panel === "recruiting") &&
          panel &&
          (active || activeGroup || panel === "create") ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
            {panel !== "routine" &&
            panel !== "create" &&
            panel !== "create-group" &&
            panel !== "group-settings" &&
            panel !== "recruiting" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-muted-foreground">
                  {panel === "settings" ? (
                    <Trans>Settings</Trans>
                  ) : active ? (
                    (computer?.state ?? active.status)
                  ) : (
                    <Trans>Group</Trans>
                  )}
                </span>
                <div className="flex gap-1">
                  {active &&
                  panel === "computer" &&
                  !computerOpen &&
                  computerPanelNeedsMaintenance(computer?.state, booting) ? (
                    <ComputerMaintenanceActions
                      botId={active.id}
                      computer={computer}
                      onChanged={async () => {
                        await refreshThread(active.id);
                      }}
                    />
                  ) : null}
                  {active ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
                      onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
                      className={panel === "settings" ? "text-foreground" : "text-muted-foreground"}
                    >
                      <Settings size={16} strokeWidth={1.7} />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Close panel`}
                    onClick={() => setPanel(null)}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
            ) : null}
            {panel === "computer" && active ? (
              <div>
                <div
                  data-testid="computer-preview"
                  className={`group relative rounded-[14px] bg-background ${
                    showingRecoveryHint ? "" : "aspect-[16/10] overflow-hidden"
                  }`}
                >
                  {computerOpen ? (
                    <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                      <Trans>Open in full window</Trans>
                    </div>
                  ) : computer?.kind === "desktop" ? (
                    <DesktopKindEmptyState className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80" />
                  ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
                    <iframe
                      title={t`Bot screen preview`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write"
                      style={{ pointerEvents: "none" }}
                    />
                  ) : (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
                      {computerScreenError ??
                        (showComputerRecoveryHint ? (
                          <ComputersUnavailableHint
                            sandboxProvider={bootstrapMe?.sandboxProvider}
                            onRecovered={(sandboxProvider) => {
                              setBootstrapMe((prev) =>
                                prev ? { ...prev, sandboxProvider } : prev,
                              );
                              holdComputerRecovery();
                            }}
                            onRecoveryDismissed={releaseComputerRecovery}
                            onOpenComputerSettings={
                              bootstrapMe?.isDeploymentOwner === true
                                ? () => openSettings("computer")
                                : undefined
                            }
                          />
                        ) : (
                          computerPlaceholder(
                            computer?.state,
                            booting,
                            computerLabel(computer?.mode, active.name),
                          )
                        ))}
                    </div>
                  )}
                  {!computerScreenError && !showingRecoveryHint ? (
                    <button
                      type="button"
                      data-testid="computer-preview-open"
                      className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={t`Open`}
                      onClick={() => void openComputer()}
                    >
                      <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-[14px] text-foreground shadow-md">
                        <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                        <Trans>Open</Trans>
                      </span>
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 truncate text-[13.5px] text-muted-foreground" dir="auto">
                  {t`${active.name}'s screen`}
                </p>
                <RoutineListHeader
                  onCreate={() => {
                    setRoutineDraft(emptyRoutineDraft());
                    setRoutineWebhookSecret(null);
                    setEditingRoutine(null);
                    setRoutineError(null);
                    setPanel("routine");
                  }}
                />
                {activeRoutines.map((routine) => {
                  const routineRunning =
                    snapshot?.run?.routineId === routine.id && isActive(snapshot.run.status);
                  return (
                    <RoutineListRow
                      key={routine.id}
                      routine={routine}
                      running={routineRunning}
                      onOpen={() => {
                        setRoutineDraft(draftFromRoutine(routine));
                        setRoutineWebhookSecret(null);
                        setEditingRoutine(routine);
                        setRoutineError(null);
                        setPanel("routine");
                      }}
                      onStop={() => void stopRun()}
                    />
                  );
                })}
              </div>
            ) : null}
            {panel === "recruiting" && activeSnapshot?.threadId ? (
              <RecruitingPanel
                workspaceRead={currentWorkspaceRead}
                key={`${userId}:${bootstrapMe?.spaceId}:${activeSnapshot.threadId}`}
                threadId={activeSnapshot.threadId}
                botId={inGroup ? undefined : active?.id}
                refreshSignal={recruitingRefresh}
                tab={activeRecruitingTab}
                onTabChange={changeRecruitingTab}
                showDiagnostics={showToolActivity}
                onClose={() => setPanel(null)}
                onDiscussCandidate={discussCandidate}
                onCandidateFeedback={feedbackCandidate}
                candidateFeedbackRecipients={candidateFeedbackRecipients}
                onRevealMessage={(target) => {
                  navigate({
                    pathname: target.groupId ? `/app/g/${target.groupId}` : `/app/${target.botId}`,
                    search: `?${new URLSearchParams({ m: target.messageId })}`,
                  });
                }}
              />
            ) : null}
            {panel === "create-group" ? roleCreationForm : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettings
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                onSave={async (input) => {
                  const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
                  setGroups((current) =>
                    current.map((group) => (group.id === updated.id ? updated : group)),
                  );
                  void Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                    () => undefined,
                  );
                }}
                onRemove={async () => {
                  await rpc.groups.remove({ groupId: activeGroup.id });
                  const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                  setGroups(remainingGroups);
                  setPanel(null);
                  navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                  await refreshBots().catch(() => undefined);
                }}
                onClose={() => setPanel(null)}
                covered={computerOpen}
              />
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                onCancel={() => setPanel(null)}
                onCreate={(input) => createBot(input)}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettings
                key={active.id}
                bot={active}
                memoryProviderConfigured={memoryProviderConfig != null}
                onSkillsChange={setAgentSkills}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== active.computerMode) {
                    await rpc.bots.setComputer({
                      botId: active.id,
                      mode: computerMode,
                    });
                  }
                  const updated = await rpc.bots.update({ botId: active.id, ...patch });
                  setBots((current) =>
                    current.map((bot) => (bot.id === updated.id ? updated : bot)),
                  );
                  // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
                  await refreshBots().catch(() => undefined);
                }}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: active.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                onClear={() => setClearTarget({ kind: "bot", chat: active })}
              />
            ) : null}
            {panel === "routine" && active ? (
              <RoutineEditor
                draft={routineDraft}
                onChange={setRoutineDraft}
                editing={editingRoutine}
                timezone={editingRoutine?.timezone ?? localTimezone()}
                webhook={{
                  path:
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
                      : `/api/v1/bots/${active.id}/webhook`,
                  secret: routineWebhookSecret,
                  configured: active.webhookConfigured || Boolean(routineWebhookSecret),
                }}
                githubPath={
                  typeof window !== "undefined"
                    ? `${window.location.origin}/api/v1/bots/${active.id}/github`
                    : `/api/v1/bots/${active.id}/github`
                }
                messageProviders={messagingProviders}
                saving={savingRoutine}
                running={runningRoutine}
                error={routineError}
                onBack={() => setPanel("computer")}
                onClose={() => setPanel(null)}
                onEnsureWebhook={async () => {
                  await ensureWebhookSecret(active.id);
                }}
                onSave={async () => {
                  if (routineSavePending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                  if (
                    !routineDraft.schedules.length &&
                    !routineDraft.webhookEnabled &&
                    !routineDraft.githubEnabled &&
                    !routineDraft.messageProvider
                  ) {
                    setRoutineError(t`Add a schedule, webhook, GitHub, or message trigger`);
                    return;
                  }
                  const saveRequest = ++routineSaveRequest.current;
                  routineSavePending.current = true;
                  setSavingRoutine(true);
                  setRoutineError(null);
                  try {
                    if (
                      (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
                      !active.webhookConfigured &&
                      !routineWebhookSecret
                    ) {
                      await ensureWebhookSecret(targetBotId);
                    }
                    const crons = routineDraft.schedules.map(cronFromPreset);
                    const model = routineDraft.modelKey
                      ? parseModelOptionKey(routineDraft.modelKey)
                      : null;
                    const routineModel = {
                      modelProvider: model?.provider ?? null,
                      modelId: model?.modelId ?? null,
                      thinkingLevel: (model && routineDraft.thinkingLevel
                        ? routineDraft.thinkingLevel
                        : null) as ThinkingLevel | null,
                    };
                    let saved: Routine;
                    if (targetRoutine) {
                      const armOneShot =
                        routineDraft.active && routineNeedsOneShotArm(targetRoutine, crons);
                      let runAt: string | undefined;
                      if (armOneShot) {
                        if (!routineDraft.runAtLocal) {
                          setRoutineError(t`Add a run time for this one-shot.`);
                          return;
                        }
                        const parsed = new Date(routineDraft.runAtLocal);
                        if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                          setRoutineError(t`Run time must be in the future.`);
                          return;
                        }
                        runAt = parsed.toISOString();
                      }
                      saved = await rpc.routines.update({
                        routineId: targetRoutine.id,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        ...(JSON.stringify(crons) !== JSON.stringify(targetRoutine.crons)
                          ? { crons }
                          : {}),
                        ...(armOneShot || routineDraft.active !== targetRoutine.active
                          ? { active: armOneShot ? true : routineDraft.active }
                          : {}),
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                        ...(routineModel.modelProvider !== targetRoutine.modelProvider ||
                        routineModel.modelId !== targetRoutine.modelId ||
                        routineModel.thinkingLevel !== targetRoutine.thinkingLevel
                          ? routineModel
                          : {}),
                        ...(runAt ? { runAt } : {}),
                      });
                    } else {
                      saved = await rpc.routines.create({
                        botId: targetBotId,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        timezone: localTimezone(),
                        active: routineDraft.active,
                        notify: true,
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                        ...routineModel,
                      });
                    }
                    if (
                      routineSaveRequest.current === saveRequest &&
                      activeBotId.current === targetBotId
                    ) {
                      setEditingRoutine(saved);
                      setRoutineDraft(draftFromRoutine(saved));
                    }
                  } catch (error) {
                    if (
                      routineSaveRequest.current !== saveRequest ||
                      activeBotId.current !== targetBotId
                    ) {
                      return;
                    }
                    setRoutineError(errorText(error, t`Could not save routine`));
                    return;
                  } finally {
                    routineSavePending.current = false;
                    setSavingRoutine(false);
                  }
                  if (
                    routineSaveRequest.current !== saveRequest ||
                    activeBotId.current !== targetBotId
                  ) {
                    return;
                  }
                  await refreshThread(targetBotId).catch(() => undefined);
                }}
                onTestRun={async () => {
                  if (routineRunPending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (!targetRoutine) return;
                  routineRunPending.current = true;
                  setRunningRoutine(true);
                  setRoutineError(null);
                  try {
                    await rpc.routines.testRun({ routineId: targetRoutine.id });
                    await refreshThread(targetBotId);
                  } catch (error) {
                    if (activeBotId.current === targetBotId) {
                      setRoutineError(errorText(error, t`Could not run routine`));
                    }
                  } finally {
                    routineRunPending.current = false;
                    setRunningRoutine(false);
                  }
                }}
                onDelete={() => {
                  if (editingRoutine) {
                    setDeleteRoutineTarget(editingRoutine);
                    return;
                  }
                  setPanel("computer");
                }}
              />
            ) : null}
          </div>
        ) : null}
      </ResizableSidePanel>

      <ShellOverlays model={model} />

      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-background/95">
          <div className="text-[19px] font-medium text-foreground">
            <Trans>Booting up {computerBot?.name ?? active?.name}’s computer</Trans>
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-accent">
            <div className="h-full w-2/3 rounded-full bg-primary" />
          </div>
        </div>
      ) : computerOpen && computerBot ? (
        <div className="fixed inset-0 z-30 bg-background">
          <div
            data-testid="computer-viewport"
            className="fixed inset-x-0 top-0 flex flex-col bg-background"
            style={{
              height: computerViewport ? `${computerViewport.height}px` : "100dvh",
              top: computerViewport ? `${computerViewport.offsetTop}px` : undefined,
            }}
          >
            <div
              data-testid="computer-chrome"
              className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <BotAvatar
                  color={computerBot.color}
                  identity={computerBot.id}
                  size={28}
                  status={computerBot.status}
                />
                {recordingSkill ? (
                  <TeachRecordingChrome
                    recording={recordingSkill}
                    botId={computerBot.id}
                    busy={teachBusy}
                    onStop={stopTeaching}
                    variant="overlay"
                  />
                ) : (
                  <span className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
                    {computerLabel(computer?.mode, computerBot.name)}
                  </span>
                )}
                {!recordingSkill && hasControl ? (
                  computer?.takeoverRequested ? (
                    <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
                      <Trans>Needs you</Trans>
                    </span>
                  ) : (
                    <span className="rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success">
                      <Trans>You have control</Trans>
                    </span>
                  )
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {composerRunning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t`Stop`}
                    data-testid="computer-overlay-stop"
                    onClick={() => void stopRun()}
                    disabled={sending}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                ) : null}
                {recordingSkill ? (
                  <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
                ) : hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={Boolean(computer?.takeoverRequested)}
                    onRelease={releaseComputer}
                  />
                ) : computer?.state === "running" &&
                  !computerTakeoverBlocked(computer, snapshot?.run?.status) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={booting}
                    onClick={() => void openComputer(computerBot.id, true)}
                  >
                    <Trans>Take control</Trans>
                  </Button>
                ) : null}
                {computerBot && !recordingSkill ? (
                  <TeachComputerOverlayControl
                    key={computerBot.id}
                    botId={computerBot.id}
                    computer={computer}
                    busy={teachBusy}
                    onRefresh={refreshActiveTeaching}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
                  <ComputerMaintenanceActions
                    botId={computerBot.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshComputerFor(computerBot.id);
                    }}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Close computer`}
                  onClick={() => setComputerOpen(false)}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
            {sendError ? (
              <div
                role="alert"
                className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-[13px] text-destructive"
              >
                {sendError}
              </div>
            ) : null}
            <div className="relative min-h-0 flex-1 bg-background">
              <ComputerWorkspace
                botId={computerBot.id}
                computer={computer}
                hasControl={hasControl}
                dock={!recordingSkill}
                onTakeControl={
                  computer?.state === "running" &&
                  !hasControl &&
                  !computerTakeoverBlocked(computer, snapshot?.run?.status)
                    ? () => openComputer(computerBot.id, true)
                    : undefined
                }
              >
                {computer?.kind === "desktop" ? (
                  <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground/80" />
                ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
                  <>
                    <iframe
                      title={t`Bot screen`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write; fullscreen"
                      style={{
                        pointerEvents: recordingSkill || !hasControl ? "none" : "auto",
                      }}
                    />
                    {computerBot ? (
                      <TeachCaptureOverlay
                        botId={computerBot.id}
                        skill={recordingSkill}
                        enabled={Boolean(recordingSkill)}
                        screenWidth={computer?.screenWidth}
                        screenHeight={computer?.screenHeight}
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                    {computerScreenError ??
                      (computer?.state === "suspended"
                        ? t`Computer is asleep`
                        : computerLabel(computer?.mode, computerBot.name))}
                  </div>
                )}
              </ComputerWorkspace>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "organic"}>
      <RecruitingChatContextProvider value={chatContextApi}>
        <RecruitingDetailProvider value={recruitingDetail}>{shell}</RecruitingDetailProvider>
      </RecruitingChatContextProvider>
    </AvatarStyleProvider>
  );
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  if (!takeoverRequested) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease()}>
        <Trans>Release control</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease("skipped")}>
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" onClick={() => void onRelease("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}

function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on this computer, not a Linux desktop. Shell and files use your home folder.
      </Trans>
    </div>
  );
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}
