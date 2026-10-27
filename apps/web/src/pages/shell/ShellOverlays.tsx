import { Trans } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Pencil, Trash2 } from "lucide-react";
import { Suspense } from "react";
import { lazyOverlay, lazyPanel } from "../../components/ErrorBoundary";
import { rightPanelStorageKey } from "../../lib/right-panel-state";
import { rpc, selectedSpaceId, selectSpace } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { TabLoading } from "../recruiting/shared";
import { FALLBACK_BOT_COLOR } from "../shell/constants";
import { commitSpaceRename } from "../shell/space-sidebar";
import type { useShellController } from "../shell/useShellController";

const CommandPalette = lazyPanel(() =>
  import("../shell/command-palette").then((module) => module.CommandPalette),
);
const ClearConversationDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.ClearConversationDialog),
);
const DeleteBotDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.DeleteBotDialog),
);
const DeleteItemDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.DeleteItemDialog),
);
const NewBotSectionDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.NewBotSectionDialog),
);
const NewSpaceDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.NewSpaceDialog),
);
const PickerInfoDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.PickerInfoDialog),
);
const RenameBotSectionDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.RenameBotSectionDialog),
);
const RenameSpaceDialog = lazyPanel(() =>
  import("../shell/dialogs").then((module) => module.RenameSpaceDialog),
);

const BotContextMenu = lazyOverlay(() =>
  import("../BotContextMenu").then((module) => module.BotContextMenu),
);
const MessagingSettingsOverlay = lazyOverlay(() =>
  import("../MessagingSettingsOverlay").then((module) => module.MessagingSettingsOverlay),
);
const SettingsOverlay = lazyOverlay(() =>
  import("../SettingsOverlay").then((module) => module.SettingsOverlay),
);
const PeerMessagesOverlay = lazyOverlay(() =>
  import("../PeerMessagesOverlay").then((module) => module.PeerMessagesOverlay),
);
const PluginsOverlay = lazyOverlay(() =>
  import("../PluginsOverlay").then((module) => module.PluginsOverlay),
);
const McpServersOverlay = lazyOverlay(() =>
  import("../McpServersOverlay").then((module) => module.McpServersOverlay),
);
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;
function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

export function ShellOverlays({ model }: { model: ReturnType<typeof useShellController> }) {
  const {
    t,
    navigate,
    session,
    userId,
    setGroups,
    bots,
    botSections,
    setSpaces,
    setSendError,
    setPanelState,
    setRestoredPanelKey,
    explicitPanelTarget,
    pendingPanelRestore,
    setPanel,
    peerConversation,
    setPeerConversation,
    updateSnapshot,
    pluginsOpen,
    setPluginsOpen,
    mcpOpen,
    setMcpOpen,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    messagingSettingsOpen,
    setMessagingSettingsOpen,
    messagingSurfaceEnabled,
    memoryProviderConfig,
    setMemoryProviderConfig,
    memoryProviderConfigRevision,
    setVoiceStatus,
    setMobileSidebarOpen,
    newSpaceOpen,
    setNewSpaceOpen,
    pickerInfoTopic,
    setPickerInfoTopic,
    commandPaletteOpen,
    setCommandPaletteOpen,
    botMenu,
    setBotMenu,
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    deleteSpaceTarget,
    setDeleteSpaceTarget,
    renameSpaceTarget,
    setRenameSpaceTarget,
    spaceMenu,
    setSpaceMenu,
    closeSpaceMenu,
    spaceMenuTarget,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    sectionMenu,
    setSectionMenu,
    closeSectionMenu,
    bootstrapMe,
    setBootstrapMe,
    showToolActivity,
    setEditingRoutine,
    deleteRoutineTarget,
    setDeleteRoutineTarget,
    usage,
    refreshUsage,
    expandedHistoryThread,
    historyEpoch,
    pinnedAroundRef,
    inGroup,
    active,
    activeGroup,
    panelTarget,
    activeBotId,
    contextBot,
    contextGroup,
    contextChat,
    closeBotMenu,
    markBotRead,
    markBotUnread,
    refreshBots,
    refreshThread,
    activeSnapshot,
    workspaceNewRole,
    connectionMemberIds,
    recruitingConnectionBot,
    resolveTranscriptBot,
    userName,
  } = model;
  return (
    <>
      <Suspense fallback={<TabLoading />}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            showDeveloperActions={showToolActivity}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
                : rpc.groups.update({
                    groupId: contextGroup!.id,
                    pinned: !contextGroup!.pinned,
                  });
              void request.then(() => refreshBots());
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                const request = unread
                  ? rpc.threads.markUnread({ groupId: contextGroup!.id })
                  : rpc.threads.markRead({ groupId: contextGroup!.id });
                void request
                  .then(() =>
                    setGroups((current) =>
                      current.map((group) =>
                        group.id === contextGroup!.id ? { ...group, unread } : group,
                      ),
                    ),
                  )
                  .catch(() => undefined);
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextChat.sectionId) return;
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, sectionId })
                : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
              void request.then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onRenameSection={(sectionId) => {
              const section = botSections.find((item) => item.id === sectionId);
              const spaceId = bootstrapMe?.spaceId;
              if (section && spaceId) setRenameSectionTarget({ section, spaceId });
              setBotMenu(null);
            }}
            onEdit={() => {
              const destKey =
                userId && bootstrapMe?.spaceId
                  ? rightPanelStorageKey(
                      userId,
                      bootstrapMe.spaceId,
                      contextBot ? "bot" : "group",
                      contextChat.id,
                    )
                  : null;
              explicitPanelTarget.current = destKey;
              pendingPanelRestore.current = null;
              navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
              // Mark the destination key restored so we do not write settings onto the source chat.
              setPanelState(contextBot ? "settings" : "group-settings");
              setRestoredPanelKey(destKey);
              setBotMenu(null);
            }}
            onDuplicate={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.duplicate({ botId: contextBot.id })
                : rpc.groups.duplicate({ groupId: contextGroup!.id });
              void request.then(async (chat) => {
                await refreshBots();
                navigate(contextBot ? `/app/${chat.id}` : `/app/g/${chat.id}`);
              });
            }}
            onClear={() => {
              setClearTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onArchive={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.archive({ botId: contextBot.id })
                : rpc.groups.archive({ groupId: contextGroup!.id });
              void request
                .then(() => refreshBots(true))
                .catch((error) => setSendError(errorText(error, t`Could not continue`)));
            }}
            onDelete={() => {
              if (contextBot) setDeleteTarget(contextBot);
              else setDeleteGroupTarget(contextGroup!);
              setBotMenu(null);
            }}
          />
        ) : null}

        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              {spaceMenuTarget?.canRename ? (
                <DropdownMenuItem
                  onClick={() => {
                    setRenameSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Pencil />
                  {t`Rename space`}
                </DropdownMenuItem>
              ) : null}
              {spaceMenuTarget?.canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setDeleteSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Trash2 />
                  {t`Delete space`}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {deleteTarget ? (
          <DeleteBotDialog
            bot={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {renameSpaceTarget ? (
          <RenameSpaceDialog
            space={renameSpaceTarget}
            onCancel={() => setRenameSpaceTarget(null)}
            onConfirm={async (name) => {
              const spaceId = renameSpaceTarget.id;
              await commitSpaceRename({
                rename: async () => {
                  await rpc.spaces.rename({ spaceId, name });
                },
                apply: () => {
                  setSpaces((current) =>
                    current.map((space) => (space.id === spaceId ? { ...space, name } : space)),
                  );
                },
                refresh: () => refreshBots(),
              });
              setRenameSpaceTarget(null);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The auth boundary changed, so reload like a space switch.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionTarget ? (
          <NewBotSectionDialog
            bot={newSectionTarget.chat}
            onCancel={() => setNewSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create(
                newSectionTarget.kind === "bot"
                  ? { botId: newSectionTarget.chat.id, name }
                  : { groupId: newSectionTarget.chat.id, name },
              );
              setNewSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {renameSectionTarget ? (
          <RenameBotSectionDialog
            section={renameSectionTarget.section}
            onCancel={() => setRenameSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.update(
                {
                  sectionId: renameSectionTarget.section.id,
                  name,
                },
                { context: { spaceId: renameSectionTarget.spaceId } },
              );
              setRenameSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {sectionMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSectionMenu();
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: sectionMenu.position.x, top: sectionMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for ${sectionMenu.section.name}`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                onClick={() => {
                  setRenameSectionTarget({
                    section: sectionMenu.section,
                    spaceId: sectionMenu.spaceId,
                  });
                  setSectionMenu(null);
                }}
              >
                <Pencil />
                {t`Rename section`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {showToolActivity && commandPaletteOpen && (
          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            bots={bots}
            onSelectBot={(id) => {
              setMobileSidebarOpen(false);
              navigate(`/app/${id}`);
            }}
          />
        )}

        {newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {pickerInfoTopic ? (
          <PickerInfoDialog topic={pickerInfoTopic} onClose={() => setPickerInfoTopic(null)} />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
                (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
              ) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
                updateSnapshot((current) =>
                  current ? { ...current, messages: [], olderCursor: null, run: null } : current,
                );
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteRoutineTarget ? (
          <DeleteItemDialog
            item={deleteRoutineTarget}
            noun="routine"
            onCancel={() => setDeleteRoutineTarget(null)}
            onConfirm={async () => {
              const target = deleteRoutineTarget;
              await rpc.routines.remove({ routineId: target.id });
              setDeleteRoutineTarget(null);
              setEditingRoutine((current) => (current?.id === target.id ? null : current));
              if (activeBotId.current !== target.botId) return;
              await refreshThread(target.botId);
              if (activeBotId.current === target.botId) setPanel("computer");
            }}
          />
        ) : null}

        {pluginsOpen ? (
          <PluginsOverlay
            key={JSON.stringify([
              userId,
              bootstrapMe?.spaceId,
              panelTarget,
              activeSnapshot?.threadId,
              connectionMemberIds,
            ])}
            activeBotId={workspaceNewRole ? undefined : activeBotId.current}
            coordinatorBotId={connectionMemberIds[0]}
            recruitingBotIds={{
              outreach: recruitingConnectionBot("outreach"),
              scheduling: recruitingConnectionBot("scheduling"),
            }}
            memberBotIds={inGroup || workspaceNewRole ? connectionMemberIds : undefined}
            developerView={showToolActivity}
            onClose={() => setPluginsOpen(false)}
            onOpenMcp={() => {
              setPluginsOpen(false);
              setMcpOpen(true);
            }}
          />
        ) : null}
        {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
        {messagingSettingsOpen ? (
          <MessagingSettingsOverlay onClose={() => setMessagingSettingsOpen(false)} />
        ) : null}
      </Suspense>

      <Suspense fallback={<TabLoading />}>
        {settingsOpen ? (
          <SettingsOverlay
            name={userName}
            email={session.data?.user.email}
            usage={usage}
            onUsageOpen={refreshUsage}
            initialSection={settingsSection}
            avatarStyle={bootstrapMe?.avatarStyle ?? "organic"}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            billingEnabled={bootstrapMe?.billingEnabled === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            onSandboxProviderChange={(sandboxProvider) =>
              setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev))
            }
            messagingEnabled={messagingSurfaceEnabled}
            onOpenMessaging={() => {
              setSettingsOpen(false);
              setMessagingSettingsOpen(true);
            }}
            onAvatarStyleChange={async (avatarStyle) => {
              const nextMe = await rpc.preferences.update({ avatarStyle });
              setBootstrapMe(nextMe);
            }}
            memoryConfig={memoryProviderConfig}
            onMemoryConfigChange={(config) => {
              memoryProviderConfigRevision.current += 1;
              setMemoryProviderConfig(config);
            }}
            onVoiceStatusMaybeChanged={async () => {
              try {
                setVoiceStatus(
                  await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]),
                );
              } catch {
                // Prefer reopening Voice settings over starting a call with stale readiness.
                setVoiceStatus(null);
              }
            }}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection("general");
            }}
          />
        ) : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={
              resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
            }
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
      </Suspense>
    </>
  );
}
