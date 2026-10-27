import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { AskAnswer, MessageReaction, ThreadMessage } from "@rakazo/contracts";
import type { ThreadTailPhase, WorkTracker } from "@rakazo/core";
import {
  EMPTY_WORK_TRACKER,
  formatMessageTime,
  groupVoiceChats,
  isPeerReceiptBlocks,
  isToolActivityBlock,
  projectMessageReactions,
  timeSeparatorIds,
  trackWork,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { cn } from "@rakazo/ui-web";
import { ArrowDown, TextQuote } from "lucide-react";
import type { RefObject } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import { LoadingState, Shimmer } from "../../components/ai/primitives";
import { VoiceChatCard } from "../../components/call/VoiceChatCard";
import { lazyPanel } from "../../components/ErrorBoundary";
import { withFeatureMessages } from "../../lib/i18n";

const LiveWork = lazyPanel(
  () => withFeatureMessages(() => import("../../components/LiveWork")).then((m) => m.LiveWork),
  ({ live, label }) =>
    live ? (
      <LoadingState
        label={label}
        indicator={
          <span aria-hidden>
            <Shimmer>{label}</Shimmer>
          </span>
        }
      />
    ) : undefined,
);

import type { ArtifactTarget } from "../../lib/artifact-open";
import { quoteDraftForSelection } from "../../lib/quote-selection";
import { isRunPhase, rosterWorkStatusLabel, threadTailLabel } from "../../lib/roster-status";
import { messageHasVisibleBlocks } from "../../lib/tool-activity-view";
import { transcriptIsNearEnd, transcriptMovedDown } from "../../lib/transcript-scroll";
import { TimeSeparator } from "./chat-context";
import { TranscriptWindow } from "./TranscriptWindow";

const MessageHoverActions = lazyPanel(() =>
  import("../ShellMessage").then((module) => module.MessageHoverActions),
);
const MessageView = lazyPanel(() => import("../ShellMessage").then((module) => module.MessageView));

export const Transcript = memo(function Transcript({
  narrow,
  visible,
  scrollRef,
  scrollRequest,
  onScrollRequestHandled,
  artifactTarget,
  messages,
  showToolActivity,
  olderCursor,
  loadingOlder,
  answerableAskMessageIds,
  running,
  tailPhase,
  workingBots,
  workRuns,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onQuote,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
  onOpenComputer,
}: {
  narrow: boolean;
  visible: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  showToolActivity: boolean;
  olderCursor: number | null;
  loadingOlder: boolean;
  answerableAskMessageIds: string[];
  running: boolean;
  tailPhase: ThreadTailPhase | null;
  workingBots: GroupAvatarMember[];
  /** Runs still working, with their start times, for the turn's clock and steps. */
  workRuns: ReadonlyArray<{
    id: string;
    status: string;
    startedAt: string | null;
    createdAt: string;
  }>;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: AskAnswer, username?: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { name?: string; color: string; status?: string } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string) => void;
}) {
  const { t } = useLingui();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // Keep the original waiting cards at hand after later group replies; render each card once.
  const reactionView = useMemo(
    () =>
      projectMessageReactions([
        ...messages.filter((message) => !answerableAskMessageIds.includes(message.id)),
        ...messages.filter((message) => answerableAskMessageIds.includes(message.id)),
      ]),
    [messages, answerableAskMessageIds],
  );
  const separatorIds = timeSeparatorIds(
    reactionView.visibleMessages.filter((message) =>
      messageHasVisibleBlocks(message.blocks, showToolActivity),
    ),
  );
  // The turn's work survives narration messages that replace the live row, and its
  // summary stays after the reply; the fold returns the same object when nothing changed.
  const workTracker = useRef<WorkTracker>(EMPTY_WORK_TRACKER);
  workTracker.current = trackWork(
    workTracker.current,
    { runs: workRuns, messages },
    new Date(Date.now()).toISOString(),
  );
  const workSession = workTracker.current.session;
  const workingLabel =
    showToolActivity && isRunPhase(tailPhase) && workingBots.length
      ? workingBots
          .map(({ name, status }) =>
            [name, status && rosterWorkStatusLabel(status)].filter(Boolean).join(" · "),
          )
          .join("; ")
      : threadTailLabel(tailPhase);
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(range.endContainer);
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluateSelection();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluateSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuoteDraft(null);
    };
    // A drag that ends outside the window never fires document mouseup; reset
    // the flag on blur so keyboard selections keep working afterwards.
    const onWindowBlur = () => {
      selectingWithMouse.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [evaluateSelection]);
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  const scrolledJump = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const jumpScrollTimer = useRef<number | undefined>(undefined);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    window.clearTimeout(jumpScrollTimer.current);
    scrollRef.current?.removeEventListener("scrollend", endJumpScroll);
  }, [scrollRef]);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (!visible || !scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(scrollRequest.messageId)}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    element.addEventListener("scrollend", endJumpScroll, { once: true });
    window.clearTimeout(jumpScrollTimer.current);
    jumpScrollTimer.current = window.setTimeout(endJumpScroll, 2_000);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    row.animate(
      reducedMotion
        ? [{ backgroundColor: "var(--muted)" }, { backgroundColor: "var(--muted)" }]
        : [
            { backgroundColor: "transparent" },
            { backgroundColor: "var(--muted)" },
            { backgroundColor: "transparent" },
          ],
      { duration: 1200 },
    );
    onScrollRequestHandled();
  }, [visible, messages, scrollRequest, scrollRef, endJumpScroll, onScrollRequestHandled]);

  useLayoutEffect(() => {
    if (visible && following.current) snapToEnd();
  }, [visible, messages, running, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Observes bubbled scroll keys without changing native keyboard behavior. */}
      <div
        ref={scrollRef}
        data-testid="transcript"
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
            following.current = false;
            autoScrolling.current = false;
          }
        }}
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          if (!visible) return;
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          // threads.get returns only the latest page; reading upward pages in older history.
          if (
            !scrolledDown &&
            event.currentTarget.scrollTop < 200 &&
            olderCursor != null &&
            !loadingOlder &&
            !jumpScrolling.current
          )
            void loadOlder()?.catch(() => undefined);
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className="chat-transcript rk-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
      >
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        <TranscriptWindow
          items={groupVoiceChats(reactionView.visibleMessages).filter(
            (item) =>
              item.kind === "voiceChat" ||
              messageHasVisibleBlocks(item.message.blocks, showToolActivity),
          )}
          itemKey={(item) => (item.kind === "voiceChat" ? item.key : item.message.id)}
          containsMessage={(item, id) =>
            item.kind === "voiceChat"
              ? item.messages.some((message) => message.id === id)
              : item.message.id === id
          }
          scrollRef={scrollRef}
          following={following}
          jumpMessageId={scrollRequest?.messageId}
          renderItem={(item) => {
            if (item.kind === "voiceChat") {
              return (
                <div key={item.key}>
                  {item.messages[0] && separatorIds.has(item.messages[0].id) ? (
                    <TimeSeparator
                      createdAt={item.messages[0].createdAt}
                      locale={i18n.locale || "en"}
                    />
                  ) : null}
                  <VoiceChatCard group={item} revealMessageId={scrollRequest?.messageId} />
                </div>
              );
            }
            const message = item.message;
            if (!messageHasVisibleBlocks(message.blocks, showToolActivity)) return null;
            const peerReceipt = isPeerReceiptBlocks(message.blocks);
            const messageReactions = reactionView.reactions.get(message.id);
            return (
              <Fragment key={message.id}>
                {separatorIds.has(message.id) ? (
                  <TimeSeparator createdAt={message.createdAt} locale={i18n.locale || "en"} />
                ) : null}
                <div
                  data-message-id={message.id}
                  data-message-role={message.role}
                  className={peerReceipt ? "relative py-0.5" : "group/message relative hover:z-20"}
                >
                  <div
                    className={
                      peerReceipt
                        ? undefined
                        : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                    }
                  >
                    <div
                      data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                      className={
                        peerReceipt
                          ? undefined
                          : `relative w-fit min-w-0 ${
                              narrow
                                ? message.role === "user"
                                  ? "max-w-[88%]"
                                  : "max-w-full"
                                : message.role === "user"
                                  ? "max-w-[min(84%,calc(100%_-_8rem))] [@media(hover:none)]:max-w-[84%]"
                                  : "max-w-[min(88%,calc(100%_-_8rem))] [@media(hover:none)]:max-w-[88%]"
                            }`
                      }
                    >
                      <MessageView
                        artifactTarget={artifactTarget}
                        message={message}
                        canAnswer={answerableAskMessageIds.includes(message.id)}
                        onOpenBot={onOpenBot}
                        onOpenPeerMessages={onOpenPeerMessages}
                        onAnswer={onAnswer}
                        speakerName={
                          peerReceipt
                            ? undefined
                            : message.role === "bot"
                              ? showToolActivity
                                ? memberName?.(message.botId)
                                : undefined
                              : undefined
                        }
                        memberName={memberName}
                        peerBot={peerBot}
                        replyParent={
                          message.replyToMessageId
                            ? messageById.get(message.replyToMessageId)
                            : undefined
                        }
                        onJumpToMessage={onJumpToMessage}
                        onRefresh={onRefresh}
                        onBotChanged={onBotChanged}
                        onAddRoutine={onAddRoutine}
                        voiceReady={voiceReady}
                        speaking={speakingMessageId === message.id}
                        onSpeak={() => onSpeak(message)}
                        onOpenComputer={onOpenComputer}
                        showToolActivity={showToolActivity}
                      />
                      {peerReceipt ? null : (
                        <MessageHoverActions
                          message={message}
                          below={narrow}
                          side={message.role === "user" ? "start" : "end"}
                          onReply={onReply}
                          onReact={onReact}
                        />
                      )}
                    </div>
                  </div>
                  {!peerReceipt && !message.id.startsWith("progress:") ? (
                    <time
                      dateTime={message.createdAt}
                      data-testid="message-hover-time"
                      className={cn(
                        "pointer-events-none absolute z-10 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 group-has-[[aria-expanded=true]]/message:opacity-100 [@media(hover:none)]:transition-none",
                        narrow
                          ? [
                              "bottom-1 max-w-[50%]",
                              message.role === "user" ? "start-0 text-start" : "end-0 text-end",
                            ]
                          : [
                              "top-1",
                              // Hover keeps the date in the side margin. Touch leaves that margin for the bubble and drops the revealed time under it.
                              message.role === "user"
                                ? "start-0 max-w-[max(8rem,16%)] text-start"
                                : "end-0 max-w-[max(8rem,12%)] text-end",
                              "[@media(hover:none)]:group-hover/message:static [@media(hover:none)]:group-focus-within/message:static [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:static",
                              "[@media(hover:none)]:group-hover/message:block [@media(hover:none)]:group-focus-within/message:block [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:block",
                              "[@media(hover:none)]:group-hover/message:mt-1 [@media(hover:none)]:group-focus-within/message:mt-1 [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:mt-1",
                              "[@media(hover:none)]:group-hover/message:w-full [@media(hover:none)]:group-focus-within/message:w-full [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:w-full",
                              "[@media(hover:none)]:group-hover/message:max-w-none [@media(hover:none)]:group-focus-within/message:max-w-none [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:max-w-none",
                              message.role === "user"
                                ? "[@media(hover:none)]:group-hover/message:text-end [@media(hover:none)]:group-focus-within/message:text-end [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:text-end"
                                : "[@media(hover:none)]:group-hover/message:text-start [@media(hover:none)]:group-focus-within/message:text-start [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:text-start",
                            ],
                      )}
                    >
                      {formatMessageTime(message.createdAt, i18n.locale || "en")}
                    </time>
                  ) : null}
                  {!peerReceipt && messageReactions ? (
                    <div
                      data-testid="message-reactions"
                      className={cn(
                        "mt-1 flex flex-wrap gap-1",
                        message.role === "user" && "justify-end",
                      )}
                    >
                      {[...messageReactions].map(([emoji, count]) => (
                        <span
                          key={emoji}
                          className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                        >
                          {emoji}
                          {count > 1 ? ` ${count}` : ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Fragment>
            );
          }}
        />
        {workingLabel &&
        // Streaming reply text is its own progress; the run label steps aside for it.
        !(
          isRunPhase(tailPhase) &&
          messages.some(
            (message) =>
              message.id.startsWith("progress:") &&
              message.blocks.some(
                (block) =>
                  block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
              ),
          )
        ) ? (
          showToolActivity && isRunPhase(tailPhase) && workingBots.length ? (
            <ActiveBotGlyph bots={workingBots} label={workingLabel} />
          ) : tailPhase === "working" ||
            tailPhase === "starting" ||
            tailPhase === "compacting" ||
            tailPhase === "retrying" ? (
            <LiveWork
              session={
                workSession?.endedAt
                  ? null
                  : workSession && tailPhase === "compacting"
                    ? { ...workSession, current: null }
                    : workSession
              }
              live
              label={workingLabel}
              showSteps={!showToolActivity}
            />
          ) : (
            <LoadingState
              label={workingLabel}
              indicator={
                <span aria-hidden>
                  <Shimmer>{workingLabel}</Shimmer>
                </span>
              }
            />
          )
        ) : workSession?.endedAt &&
          !tailPhase &&
          !showToolActivity &&
          messages.at(-1)?.role !== "user" ? (
          <LiveWork session={workSession} live={false} label="" />
        ) : null}
      </div>
      {quoteDraft ? (
        <QuoteSelectionButton
          range={quoteDraft.range}
          onQuote={() => {
            onQuote(quoteDraft.message, quoteDraft.text);
            window.getSelection()?.removeAllRanges();
            setQuoteDraft(null);
          }}
        />
      ) : null}
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-md backdrop-blur transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] hover:bg-border motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
});

/**
 * Floating Quote action anchored to the selection's bounding rect. Measures
 * itself after mount so it can flip below the selection when there is no room
 * above and stay clamped inside the viewport; re-anchors on scroll/resize.
 */
const QuoteSelectionButton = memo(function QuoteSelectionButton({
  range,
  onQuote,
}: {
  range: Range;
  onQuote: () => void;
}) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (range.collapsed || !document.contains(range.commonAncestorContainer)) {
        setPlacement(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const width = buttonRef.current?.offsetWidth ?? 0;
      const height = buttonRef.current?.offsetHeight ?? 0;
      const above = rect.top >= height + 8;
      setPlacement({
        top: above ? rect.top - 8 : rect.bottom + 8,
        left: Math.min(
          Math.max(rect.left + rect.width / 2, width / 2 + 8),
          window.innerWidth - width / 2 - 8,
        ),
        above,
      });
    };
    update();
    window.addEventListener("resize", update);
    // Scroll doesn't bubble — listen on the capture phase to catch any scroller.
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [range]);

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-quote-selection
      data-testid="quote-selection"
      onMouseDown={(event) => {
        // Keep the highlight alive until the click commits the quote.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onQuote}
      style={placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }}
      className={cn(
        "fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground shadow-md hover:bg-muted",
        placement?.above === false ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <TextQuote size={13} strokeWidth={2} />
      {t`Quote`}
    </button>,
    document.body,
  );
});
