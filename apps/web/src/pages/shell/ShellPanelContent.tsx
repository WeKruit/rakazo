import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, ThinkingLevel } from "@rakazo/contracts";
import { cronFromPreset, isActive } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Maximize2, Settings, X } from "lucide-react";
import type { ComponentProps } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";
import { withFeatureMessages } from "../../lib/i18n";
import { computerLabel, computerPlaceholder, DesktopKindEmptyState } from "./computer-presentation";
import { firstThreadRoute } from "./useShellRoster";

const ComputerMaintenanceActions = lazyPanel(() =>
  import("../../components/ComputerMaintenanceActions").then((m) => m.ComputerMaintenanceActions),
);

import { ComputersUnavailableHint } from "../../components/ComputersUnavailableHint";

import { screenIframeSandbox } from "../../lib/computer-screen";
import { localTimezone } from "../../lib/local-timezone";
import { parseModelOptionKey } from "../../lib/model-catalog";
import { rpc } from "../../lib/rpc";
import { computerPanelNeedsMaintenance } from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";

import {
  draftFromRoutine,
  emptyRoutineDraft,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "../RoutineList";

const GroupSettings = lazyPanel(() =>
  withFeatureMessages(() => import("../GroupPanel")).then((module) => module.GroupSettings),
);
const BotSettings = lazyPanel(() =>
  withFeatureMessages(() => import("../shell/bot-panel")).then((module) => module.BotSettings),
);
const CreateBotForm = lazyPanel(() =>
  withFeatureMessages(() => import("../shell/bot-panel")).then((module) => module.CreateBotForm),
);
const RoutineEditor = lazyPanel(() =>
  withFeatureMessages(() => import("../RoutineEditor")).then((module) => module.RoutineEditor),
);
const RecruitingPanel = lazyPanel(() =>
  import("../RecruitingPanel").then(
    (module) => (props: ComponentProps<typeof module.RecruitingPanel>) => (
      <module.RecruitingPanel {...props} />
    ),
  ),
);
const RecruitingDetailPanel = lazyPanel(() =>
  withFeatureMessages(() => import("../recruiting/DetailPanel")).then(
    (module) => module.RecruitingDetailPanel,
  ),
);

import type { ReactNode } from "react";
import type { useShellController } from "./useShellController";

export function ShellPanelContent({
  model,
  roleCreationForm,
}: {
  model: ReturnType<typeof useShellController>;
  roleCreationForm: ReactNode;
}) {
  const { t } = useLingui();
  const {
    currentWorkspaceRead,
    navigate,
    userId,
    groups,
    setGroups,
    bots,
    setBots,
    snapshot,
    panel,
    recruitingRefresh,
    setPanel,
    setAgentSkills,
    computer,
    messagingProviders,
    memoryProviderConfig,
    setClearTarget,
    booting,
    bootstrapMe,
    setBootstrapMe,
    showToolActivity,
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
    routineSavePending,
    ensureWebhookSecret,
    routineSaveRequest,
    routineRunPending,
    inGroup,
    active,
    activeGroup,
    activeRoutines,
    activeBotId,
    refreshBots,
    refreshGroupThread,
    refreshThread,
    activeSnapshot,
    crmMode,
    boundRoleCrmMode,
    workspaceFull,
    workspaceBrief,
    activeRecruitingTab,
    changeRecruitingTab,
    recruitingDetail,
    openRoleChat,
    candidateFeedbackRecipients,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    stopRun,
    openSettings,
    createBot,
    openComputer,
    embeddedScreenUrl,
    computerScreenError,
    showingRecoveryHint,
  } = model;
  return (
    <>
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
                            setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev));
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
            <CreateBotForm onCancel={() => setPanel(null)} onCreate={(input) => createBot(input)} />
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
                setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
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
    </>
  );
}
