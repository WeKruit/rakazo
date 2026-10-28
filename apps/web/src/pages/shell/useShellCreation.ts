import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode, Group, Me } from "@rakazo/contracts";
import { attachmentsForThread } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import { scheduleFocusPrompt } from "../../lib/focus-prompt";
import type { Panel } from "../../lib/right-panel-state";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { PendingAttachment } from "../shell/Composer";
import type { useShellMessages } from "./useShellMessages";
import { attachmentUploadKey } from "./useShellMessages";
import type { useShellRecruiting } from "./useShellRecruiting";

export function useShellCreation({
  showToolActivity,
  pendingAttachments,
  newRoleAttachmentKey,
  botsRefreshUser,
  bootstrapMe,
  activeGroupId,
  activeBotId,
  discussionScope,
  userId,
  setCreatingGroup,
  setGroups,
  attachmentUploads,
  navigate,
  setPanel,
  setNewRoleSourceId,
  setNewRoleDescription,
  refreshBots,
  canCreateRoleFrom,
  setMobileSidebarOpen,
  setSendError,
  botsRef,
  setBots,
  cancelFocusPrompt,
  focusPromptAbortRef,
  focusPromptBotIdRef,
  sendingRef,
}: {
  showToolActivity: boolean;
  pendingAttachments: PendingAttachment[];
  newRoleAttachmentKey: string;
  botsRefreshUser: RefObject<{ id: string | undefined }>;
  bootstrapMe: Me | null | undefined;
  activeGroupId: RefObject<string | undefined>;
  activeBotId: RefObject<string | undefined>;
  discussionScope: ReturnType<typeof useShellRecruiting>["discussionScope"];
  userId: string | undefined;
  setCreatingGroup: Dispatch<SetStateAction<boolean>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  attachmentUploads: ReturnType<typeof useShellMessages>["attachmentUploads"];
  navigate: NavigateFunction;
  setPanel: (next: Panel | ((current: Panel) => Panel)) => void;
  setNewRoleSourceId: Dispatch<SetStateAction<string | null>>;
  setNewRoleDescription: Dispatch<SetStateAction<string>>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  canCreateRoleFrom: (id: string) => boolean;
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setSendError: Dispatch<SetStateAction<string | null>>;
  botsRef: RefObject<Bot[]>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  cancelFocusPrompt: () => void;
  focusPromptAbortRef: RefObject<AbortController | null>;
  focusPromptBotIdRef: RefObject<string | null>;
  sendingRef: RefObject<boolean>;
}) {
  const { t } = useLingui();
  const pendingRoleCreation = useRef<{
    key: string;
    group: Group;
    clientNonce: string;
    uploads: Map<string, { clientNonce: string; artifactId?: string }>;
  } | null>(null);
  async function createGroup(input: { name: string; botIds: string[]; description?: string }) {
    const attachments = showToolActivity
      ? []
      : attachmentsForThread(pendingAttachments, newRoleAttachmentKey);
    if (attachments.length && !input.description)
      input = {
        ...input,
        description: t`Use the attached files to define this role and start the search.`,
      };
    const submittedUser = botsRefreshUser.current;
    const submittedSpace = bootstrapMe?.spaceId;
    const submittedTarget = activeGroupId.current ?? activeBotId.current;
    const stillCurrent = () =>
      discussionScope.current.active &&
      discussionScope.current.panel === "create-group" &&
      submittedUser.id === userId &&
      botsRefreshUser.current === submittedUser &&
      (activeGroupId.current ?? activeBotId.current) === submittedTarget &&
      (selectedSpaceId() ?? submittedSpace) === submittedSpace;

    setCreatingGroup(true);
    try {
      const key = JSON.stringify([
        userId,
        bootstrapMe?.spaceId,
        input,
        attachments.map((item) => item.id),
      ]);
      let attempt =
        input.description && pendingRoleCreation.current?.key === key
          ? pendingRoleCreation.current
          : null;
      const group =
        attempt?.group ?? (await rpc.groups.create({ name: input.name, botIds: input.botIds }));
      if (input.description && !attempt) {
        attempt = {
          key,
          group,
          clientNonce: crypto.randomUUID(),
          uploads: new Map(
            attachments.map((pending) => [
              attachmentUploadKey(pending),
              { clientNonce: crypto.randomUUID() },
            ]),
          ),
        };
        pendingRoleCreation.current = attempt;
      }
      if (!stillCurrent()) throw new Error(t`The workspace changed. Open the role again.`);
      setGroups((current) =>
        current.some((item) => item.id === group.id) ? current : [group, ...current],
      );
      if (input.description && attempt) {
        const currentAttempt = attempt;
        const settled = await Promise.allSettled(
          attachments.map(async (pending) => {
            const id = attachmentUploadKey(pending);
            const upload = currentAttempt.uploads.get(id);
            if (!upload) throw new Error(t`The workspace changed. Open the role again.`);
            if (upload.artifactId) return;
            upload.artifactId = await attachmentUploads.current.resolveOne(
              { id, file: pending.file },
              { groupId: group.id },
              { clientNonce: upload.clientNonce },
            );
            attachmentUploads.current.discard(id);
          }),
        );
        const failed = settled.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
        const artifactIds = attachments.map((pending) => {
          const artifactId = currentAttempt.uploads.get(attachmentUploadKey(pending))?.artifactId;
          if (!artifactId) throw new Error(t`Could not upload file`);
          return artifactId;
        });
        if (!stillCurrent()) throw new Error(t`The workspace changed. Open the role again.`);
        await rpc.threads.followUp({
          groupId: group.id,
          text: input.description,
          ...(artifactIds.length ? { artifactIds } : {}),
          mentions: [input.botIds[0]!],
          clientNonce: currentAttempt.clientNonce,
        });
        pendingRoleCreation.current = null;
      }
      if (!stillCurrent()) return;
      navigate(`/app/g/${group.id}${input.description ? "?view=brief" : ""}`);
      setPanel(null);
      setNewRoleSourceId(null);
      setNewRoleDescription("");
      await refreshBots().catch(() => undefined);
    } finally {
      setCreatingGroup(false);
    }
  }

  function startNewRole(sourceId: string, description = "") {
    if (!canCreateRoleFrom(sourceId)) return;
    setNewRoleSourceId(sourceId);
    setNewRoleDescription(description);
    setPanel("create-group");
    setMobileSidebarOpen(false);
  }

  function restoreGroup(groupId: string) {
    return rpc.groups
      .restore({ groupId })
      .then(() => refreshBots(true))
      .catch((error) => setSendError(errorText(error, t`Could not continue`)));
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const { normalizeCreateBotProfile } = await import("./shell-action-validation");
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      shouldSkip: () => sendingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  return { createGroup, startNewRole, restoreGroup, createBot };
}
