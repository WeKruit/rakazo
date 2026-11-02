import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode, Group, Me } from "@rakazo/contracts";
import { attachmentsForThread } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { scheduleFocusPrompt } from "../../lib/focus-prompt";
import { revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import type { Panel } from "../../lib/right-panel-state";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { PendingAttachment } from "../shell/Composer";
import type { useShellMessages } from "./useShellMessages";
import { attachmentUploadKey } from "./useShellMessages";
import type { useShellRecruiting } from "./useShellRecruiting";

type RoleCreationAttempt = {
  key: string;
  groupId: string;
  created?: Group;
  clientNonce: string;
  uploads: Map<string, { clientNonce: string; artifactId?: string }>;
};

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
  newRoleSourceId,
  pendingGroupCreations,
  reopenRoleCreation,
  setPendingAttachments,
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
  newRoleSourceId: string | null;
  /** Roles opened before the server created them; thread reads wait on these. */
  pendingGroupCreations: RefObject<Map<string, Promise<Group>>>;
  /** Show the new-role form again, even if the route is still changing. */
  reopenRoleCreation: () => void;
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
}) {
  const { t } = useLingui();
  const [roleCreationError, setRoleCreationError] = useState<string | null>(null);
  // One attempt per submitted role; a retry of the same submission reuses its ids so the
  // server returns the same role and accepts the description once.
  const pendingRoleCreation = useRef<RoleCreationAttempt | null>(null);
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
    const sourceId = newRoleSourceId;
    const sameAccount = () =>
      submittedUser.id === userId &&
      botsRefreshUser.current === submittedUser &&
      (selectedSpaceId() ?? submittedSpace) === submittedSpace;
    if (!discussionScope.current.active || !sameAccount())
      throw new Error(t`The workspace changed. Open the role again.`);
    const key = JSON.stringify([userId, submittedSpace, input, attachments.map((item) => item.id)]);
    const attempt: RoleCreationAttempt =
      pendingRoleCreation.current?.key === key
        ? pendingRoleCreation.current
        : {
            key,
            groupId: crypto.randomUUID(),
            clientNonce: crypto.randomUUID(),
            uploads: new Map(
              attachments.map((pending) => [
                attachmentUploadKey(pending),
                { clientNonce: crypto.randomUUID() },
              ]),
            ),
          };
    pendingRoleCreation.current = attempt;
    const groupId = attempt.groupId;
    const openedFrom = activeGroupId.current;
    const now = new Date().toISOString();
    // The role shows and opens at once; the server catches up behind it.
    const proxy: Group = attempt.created ?? {
      id: groupId,
      spaceId: submittedSpace ?? "",
      name: input.name,
      pinned: false,
      sectionId: null,
      archivedAt: null,
      members: input.botIds.map((botId) => {
        const bot = botsRef.current.find((item) => item.id === botId);
        return { botId, name: bot?.name ?? "", color: bot?.color ?? "" };
      }),
      threadId: "",
      preview: "",
      unread: false,
      updatedAt: now,
      createdAt: now,
    };
    setCreatingGroup(true);
    setRoleCreationError(null);
    setGroups((current) =>
      current.some((item) => item.id === groupId) ? current : [proxy, ...current],
    );
    navigate(`/app/g/${groupId}${input.description ? "?view=brief" : ""}`);
    setPanel(null);
    setNewRoleSourceId(null);
    setNewRoleDescription("");
    const creation = attempt.created
      ? Promise.resolve(attempt.created)
      : rpc.groups.create({ id: groupId, name: input.name, botIds: input.botIds });
    pendingGroupCreations.current.set(groupId, creation);
    void (async () => {
      const group = await creation;
      attempt.created = group;
      if (!sameAccount()) return;
      setGroups((current) => [
        group,
        ...current.filter((item) => item.id !== group.id && item.id !== groupId),
      ]);
      // A server that predates client ids names the role itself; follow it there.
      // The route may not have rendered the proxy yet, so the page it left still counts.
      if (
        group.id !== groupId &&
        (activeGroupId.current === groupId || activeGroupId.current === openedFrom)
      )
        navigate(`/app/g/${group.id}${input.description ? "?view=brief" : ""}`, {
          replace: true,
        });
      if (input.description) {
        const settled = await Promise.allSettled(
          attachments.map(async (pending) => {
            const id = attachmentUploadKey(pending);
            const upload = attempt.uploads.get(id);
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
          const artifactId = attempt.uploads.get(attachmentUploadKey(pending))?.artifactId;
          if (!artifactId) throw new Error(t`Could not upload file`);
          return artifactId;
        });
        if (!sameAccount()) return;
        await rpc.threads.followUp({
          groupId: group.id,
          text: input.description,
          ...(artifactIds.length ? { artifactIds } : {}),
          mentions: [input.botIds[0]!],
          clientNonce: attempt.clientNonce,
        });
      }
      if (pendingRoleCreation.current === attempt) pendingRoleCreation.current = null;
      revokePendingAttachmentPreviews(attachments);
      setPendingAttachments((current) =>
        current.filter((item) => !attachments.some((sent) => sent.id === item.id)),
      );
      await refreshBots().catch(() => undefined);
    })()
      .catch((error: unknown) => {
        if (!sameAccount()) return;
        // Bring the submission back so nothing typed is lost; Continue retries with the same ids.
        if (!attempt.created)
          setGroups((current) => current.filter((item) => item.id !== groupId || item.threadId));
        if (sourceId) setNewRoleSourceId(sourceId);
        setNewRoleDescription(input.description ?? "");
        setRoleCreationError(
          errorText(error, showToolActivity ? t`Could not create group` : t`Could not create role`),
        );
        reopenRoleCreation();
      })
      .finally(() => {
        if (pendingGroupCreations.current.get(groupId) === creation)
          pendingGroupCreations.current.delete(groupId);
        setCreatingGroup(false);
      });
  }

  function startNewRole(sourceId: string, description = "") {
    if (!canCreateRoleFrom(sourceId)) return;
    setRoleCreationError(null);
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

  return { createGroup, startNewRole, restoreGroup, createBot, roleCreationError };
}
