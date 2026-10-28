import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import { ATTACHMENT_ALLOWED_MIME_TYPES } from "@rakazo/contracts";
import type { ComposerMention, SlashActionId } from "@rakazo/core";
import {
  clampMentionHighlightIndex,
  mentionChipKey,
  replyAttachment,
  resolveMentionPickerKey,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import {
  ArrowUp,
  Box,
  Clock,
  Mic,
  Paperclip,
  Plus,
  Puzzle,
  Settings,
  Square,
  X,
} from "lucide-react";
import type { ClipboardEvent, DragEvent, Ref, RefObject } from "react";
import {
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { newClientId } from "../../lib/client-id";
import {
  beginComposerDraftSubmission,
  readComposerDraft,
  settleComposerDraftSubmission,
  subscribeComposerDraftAccepted,
  writeComposerDraft,
} from "../../lib/composer-draft";
import { previewMessageText } from "../../lib/message-text";
import { isFileDrag, isFilePaste } from "../../lib/pending-attachments";
import type { CandidateDiscussionContext } from "../RecruitingPanel";
import { ComposerReplyPreview } from "../shell/chat-context";
import { FALLBACK_BOT_COLOR } from "./constants";

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

export const ATTACHMENT_ACCEPT = [...ATTACHMENT_ALLOWED_MIME_TYPES, ".zip"].join(",");
export function candidateReferenceText(candidate: CandidateDiscussionContext): string {
  const reference = [
    t`Name: ${candidate.name ?? t`Name missing`}`,
    t`Role: ${candidate.roleTitle}`,
    ...(candidate.roleVersion === undefined ? [] : [t`Role version: ${candidate.roleVersion}`]),
    ...(candidate.title ? [t`Title: ${candidate.title}`] : []),
    ...(candidate.company ? [t`Company: ${candidate.company}`] : []),
    t`LinkedIn: ${candidate.linkedinUrl ?? t`LinkedIn missing`}`,
    t`Resume: ${candidate.resumeUrl ?? t`Resume missing`}`,
  ].join("\n");
  return `${t`Candidate reference`}\n${reference.replace(/(^|\r\n|[\r\n\u2028\u2029])/g, "$1> ")}\n\n`;
}

export type ComposerHandle = {
  insertContext: (context: { draftKey: string; text: string }) => void;
};

export const Composer = memo(function Composer({
  ref,
  artifactTarget,
  activeName,
  compact = false,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  onRetry,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  onVoice,
  replyTarget,
  replyQuote,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
  draftKey,
  contextKey,
  enterToSend,
}: {
  ref?: Ref<ComposerHandle>;
  activeName?: string;
  compact?: boolean;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  /** Sends a new turn after a failed run, so the fix is one tap. */
  onRetry?: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => boolean;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions: ComposerMention[], clientNonce: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onVoice?: () => void;
  artifactTarget: ArtifactTarget;
  replyTarget?: ThreadMessage | null;
  replyQuote?: string | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
  draftKey: string;
  contextKey?: string;
  enterToSend: boolean;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => readComposerDraft(draftKey));
  const [mentionQuery, setMentionQuery] = useState<string | null>(() => {
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(draft);
    return mentionMatch ? (mentionMatch[1] ?? "") : null;
  });
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(() => {
    const slashMatch = /^\/([^\n]*)$/.exec(draft);
    return slashMatch ? (slashMatch[1] ?? "") : null;
  });
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const editRevision = useRef(0);
  useEffect(
    () =>
      subscribeComposerDraftAccepted(draftKey, (text) => {
        setDraft((current) => (current === text ? "" : current));
        setMentionQuery(null);
        setSlashQuery(null);
      }),
    [draftKey],
  );
  const retryNonce = useRef<{ nonce: string; contextKey?: string } | null>(null);
  const replyId = replyTarget?.id ?? null;
  const quote = replyTarget ? (replyQuote ?? null) : null;
  const previousReply = useRef({ id: replyId, quote });
  useEffect(() => {
    if (previousReply.current.id !== replyId || previousReply.current.quote !== quote) {
      editRevision.current += 1;
      retryNonce.current = null;
      previousReply.current = { id: replyId, quote };
    }
  }, [replyId, quote]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [replyAnnouncement, setReplyAnnouncement] = useState("");
  // What the live region currently holds — a send disarming the reply clears
  // "reply" text, while an explicit cancel must keep "Reply cancelled".
  const replyAnnouncementKind = useRef<"reply" | "cancelled" | null>(null);
  const prevReplyTarget = useRef<ThreadMessage | null>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend =
    draft.trim().length > 0 ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    pendingAttachments.length > 0;

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = `${measureTextareaHeight(textarea)}px`;
    }

    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);

  function markEdited() {
    editRevision.current += 1;
    retryNonce.current = null;
  }

  function pickAttachments(files: FileList | null) {
    if (!files?.length) return;
    if (onAttachmentPick(files)) markEdited();
  }

  function updateDraft(value: string) {
    markEdited();
    writeComposerDraft(draftKey, value);
    setDraft(value);
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function focusComposer() {
    textareaRef.current?.focus();
  }

  const contextHandle = useRef<ComposerHandle | null>(null);
  useImperativeHandle(ref, () => {
    const handle: ComposerHandle = {
      insertContext: ({ draftKey: target, text }) => {
        const textarea = textareaRef.current;
        if (contextHandle.current !== handle || target !== draftKey || !textarea || !text.trim())
          return;
        const next = `${draft}${draft ? "\n\n" : ""}${text}`;
        updateDraft(next);
        const revision = editRevision.current;
        focusComposer();
        let interrupted = false;
        const interrupt = () => {
          interrupted = true;
        };
        const interactions = ["blur", "pointerdown", "keydown"] as const;
        for (const event of interactions)
          textarea.addEventListener(event, interrupt, { once: true });
        window.requestAnimationFrame(() => {
          for (const event of interactions) textarea.removeEventListener(event, interrupt);
          if (
            interrupted ||
            textareaRef.current !== textarea ||
            textarea.value !== next ||
            document.activeElement !== textarea ||
            editRevision.current !== revision
          )
            return;
          textarea.setSelectionRange(next.length, next.length);
          textarea.scrollTop = textarea.scrollHeight;
        });
      },
    };
    contextHandle.current = handle;
    return handle;
  });

  function insertMention(mention: ComposerMention) {
    markEdited();
    const next = draft.replace(/@([\w-]*)$/, "");
    writeComposerDraft(draftKey, next);
    setDraft(next);
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    focusComposer();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    markEdited();
    setSelectedSkill(skill);
    writeComposerDraft(draftKey, "");
    setDraft("");
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    markEdited();
    writeComposerDraft(draftKey, "");
    setDraft("");
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeLastChip() {
    markEdited();
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (!onSlashAction) return [];
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery, onSlashAction]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  async function send() {
    if (!canSend || sending || disabled) return;
    const revision = editRevision.current;
    const clientNonce =
      retryNonce.current?.contextKey === contextKey
        ? (retryNonce.current?.nonce ?? newClientNonce())
        : newClientNonce();
    retryNonce.current = null;
    const text = serializeComposerPrompt(draft, selectedSkill, selectedMentions);
    const submission = beginComposerDraftSubmission(draftKey, draft);
    setDraft("");
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSlashQuery(null);
    setSelectedSkill(null);
    const mentions = selectedMentions;
    setSelectedMentions([]);
    try {
      const accepted = (await onSend(text, mentions, clientNonce)) !== false;
      settleComposerDraftSubmission(draftKey, submission, accepted);
      if (accepted) return;
    } catch {
      settleComposerDraftSubmission(draftKey, submission, false);
      // A rejected callback leaves acceptance unknown; do not restore a possible send.
      return;
    }
    // Restore only an untouched draft, retaining its nonce for an unchanged retry.
    if (editRevision.current !== revision) return;
    retryNonce.current = { nonce: clientNonce, contextKey };
    setDraft(draft);
    setSelectedSkill(selectedSkill);
    setSelectedMentions(mentions);
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) pickAttachments(dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    if (disabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    pickAttachments(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    const caret = start + text.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder =
    draft.length === 0 && selectedSkill === null && selectedMentions.length === 0;
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";
  const replyNameRef = useRef(replyName);
  replyNameRef.current = replyName;
  const announceTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Arming or retargeting a reply unmounts the control that started it, so
  // focus would drop to <body>; announce on start and when the target changes.
  // The timer lives in a ref: a same-id rerender (e.g. the display name
  // resolving after arming) must not cancel the pending announcement.
  useEffect(() => {
    const prev = prevReplyTarget.current;
    prevReplyTarget.current = replyTarget ?? null;
    if (!replyTarget) {
      // Cancel (or send) within the delay must not let a stale "Replying to"
      // overwrite the cancel announcement — kill the pending timer.
      window.clearTimeout(announceTimer.current);
      // A send disarms the reply without touching the region — drop the stale
      // "Replying to" so it cannot linger or re-announce. An explicit cancel
      // sets "Reply cancelled" in the same event, so only clear "reply" text.
      if (replyAnnouncementKind.current === "reply") {
        replyAnnouncementKind.current = null;
        setReplyAnnouncement("");
      }
      return;
    }
    if (!prev || prev.id !== replyTarget.id) {
      textareaRef.current?.focus();
      // Clear-then-set so a switch between same-author targets re-announces —
      // identical live-region text would otherwise be a no-op.
      setReplyAnnouncement("");
      replyAnnouncementKind.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        replyAnnouncementKind.current = "reply";
        setReplyAnnouncement(t`Replying to ${replyNameRef.current}`);
      }, 50);
    }
  }, [replyTarget, replyName, t]);

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`chat-composer relative z-30 m-0 min-w-0 border-0 px-3 pb-4 pt-3 md:px-6 md:pb-6 ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-ring" : ""
      }`}
    >
      <div role="status" data-testid="composer-announcement" className="sr-only">
        {replyAnnouncement}
      </div>
      {sendError || runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-[14px] border border-destructive/40 bg-destructive/10 px-4 py-2 text-[13px] text-destructive"
        >
          <span className="min-w-0 flex-1">{sendError ?? runError}</span>
          {!sendError && onRetry ? (
            <button
              type="button"
              data-testid="composer-error-retry"
              onClick={onRetry}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              {t`Try again`}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={() => {
              onDismissError();
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="shrink-0 text-destructive hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <ComposerReplyPreview
          author={replyName}
          text={previewMessageText(replyTarget)}
          quote={replyQuote}
          attachment={replyAttachment(replyTarget.blocks)}
          target={artifactTarget}
          onDismiss={() => {
            replyAnnouncementKind.current = "cancelled";
            window.clearTimeout(announceTimer.current);
            onClearReply?.();
            setReplyAnnouncement(t`Reply cancelled`);
            textareaRef.current?.focus();
          }}
        />
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-[14px] border border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning">
          {attachmentNotice}
        </div>
      ) : null}
      {pendingAttachments.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
              <span className="max-w-[180px] truncate" dir="auto">
                {attachment.file.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove ${attachment.file.name}`}
                onClick={() => {
                  markEdited();
                  onRemoveAttachment(attachment);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {mentionPickerOpen ? (
        <div
          id={mentionListboxId}
          role="listbox"
          aria-label={t`Mentions`}
          data-testid="mention-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
        >
          {mentionOptions.map((mention, index) => {
            const optionId = `${mentionListboxId}-option-${index}`;
            const highlighted = index === activeMentionIndex;
            return (
              <button
                id={optionId}
                key={mentionChipKey(mention)}
                type="button"
                role="option"
                aria-selected={highlighted}
                aria-label={t`@${mention.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(mention)}
                // Opening the list under a stationary pointer must not steal the keyboard highlight.
                onMouseMove={() => setMentionHighlightIndex(index)}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
                  highlighted ? "bg-accent" : ""
                }`}
              >
                <MentionOptionIcon mention={mention} />
                <span className="min-w-0">
                  <span dir="auto" className="block text-[14px] text-foreground">
                    @{mention.name}
                  </span>
                  {mention.subtitle ? (
                    <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                      {mention.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showSlashPicker ? (
        <div
          data-testid="slash-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
        >
          {slashSkillOptions.map((skill) => (
            <button
              key={skill.id}
              type="button"
              aria-label={t`Skill ${skill.name}`}
              onClick={() => insertSkill(skill)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
            >
              <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span dir="auto" className="block text-[14px] text-foreground">
                  {skill.name}
                </span>
                <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                  {truncateSlashDescription(skill.description)}
                </span>
              </span>
            </button>
          ))}
          {slashActionOptions.map((action) => {
            const label = slashActionLabel(action.id);
            return (
              <button
                key={action.id}
                type="button"
                aria-label={label}
                onClick={() => runSlashAction(action.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
              >
                <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
                <span className="text-[14px] text-foreground">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        data-testid="composer-bar"
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] content-end items-center gap-x-2 gap-y-2 rounded-[26px] border border-border bg-background pb-[9px] pe-2.5 ps-3 pt-3 transition-colors focus-within:border-ring"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(event) => pickAttachments(event.target.files)}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Attach file`}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="composer-attach col-start-1 row-start-2 size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus size={16} strokeWidth={2} />
        </Button>
        <div className="composer-input col-span-3 row-start-1 flex min-w-0 flex-wrap items-end gap-1.5 px-1.5">
          {selectedSkill ? (
            <span
              data-testid="skill-chip"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] text-foreground"
            >
              <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
              <span dir="auto" className="truncate">
                {selectedSkill.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove skill ${selectedSkill.name}`}
                onClick={() => {
                  markEdited();
                  setSelectedSkill(null);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ) : null}
          {selectedMentions.map((mention) => (
            <span
              key={mentionChipKey(mention)}
              data-testid="mention-chip"
              data-mention-kind={mention.kind}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] text-foreground"
            >
              <MentionChipIcon mention={mention} />
              <span dir="auto" className="truncate">
                {mention.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove mention ${mention.name}`}
                onClick={() => {
                  markEdited();
                  setSelectedMentions((current) =>
                    current.filter(
                      (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                    ),
                  );
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                draft.length === 0 &&
                (selectedSkill !== null || selectedMentions.length > 0)
              ) {
                event.preventDefault();
                removeLastChip();
                return;
              }
              const action = resolveMentionPickerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                enterToSend,
                isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                optionCount: mentionOptions.length,
                highlightedIndex: activeMentionIndex,
              });
              if (action.type === "complete") {
                const mention = mentionOptions[action.index];
                if (!mention) return;
                event.preventDefault();
                insertMention(mention);
                return;
              }
              if (action.type === "move") {
                event.preventDefault();
                setMentionHighlightIndex(action.index);
                return;
              }
              if (action.type === "dismiss") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionHighlightIndex(0);
                return;
              }
              if (action.type === "send") {
                event.preventDefault();
                void send();
              }
            }}
            disabled={disabled}
            placeholder={
              showComposerPlaceholder
                ? activeName && !compact
                  ? t`Message ${activeName}`
                  : t`Message…`
                : undefined
            }
            aria-label={activeName ? t`Message ${activeName}` : t`Message`}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={mentionPickerOpen}
            aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
            aria-activedescendant={activeMentionOptionId}
            name="chat-message"
            autoComplete="off"
            dir="auto"
            rows={compact ? 1 : 2}
            className={`rk-scroll max-h-60 ${compact ? "min-h-7" : "min-h-12"} min-w-[8rem] flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40`}
          />
        </div>
        <div className="composer-actions col-start-3 row-start-2 flex shrink-0 items-center gap-2 justify-self-end">
          {onVoice && draft.trim().length === 0 ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={t`Voice`}
              title={t`Voice`}
              disabled={disabled}
              onClick={onVoice}
              className="composer-secondary size-8 shrink-0 rounded-full text-foreground/75"
            >
              <Mic size={16} strokeWidth={1.8} />
            </Button>
          ) : null}
          {running ? (
            <>
              <Button
                size="icon"
                aria-label={t`Send`}
                disabled={sending || !canSend || disabled}
                onClick={send}
                className="size-8 rounded-full bg-white text-black hover:bg-white/90 shadow-sm transition-transform active:scale-95"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={t`Stop`}
                disabled={sending}
                onClick={() => void onStop()}
                className="composer-secondary size-8 rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
              >
                <Square size={11} strokeWidth={0} fill="currentColor" />
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              aria-label={t`Send`}
              disabled={sending || !canSend || disabled}
              onClick={send}
              className="size-8 shrink-0 rounded-full bg-white text-black hover:bg-white/90 shadow-sm transition-transform active:scale-95 disabled:bg-white/10 disabled:text-muted-foreground/30 disabled:shadow-none"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </Button>
          )}
        </div>
      </div>
    </fieldset>
  );
});

/** Hides the scrollbar while measuring and leaves the height at 0. */
function measureTextareaHeight(textarea: HTMLTextAreaElement) {
  const { style } = textarea;
  style.overflowY = "hidden";
  style.height = "0px";
  const height = textarea.scrollHeight;
  style.overflowY = "";
  return height;
}

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}

function newClientNonce(): string {
  return newClientId();
}
