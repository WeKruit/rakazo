import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web-lazy";
import type { AskAnswer, MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import { isPendingUserMessage, isToolActivityBlock } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  resolvePersonaColorDef,
} from "@rakazo/ui-web";
import { Copy, MoreHorizontal, Reply, Smile } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { lazyPanel } from "../components/ErrorBoundary";

const ArtifactFileCard = lazyPanel(() =>
  import("../components/ArtifactFileCard").then((m) => m.ArtifactFileCard),
);
const AskCard = lazyPanel(() => import("../components/AskCard").then((m) => m.AskCard));

import { CollaborationMarker } from "../components/ai/CollaborationMarker";

const CloudAgentCard = lazyPanel(() =>
  import("../components/CloudAgentCard").then((m) => m.CloudAgentCard),
);

import { MessageHoverMetadata } from "../components/MessageHoverMetadata";
import {
  LIVE_TOOL_STEP_WINDOW,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "../components/ToolActivityDisclosure";

const SkillDraftCard = lazyPanel(() =>
  import("../components/teach/SkillDraftCard").then((m) => m.SkillDraftCard),
);

import type { ArtifactTarget } from "../lib/artifact-open";
import { copyableMessageText, previewMessageText } from "../lib/message-text";
import { messageProviderLabel } from "../lib/messaging";
import {
  isToolOnlyNarration,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "../lib/tool-activity-view";
import { ReplyLine } from "./shell/chat-context";
import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./shell/message-cards";

const FALLBACK_BOT_COLOR = "#85858A";
export function MessageHoverActions({
  message,
  side,
  below = false,
  onReply,
  onReact,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  below?: boolean;
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks; a local echo
  // has no server id to reply to or react to until its send is confirmed.
  if (message.id.startsWith("progress:") || isPendingUserMessage(message)) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const iconButtonClass =
    "grid h-7 w-7 place-items-center text-muted-foreground transition-colors hover:text-foreground";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen} side={side} below={below}>
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        {canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger
              aria-label={t`React`}
              className={cn(
                iconButtonClass,
                "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
              )}
            >
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className={cn(
            iconButtonClass,
            "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
          )}
        >
          <Reply size={15} strokeWidth={1.7} />
        </button>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            aria-label={t`More`}
            className={cn(
              iconButtonClass,
              "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
            )}
          >
            <MoreHorizontal size={15} strokeWidth={1.7} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={side === "end" ? "start" : "end"}>
            <DropdownMenuItem
              onClick={() => {
                setMoreOpen(false);
                onReply(message);
              }}
            >
              <Reply size={14} strokeWidth={1.7} />
              <Trans>Reply</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyMessage}>
              <Copy size={14} strokeWidth={1.7} />
              <Trans>Copy</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </MessageHoverMetadata>
  );
}

export const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  message,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  speakerName,
  memberName,
  peerBot,
  replyParent,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
  onOpenComputer,
  showToolActivity,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  message: ThreadMessage;
  onAnswer: (message: ThreadMessage, text: AskAnswer, username?: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { name?: string; color: string; status?: string } | undefined;
  replyParent?: ThreadMessage;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
  showToolActivity: boolean;
}) {
  const { t } = useLingui();
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;
  const visibleNarrationBlocks = renderableMessageBlocks(message.blocks, showToolActivity);

  const replyBotId = message.replyPreview?.botId ?? replyParent?.botId;
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(message.botId ?? "bot", speakerBot?.color),
    [message.botId, speakerBot?.color],
  );
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.light }}
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            identity={message.botId}
            size={22}
          />
          {speakerName}
        </div>
      ) : null}
      <ReplyLine
        target={artifactTarget}
        message={message}
        fallbackText={replyParent ? previewMessageText(replyParent) : undefined}
        author={
          (message.replyPreview?.role ?? replyParent?.role) === "user"
            ? t`You`
            : showToolActivity
              ? ((replyBotId ? peerBot(replyBotId)?.name : undefined) ??
                memberName?.(replyBotId) ??
                t`Bot`)
              : "WeKruit"
        }
        onJump={onJumpToMessage}
      />
    </>
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) return null;
    if (isToolOnlyNarration(message.blocks, showToolActivity)) {
      return (
        <>
          {messageContext}
          <ToolOnlyNarration blocks={visibleNarrationBlocks} live={isLive} />
        </>
      );
    }
    return (
      <>
        {messageContext}
        <div className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full">
          <div
            data-testid="message-bot-bubble"
            className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-base leading-relaxed text-foreground"
            dir="auto"
          >
            {visibleNarrationBlocks.map((block, i) => {
              if (block.kind === "steps") {
                return (
                  <ToolActivityDisclosure
                    key={i}
                    live={isLive}
                    stepCount={toolStepCount(block.steps)}
                    durationMs={block.durationMs}
                  >
                    <ToolSteps
                      steps={block.steps}
                      currentIndex={isLive ? block.steps.length - 1 : undefined}
                      limit={isLive ? LIVE_TOOL_STEP_WINDOW : undefined}
                    />
                  </ToolActivityDisclosure>
                );
              }
              if (block.kind === "text" || block.kind === "progress") {
                return (
                  <div
                    key={i}
                    data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                  >
                    <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
                  </div>
                );
              }
              return null;
            })}
            {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
              <button
                type="button"
                aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                onClick={onSpeak}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
              </button>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {messageContext}
      {visibleNarrationBlocks.map((block, i) => {
        if (block.kind === "steps" && shouldRenderToolCard(block, showToolActivity)) {
          return (
            <StandaloneToolActivity
              key={i}
              live={isLive}
              steps={block.steps}
              stepCount={toolStepCount(block.steps)}
              durationMs={block.durationMs}
            />
          );
        }
        if (isToolActivityBlock(block)) return null;
        if (block.kind === "handoff") {
          const from = memberName?.(block.fromBotId) ?? t`bot`;
          const to = memberName?.(block.toBotId) ?? t`bot`;
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                ↪ {to} ← {from}
              </span>
              {showToolActivity ? <span>{block.text}</span> : null}
            </div>
          );
        }
        if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
          const sent = block.kind === "bot_message_sent";
          const peer = sent ? block.toBotName : block.fromBotName;
          const peerBotId = sent ? block.toBotId : block.fromBotId;
          const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
          return (
            <CollaborationMarker
              key={i}
              ariaLabel={label}
              color={peerBot(peerBotId)?.color ?? FALLBACK_BOT_COLOR}
              identity={peerBotId}
              label={label}
              onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
            />
          );
        }
        if (block.kind === "channel_message") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
                {block.text}
              </span>
            </div>
          );
        }
        if (block.kind === "meta") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span className="text-warning">◷</span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "progress") {
          return (
            <div
              key={i}
              className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
            >
              <div
                data-testid="message-bot-bubble"
                className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-base leading-relaxed text-foreground"
                dir="auto"
              >
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "subagent") {
          const running = block.status === "running";
          const failed = block.status === "failed";
          return (
            <div
              key={i}
              className="w-[min(420px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    failed
                      ? "bg-destructive/15 text-destructive"
                      : running
                        ? "bg-warning/15 text-warning"
                        : "bg-success/15 text-success"
                  }`}
                  style={{
                    animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                  }}
                >
                  {running ? <Trans>Working…</Trans> : block.status}
                </span>
              </div>
              {showToolActivity ? (
                <div className="mt-2 text-[13.5px] text-muted-foreground">{block.task}</div>
              ) : null}
              {showToolActivity && (block.progress || block.result) ? (
                <div className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                  <ChatMarkdown streaming={running}>
                    {block.result || block.progress || ""}
                  </ChatMarkdown>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "child_bot") {
          const removed = block.status === "deleted" || block.status === "archived";
          return (
            <button
              key={i}
              type="button"
              disabled={removed}
              onClick={() => onOpenBot(block.botId)}
              className="w-[min(340px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4 text-start disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                  }`}
                >
                  {block.status === "archived" ? (
                    <Trans>archived</Trans>
                  ) : block.status === "deleted" ? (
                    <Trans>deleted</Trans>
                  ) : (
                    <Trans>bot</Trans>
                  )}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-foreground/75" dir="auto">
                {removed
                  ? block.status === "archived"
                    ? t`Archived. Chat, memory, and files kept.`
                    : t`Removed with chat, computer, and memory.`
                  : block.title || t`Opened its thread.`}
              </div>
            </button>
          );
        }
        if (block.kind === "choice") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
        }
        if (block.kind === "app_connect") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start py-1">
              <AppConnectCard botId={botId} block={block} />
            </div>
          );
        }
        if (block.kind === "chart") {
          return (
            <div key={i} className="flex justify-start">
              <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
            </div>
          );
        }
        if (block.kind === "mcp_approval") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start">
              <McpApprovalCard botId={botId} threadId={message.threadId} block={block} />
            </div>
          );
        }
        if (block.kind === "image") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactImage
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
              />
            </div>
          );
        }
        if (block.kind === "file") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactFileCard
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
                mimeType={block.mimeType}
                size={block.size}
                preview={block.preview}
              />
            </div>
          );
        }
        if (block.kind === "text" && message.role === "user") {
          // User bubbles stay literal text on web and mobile. Only explicit URLs
          // and email addresses are links, so a sent address is tappable without
          // formatting bold or headings.
          return (
            <div key={i} className="flex w-fit max-w-full justify-end [@media(hover:none)]:w-full">
              <div
                data-testid="message-user-bubble"
                className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-base leading-relaxed text-chat-user-foreground"
                dir="auto"
              >
                <div data-quote-message-id={quoteMessageId}>
                  <LinkifiedText>{block.text}</LinkifiedText>
                </div>
                {block.correspondenceReference ? (
                  <div
                    className="mt-2 border-t border-border pt-2 text-sm text-muted-foreground"
                    data-testid="message-email-reference"
                  >
                    <span>{block.correspondenceReference.sourceName}</span>
                    {block.correspondenceReference.sender ? (
                      <span> · {block.correspondenceReference.sender}</span>
                    ) : null}
                    <div>{block.correspondenceReference.subject || <Trans>No subject</Trans>}</div>
                    {block.correspondenceReference.date ? (
                      <div>{new Date(block.correspondenceReference.date).toLocaleString()}</div>
                    ) : null}
                    {block.correspondenceReference.snippet ? (
                      <div>
                        <Trans>Preview only</Trans>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "text") {
          return (
            <div
              key={i}
              className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
            >
              <div
                data-testid="message-bot-bubble"
                className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-base leading-relaxed text-foreground"
                dir="auto"
              >
                <div data-quote-message-id={quoteMessageId}>
                  <ChatMarkdown>{block.text}</ChatMarkdown>
                </div>
                {voiceReady ? (
                  <button
                    type="button"
                    aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                    onClick={onSpeak}
                    className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                  </button>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "card") {
          return (
            <div key={i} className="flex justify-start">
              <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4">
                {block.lines.map((line) => (
                  <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                    <span className="text-success">✓</span>
                    <span className="font-semibold text-foreground">{line.k}</span>
                    <span className="text-muted-foreground">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "ask") {
          return (
            <AskCard
              key={i}
              block={block}
              canAnswer={canAnswer}
              onAnswer={(text, username) => onAnswer(message, text, username)}
            />
          );
        }
        if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
        if (block.kind === "skill_draft") {
          return (
            <div key={i} className="flex justify-start">
              <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
            </div>
          );
        }
        if (block.kind === "computer") {
          return (
            <div
              key={i}
              data-testid="computer-card"
              className="w-[340px] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground">
                  <Trans>Computer</Trans>
                </span>
                <span
                  className={
                    block.state === "Needs you"
                      ? "rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning"
                      : "rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success"
                  }
                >
                  {block.state}
                </span>
              </div>
              <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
              <Button
                type="button"
                size="sm"
                data-testid="computer-card-open"
                onClick={() => onOpenComputer(message.botId)}
              >
                <Trans>Open</Trans>
              </Button>
            </div>
          );
        }
        return null;
      })}
    </>
  );
});
