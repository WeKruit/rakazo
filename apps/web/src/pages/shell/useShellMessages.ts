import { useLingui } from "@lingui/react/macro";
import type {
  AskAnswer,
  Bot,
  Me,
  MessageReaction,
  RecruitingCorrespondenceReference,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  addPendingUserMessage,
  answerableAskMessageIds,
  attachmentsForThread,
  inferAttachmentMimeType,
  isXlsxFileName,
  pendingUserMessageId,
  removePendingUserMessage,
  resolveComposerSendPlan,
  retrySend,
} from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { newClientId } from "../../lib/client-id";
import {
  createAttachmentUploads,
  revokePendingAttachmentPreviews,
} from "../../lib/pending-attachments";
import type { Panel } from "../../lib/right-panel-state";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { applyThreadSendReceipt } from "../../lib/thread-events";
import { turnTimer } from "../../lib/turn-timing";
import { errorText } from "../../lib/user-error";
import type { ComposerHandle, PendingAttachment } from "../shell/Composer";
import type { RecruitingChatContact } from "../shell/recruiting-chat-context";
import { recruitingChatContext } from "../shell/recruiting-chat-context";

/** How long a sent message may wait for its durable event before the thread is re-read. */
const SEND_ECHO_GRACE_MS = 3_000;

export function attachmentUploadKey(attachment: Pick<PendingAttachment, "id" | "threadKey">) {
  return `${attachment.threadKey}:${attachment.id}`;
}

export function useShellMessages({
  navigate,
  loadOlderMessagesRef,
  jumpGeneration,
  setScrollRequest,
  activeGroupId,
  jumpToMessageRef,
  activeBotId,
  snapshotRef,
  validatedThreadEpoch,
  historyEpoch,
  refreshGroupThreadRef,
  refreshThreadRef,
  setSendError,
  pendingAttachments,
  setPendingAttachments,
  setAttachmentNotice,
  fileInputRef,
  sending,
  composerRef,
  botsRefreshUser,
  selectedCorrespondence,
  chatRoleTitle,
  selectedContact,
  currentRecruitingCacheScope,
  selectedSchedulingPlan,
  knownThreadId,
  currentCorrespondenceScope,
  discussionScope,
  botsRef,
  flushPendingBrowserNotifications,
  sendingRef,
  setSending,
  updateSnapshot,
  activeReplyTarget,
  activeReplyQuote,
  focusPromptBotIdRef,
  cancelFocusPrompt,
  clearReply,
  bootstrapMe,
  showToolActivity,
  terminalRunReceipts,
  refreshBots,
}: {
  navigate: NavigateFunction;
  loadOlderMessagesRef: RefObject<() => Promise<void>>;
  jumpGeneration: RefObject<number>;
  setScrollRequest: Dispatch<SetStateAction<{ messageId: string; nonce: number } | null>>;
  activeGroupId: RefObject<string | undefined>;
  jumpToMessageRef: RefObject<
    (target: { botId?: string; groupId?: string; messageId: string }) => Promise<void>
  >;
  activeBotId: RefObject<string | undefined>;
  snapshotRef: RefObject<ThreadSnapshot | null>;
  validatedThreadEpoch: RefObject<number | null>;
  historyEpoch: RefObject<number>;
  refreshGroupThreadRef: RefObject<
    (id: string, signal?: AbortSignal, opening?: boolean) => Promise<ThreadSnapshot>
  >;
  refreshThreadRef: RefObject<
    (id: string, signal?: AbortSignal, opening?: boolean) => Promise<ThreadSnapshot>
  >;
  setSendError: Dispatch<SetStateAction<string | null>>;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  setAttachmentNotice: Dispatch<SetStateAction<string | null>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sending: boolean;
  composerRef: RefObject<ComposerHandle | null>;
  botsRefreshUser: RefObject<{ id: string | undefined }>;
  selectedCorrespondence: { scope: object; reference: RecruitingCorrespondenceReference } | null;
  chatRoleTitle: string | undefined;
  selectedContact: { scope: string | undefined; contact: RecruitingChatContact } | null;
  currentRecruitingCacheScope: RefObject<string | undefined>;
  selectedSchedulingPlan: {
    scope: string | undefined;
    threadId: string;
    emailId: string;
    id: string;
  } | null;
  knownThreadId: string | undefined;
  currentCorrespondenceScope: RefObject<object>;
  discussionScope: RefObject<{
    composerRef: RefObject<ComposerHandle | null>;
    panel: Panel;
    workspaceCandidates: boolean;
    active: boolean;
    candidateFeedbackRecipients: { id: string; name: string }[] | undefined;
  }>;
  botsRef: RefObject<Bot[]>;
  flushPendingBrowserNotifications: () => void;
  sendingRef: RefObject<boolean>;
  setSending: Dispatch<SetStateAction<boolean>>;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  activeReplyTarget: ThreadMessage | null;
  activeReplyQuote: string | null;
  focusPromptBotIdRef: RefObject<string | null>;
  cancelFocusPrompt: () => void;
  clearReply: () => void;
  bootstrapMe: Me | null | undefined;
  showToolActivity: boolean;
  terminalRunReceipts: RefObject<Set<string>>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
}) {
  const { t } = useLingui();
  const mounted = useRef(false);
  const echoTimers = useRef(new Set<number>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of echoTimers.current) window.clearTimeout(timer);
      echoTimers.current.clear();
    };
  }, []);
  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (existing) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId }).catch(() => undefined);
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId }).catch(() => undefined);
  }, []);
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: AskAnswer, username?: string) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      const current = snapshotRef.current;
      if (
        validatedThreadEpoch.current !== historyEpoch.current ||
        !current ||
        current.threadId !== message.threadId ||
        (groupId ? current.groupId !== groupId : current.botId !== botId) ||
        !answerableAskMessageIds(current).includes(message.id) ||
        !current.messages.some((item) => item.id === message.id && item.runId === message.runId)
      )
        return;
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(username ? { username } : {}),
      });
      if (groupId && activeGroupId.current === groupId) {
        await refreshGroupThreadRef.current(groupId);
      } else if (botId && activeBotId.current === botId) {
        await refreshThreadRef.current(botId);
      }
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  // A message sent while a reply works waits as steering; this edits, removes or sends it now.
  const changeQueuedMessage = useCallback(
    async (
      messageId: string,
      change: { action: "edit"; text: string } | { action: "remove" } | { action: "send_now" },
    ) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      const stillHere = () =>
        groupId ? activeGroupId.current === groupId : activeBotId.current === botId;
      try {
        await rpc.threads.updateQueued({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId,
          change,
        });
      } catch (error) {
        if (!stillHere()) return;
        // The reply already took it in: re-read so it shows where it went.
        if (isConflict(error)) {
          if (groupId) await refreshGroupThreadRef.current(groupId).catch(() => undefined);
          else await refreshThreadRef.current(botId!).catch(() => undefined);
          return;
        }
        setSendError(errorText(error, t`Could not update message`));
        throw error;
      }
    },
    [t],
  );
  const attachmentUploads = useRef(
    createAttachmentUploads(async (file, contentBase64, target, options) => {
      const mimeType = inferAttachmentMimeType(file.name, file.type);
      if (!mimeType)
        throw new Error(
          isXlsxFileName(file.name)
            ? t`XLSX is not supported yet. Save as CSV and upload again.`
            : t`Unsupported file type: ${file.name}`,
        );
      const artifact = await rpc.artifacts.create({
        ...target,
        name: file.name,
        mimeType,
        contentBase64,
        ...(options?.clientNonce ? { clientNonce: options.clientNonce } : {}),
      });
      return artifact.id;
    }),
  );
  const onAttachmentPick = useCallback(
    (files: FileList | null, threadKey = activeGroupId.current ?? activeBotId.current) => {
      if (!threadKey || !files?.length) return false;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(
            isXlsxFileName(file.name)
              ? t`${file.name} (XLSX is not supported yet. Save as CSV and upload again.)`
              : file.name,
          );
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      for (const item of next)
        attachmentUploads.current.start(attachmentUploadKey(item), item.file);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return next.length > 0;
    },
    [pendingAttachments, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    attachmentUploads.current.discard(attachmentUploadKey(attachment));
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) =>
      current.filter(
        (item) => item.id !== attachment.id || item.threadKey !== attachment.threadKey,
      ),
    );
  }, []);
  const sendMessage = useCallback(
    async (
      text: string,
      mentions: ComposerMention[],
      clientNonce: string,
      queueMode?: "steer" | "follow_up",
      retry = false,
    ) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return false;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = retry ? [] : attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      const submittedComposer = composerRef;
      const submittedUser = botsRefreshUser.current;
      const selectedEmail = selectedCorrespondence;
      const recruitingContext =
        retry || reroutedToGroup
          ? undefined
          : recruitingChatContext(
              chatRoleTitle,
              selectedContact?.scope === currentRecruitingCacheScope.current
                ? selectedContact?.contact
                : undefined,
              selectedSchedulingPlan &&
                selectedSchedulingPlan.scope === currentRecruitingCacheScope.current &&
                selectedSchedulingPlan.threadId === knownThreadId
                ? selectedSchedulingPlan.id
                : undefined,
            );
      const correspondenceReference =
        !retry &&
        !reroutedToGroup &&
        selectedEmail?.scope === currentCorrespondenceScope.current &&
        discussionScope.current.active
          ? selectedEmail.reference
          : undefined;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      // Echo the message right away; the durable message.created event replaces it.
      const echoed = plan.shouldSend && !reroutedToGroup && Boolean(trimmed);
      if (echoed) {
        turnTimer.submit(clientNonce);
        updateSnapshot(
          (current) =>
            current &&
            addPendingUserMessage(current, {
              clientNonce,
              text: trimmed,
              createdAt: new Date().toISOString(),
              replyToMessageId: retry ? undefined : activeReplyTarget?.id,
              replyQuote: retry ? undefined : (activeReplyQuote ?? undefined),
            }),
        );
        requestAnimationFrame(() => turnTimer.echoed(clientNonce));
      }
      const withdrawEcho = () => {
        if (!echoed) return;
        turnTimer.failed(clientNonce);
        updateSnapshot((current) => current && removePendingUserMessage(current, clientNonce));
      };
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      // Keep the draft cleared once any part of the submission is confirmed accepted.
      let accepted = false;
      try {
        if (plan.shouldRunRoutines) {
          // Settle every run first so one that was accepted is never repeated.
          const runs = await Promise.allSettled(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${clientNonce}:${routineId}`,
              }),
            ),
          );
          accepted = runs.some((run) => run.status === "fulfilled");
          for (const run of runs) if (run.status === "rejected") throw run.reason;
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return true;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return true;
        }
        // Files were read when picked; upload them together instead of one by one.
        const artifactIds = await attachmentUploads.current.resolve(
          attachments.map((pending) => ({ id: attachmentUploadKey(pending), file: pending.file })),
          groupTarget ? { groupId: groupTarget } : { botId: botTarget! },
        );
        const stillSubmitted = () =>
          discussionScope.current.active &&
          (selectedSpaceId() ?? bootstrapMe?.spaceId) === bootstrapMe?.spaceId &&
          botsRefreshUser.current === submittedUser &&
          discussionScope.current.composerRef === submittedComposer &&
          (!correspondenceReference || currentCorrespondenceScope.current === selectedEmail?.scope);
        if (!stillSubmitted()) {
          withdrawEcho();
          return false;
        }
        if (groupTarget) {
          // A network failure retries the same send (same nonce) before the draft comes back.
          const sent = await retrySend(
            () =>
              rpc.threads.send({
                groupId: groupTarget,
                ...(queueMode ? { queueMode } : {}),
                addressing: showToolActivity ? undefined : "coordinator",
                clientNonce,
                text: trimmed || undefined,
                ...(correspondenceReference ? { correspondenceReference } : {}),
                ...(recruitingContext ? { recruitingContext } : {}),
                mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
                artifactIds: artifactIds.length ? artifactIds : undefined,
                replyToMessageId: retry || reroutedToGroup ? undefined : activeReplyTarget?.id,
                replyQuote: retry || reroutedToGroup ? undefined : (activeReplyQuote ?? undefined),
              }),
            { keepTrying: stillSubmitted },
          );
          accepted = true;
          if (echoed) turnTimer.accepted(clientNonce, sent.runId);
        } else if (botTarget) {
          const sent = await retrySend(
            () =>
              rpc.threads.send({
                botId: botTarget,
                ...(queueMode ? { queueMode } : {}),
                clientNonce,
                text: trimmed || undefined,
                ...(correspondenceReference ? { correspondenceReference } : {}),
                ...(recruitingContext ? { recruitingContext } : {}),
                mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
                artifactIds: artifactIds.length ? artifactIds : undefined,
                replyToMessageId: retry ? undefined : activeReplyTarget?.id,
                replyQuote: retry ? undefined : (activeReplyQuote ?? undefined),
              }),
            { keepTrying: stillSubmitted },
          );
          accepted = true;
          if (echoed) turnTimer.accepted(clientNonce, sent.runId);
          if (activeBotId.current === botTarget) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                {
                  botId: botTarget,
                  runId: sent.runId,
                  taskId: sent.taskId,
                },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        dropDelayedSetup();
        if (!retry) {
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
        }
        if (reroutedToGroup && groupTarget) {
          // The group's sidebar row changes too; the open thread's events cannot say so.
          void refreshBots().catch(() => undefined);
          navigate(`/app/g/${groupTarget}`);
          return true;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        // The receipt and the event stream carry the rest. Read only if no event or echo
        // arrived in time (stream down), or the message carried no text to echo.
        if (!mounted.current) return true;
        const echoTimer = window.setTimeout(() => {
          echoTimers.current.delete(echoTimer);
          const current = snapshotRef.current;
          const stillEchoed = current?.messages.some(
            (message) => message.id === pendingUserMessageId(clientNonce),
          );
          if (!echoed || !stillEchoed) return;
          if (groupTarget && activeGroupId.current === groupTarget)
            void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
          else if (botTarget && activeBotId.current === botTarget)
            void refreshThreadRef.current(botTarget).catch(() => undefined);
        }, SEND_ECHO_GRACE_MS);
        echoTimers.current.add(echoTimer);
        return true;
      } catch (error) {
        if (!accepted) withdrawEcho();
        if (reroutedToGroup && groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        }
        return accepted;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      activeReplyQuote,
      clearReply,
      composerRef,
      bootstrapMe?.spaceId,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      selectedCorrespondence,
      selectedSchedulingPlan,
      knownThreadId,
      selectedContact,
      chatRoleTitle,
      showToolActivity,
      t,
    ],
  );

  return {
    openBot,
    loadOlder,
    jumpToReplyMessage,
    answerMessage,
    reactToMessage,
    changeQueuedMessage,
    attachmentUploads,
    onAttachmentPick,
    removeAttachment,
    sendMessage,
  };
}

function isConflict(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "CONFLICT"
  );
}
