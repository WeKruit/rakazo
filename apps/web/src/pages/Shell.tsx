import { computerLabel, DesktopKindEmptyState } from "./shell/computer-presentation";

const ShellPanelContent = lazyPanel(() =>
  import("./shell/ShellPanelContent").then((m) => m.ShellPanelContent),
);

import { ATTACHMENT_ACCEPT } from "./shell/Composer";
import { ShellConversation } from "./shell/ShellConversation";

const ShellOverlays = lazyPanel(() => import("./shell/ShellOverlays").then((m) => m.ShellOverlays));

import { ShellSidebar } from "./shell/ShellSidebar";
import { useShellController } from "./shell/useShellController";

export type { ComposerHandle } from "./shell/Composer";
export { Composer, candidateReferenceText } from "./shell/Composer";

import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerReleaseReason } from "@rakazo/contracts";
import { AvatarStyleProvider, BotAvatar, Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ComponentProps } from "react";

const ComputerMaintenanceActions = lazyPanel(() =>
  import("../components/ComputerMaintenanceActions").then((m) => m.ComputerMaintenanceActions),
);

const ComputerUpdateProgress = lazyPanel(() =>
  import("../components/ComputerUpdateProgress").then(
    (m) => (props: ComponentProps<typeof m.ComputerUpdateProgress>) => (
      <m.ComputerUpdateProgress {...props} />
    ),
  ),
);
const CallCard = lazyPanel(() => import("../components/call/CallCard").then((m) => m.CallCard));

import { lazyPanel } from "../components/ErrorBoundary";

const TeachCaptureOverlay = lazyPanel(() =>
  import("../components/teach/TeachCaptureOverlay").then((m) => m.TeachCaptureOverlay),
);
const TeachComputerOverlayControl = lazyPanel(() =>
  import("../components/teach/TeachComputerOverlay").then((m) => m.TeachComputerOverlayControl),
);
const TeachRecordingChrome = lazyPanel(() =>
  import("../components/teach/TeachRecordingChrome").then((m) => m.TeachRecordingChrome),
);
const TeachStopButton = lazyPanel(() =>
  import("../components/teach/TeachRecordingChrome").then((m) => m.TeachStopButton),
);

import { BOTS_SIDEBAR_EDGE_DRAG_PX } from "../lib/bots-sidebar-pref";
import { screenIframeSandbox } from "../lib/computer-screen";
import { computerTakeoverBlocked } from "../lib/thread-events";

const HostComputerPrompt = lazyPanel(() =>
  import("./HostComputerPrompt").then((m) => m.HostComputerPrompt),
);

import { ResizableSidePanel } from "./ResizableSidePanel";
import { writeShortlistWeekFilter } from "./recruiting/dashboard-drilldown";
import { RecruitingDetailProvider } from "./recruiting/detail";
import type { SchedulingPlanHandoff } from "./recruiting/SchedulingPlan";
import { RecruitingChatContextProvider } from "./shell/recruiting-chat-context";

const CreateGroupForm = lazyPanel(() =>
  import("./GroupPanel").then((module) => module.CreateGroupForm),
);

const ComputerWorkspace = lazyPanel(() =>
  import("../components/computer/ComputerWorkspace").then((module) => module.ComputerWorkspace),
);
const HomeDashboard = lazyPanel(() =>
  import("./recruiting/HomeDashboard").then((module) => module.HomeDashboard),
);

const RecruitingCorrespondence = lazyPanel(() =>
  import("./RecruitingCorrespondence").then(
    (module) => (props: ComponentProps<typeof module.RecruitingCorrespondence>) => (
      <module.RecruitingCorrespondence {...props} />
    ),
  ),
);

export { eventChangesRecruitingPanel } from "./shell/useShellController";

const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;

export function ShellPage() {
  const model = useShellController();
  const { t } = useLingui();
  const {
    navigate,
    session,
    userId,
    groups,
    bots,
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
    teachBusy,
    computer,
    setPluginsOpen,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSidebarSwipeRef,
    botsSidebarCollapsed,
    botsSidebarEdgeDragRef,
    booting,
    bootstrapMe,
    setBootstrapMe,
    showToolActivity,
    visibleSidebarWidth,
    computerOpen,
    setComputerOpen,
    computerViewport,
    active,
    computerBot,
    activeGroup,
    roleSourceGroup,
    canCreateRoleFrom,
    roleCrewBots,
    recordingSkill,
    refreshThread,
    activeSnapshot,
    recruitingWorkspaceView,
    homeView,
    knownThreadId,
    recruitingCacheScope,
    workspaceFull,
    workspaceBrief,
    setSelectedSchedulingPlan,
    selectCorrespondence,
    chatContextApi,
    recruitingDetail,
    openRoleChat,
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
    refreshComputerFor,
    openComputer,
    releaseComputer,
    embeddedScreenUrl,
    hasControl,
    computerScreenError,
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

      {model.call ? (
        <CallCard
          userId={userId}
          spaceId={bootstrapMe?.spaceId}
          onSettings={() => openSettings("voice")}
        />
      ) : null}

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
        {recruitingDetail.current ||
        (!workspaceFull &&
          !(workspaceBrief && panel === "recruiting") &&
          panel &&
          (active || activeGroup || panel === "create")) ? (
          <ShellPanelContent model={model} roleCreationForm={roleCreationForm} />
        ) : null}
      </ResizableSidePanel>

      {model.spaceMenu ||
      model.deleteTarget ||
      model.deleteGroupTarget ||
      model.renameSpaceTarget ||
      model.deleteSpaceTarget ||
      model.newSectionTarget ||
      model.renameSectionTarget ||
      model.sectionMenu ||
      model.newSpaceOpen ||
      model.pickerInfoTopic ||
      model.clearTarget ||
      model.deleteRoutineTarget ||
      model.pluginsOpen ||
      model.mcpOpen ||
      model.messagingSettingsOpen ||
      model.settingsOpen ||
      (model.contextChat && model.botMenu) ||
      (model.showToolActivity && model.commandPaletteOpen) ||
      (model.peerConversation && model.active) ? (
        <ShellOverlays model={model} />
      ) : null}

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
