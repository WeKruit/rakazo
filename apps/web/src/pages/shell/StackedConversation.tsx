import { Trans, useLingui } from "@lingui/react/macro";
import type { AskAnswer, Bot, ThreadSnapshot } from "@rakazo/contracts";
import { answerableAskMessageIds, threadTailPhase, userVisibleMessages } from "@rakazo/core";
import { Button, cn, Textarea } from "@rakazo/ui-web";
import { ArrowDown, ArrowLeft, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoadingState, Shimmer } from "../../components/ai/primitives";
import { lazyPanel } from "../../components/ErrorBoundary";
import { isRunPhase, threadTailLabel } from "../../lib/roster-status";
import { rpc } from "../../lib/rpc";
import { transcriptIsNearEnd } from "../../lib/transcript-scroll";
import { errorText } from "../../lib/user-error";

const MessageView = lazyPanel(() => import("../ShellMessage").then((module) => module.MessageView));

const REFRESH_MS = 3000;
/** How long a sent answer shows as starting while the run has not been seen yet. */
const PENDING_MS = 30_000;
const noop = () => undefined;
const asyncNoop = async () => undefined;

/**
 * Another conversation stacked over the open workspace from the right, so a waiting card can be
 * answered without leaving the page. Back closes it and leaves the workspace as it was.
 * Docked, it is a labelled pane beside the open chat instead (Kruit beside a role chat).
 */
export function StackedConversation({
  groupId,
  messageId,
  title,
  subtitle,
  bots,
  docked = false,
  onBack,
  onOpenFull,
}: {
  groupId: string;
  /** Opens at this message instead of the latest ones, until the recruiter sends or answers. */
  messageId?: string;
  title: string;
  /** Says what this conversation is, under the title. */
  subtitle?: string;
  bots: Bot[];
  docked?: boolean;
  onBack: () => void;
  onOpenFull: () => void;
}) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const acceptedSnapshot = useRef<ThreadSnapshot | null>(null);
  const [focused, setFocused] = useState(messageId);
  const [around, setAround] = useState<ThreadSnapshot["messages"] | null>(null);
  // A failed refresh clears on the next good one; a failed send or answer stays until retried.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  // From a send or answer until its run shows, so the recruiter sees it was taken.
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const editRevision = useRef(0);
  const following = useRef(!messageId);
  const [atEnd, setAtEnd] = useState(!messageId);
  const scroller = useRef<HTMLDivElement>(null);
  // A message typed right after a card click goes after the click's answer.
  const answering = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef(groupId);
  current.current = groupId;

  const load = useCallback(async () => {
    const next = await rpc.threads.get({ groupId });
    if (current.current !== groupId) return;
    // Polls and action refreshes can arrive out of order; the cursor is a durable event sequence.
    const accepted = acceptedSnapshot.current;
    if (accepted?.threadId === next.threadId && next.cursor < accepted.cursor) return;
    acceptedSnapshot.current = next;
    setSnapshot(next);
    const latest = new Map(next.messages.map((message) => [message.id, message]));
    setAround((previous) => previous?.map((message) => latest.get(message.id) ?? message) ?? null);
    setLoadError(null);
    const phase = threadTailPhase(next);
    if (isRunPhase(phase)) setPendingSince(null);
  }, [groupId]);

  useEffect(() => {
    if (!focused) return;
    let alive = true;
    rpc.threads
      .messages({ groupId, around: { messageId: focused } })
      .then((page) => {
        if (alive) setAround(page.messages);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(errorText(err, t`Could not load this conversation`));
      });
    return () => {
      alive = false;
    };
  }, [groupId, focused]);

  useEffect(() => {
    setSnapshot(null);
    setLoadError(null);
    setActionError(null);
    let alive = true;
    const tick = () =>
      load().catch((err: unknown) => {
        if (alive) setLoadError(errorText(err, t`Could not load this conversation`));
      });
    void tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  // Same filter as the full conversation: internal continuations and peer chatter stay hidden.
  const source = focused ? around : (snapshot?.messages ?? null);
  const shown = source && userVisibleMessages(source);
  // A link can target a hidden message, such as a handoff to a role; land on the nearest shown one.
  const anchor = focused ? nearestShownMessageId(around, shown, focused) : undefined;

  useEffect(() => {
    if (!anchor) return;
    scroller.current
      ?.querySelector(`[data-message-id="${CSS.escape(anchor)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [anchor]);

  useEffect(() => {
    if (docked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, docked]);

  const answerable = answerableAskMessageIds(snapshot);
  const pending = pendingSince !== null && Date.now() - pendingSince < PENDING_MS;
  const phase = snapshot ? threadTailPhase(snapshot, { sending: sending || pending }) : null;
  const workingLabel =
    isRunPhase(phase) || phase === "compacting" || phase === "retrying"
      ? threadTailLabel(phase)
      : null;
  const botName = (botId: string | undefined) => bots.find((bot) => bot.id === botId)?.name;

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && !focused && following.current) box.scrollTop = box.scrollHeight;
  }, [shown, focused, workingLabel]);

  function jumpToLatest() {
    following.current = true;
    setAtEnd(true);
    setFocused(undefined);
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const revision = editRevision.current;
    setSending(true);
    setActionError(null);
    try {
      await answering.current;
      await rpc.threads.send({ groupId, text });
      if (editRevision.current === revision) setDraft("");
      jumpToLatest();
      setPendingSince(Date.now());
      await load().catch(noop);
    } catch (err) {
      setActionError(errorText(err, t`Could not send`));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-label={title}
      data-docked-conversation={docked ? "" : undefined}
      className={
        docked
          ? "hidden w-96 shrink-0 flex-col border-e border-border bg-background lg:flex"
          : "fixed inset-y-0 end-0 z-50 flex w-full max-w-xl flex-col border-s border-border bg-background shadow-2xl animate-in slide-in-from-right duration-200"
      }
    >
      <header
        className={cn(
          "flex items-center gap-2 border-b border-border px-3",
          docked ? "min-h-16" : "min-h-14",
        )}
      >
        {docked ? null : (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            <Trans>Back</Trans>
          </Button>
        )}
        <div className={docked ? "min-w-0 flex-1 px-1" : "min-w-0 flex-1"}>
          <h2 className="truncate text-sm font-semibold leading-snug" title={title} dir="auto">
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-xs leading-snug text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Open full conversation`}
          onClick={onOpenFull}
        >
          <Maximize2 />
        </Button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={(event) => {
            const nearEnd = transcriptIsNearEnd(event.currentTarget);
            following.current = nearEnd;
            setAtEnd(nearEnd);
          }}
          className="rk-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {shown === null && !error ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {shown?.map((message) => (
            <div
              key={message.id}
              data-message-id={message.id}
              className={message.id === anchor ? "rounded-xl ring-2 ring-ring" : undefined}
            >
              <MessageView
                artifactTarget={{ groupId }}
                message={message}
                canAnswer={answerable.includes(message.id)}
                onAnswer={async (target, answer: AskAnswer, username?: string) => {
                  const answered = rpc.threads.answer({
                    groupId,
                    runId: target.runId ?? "",
                    messageId: target.id,
                    answer,
                    ...(username ? { username } : {}),
                  });
                  answering.current = answered.catch(noop);
                  await answered;
                  jumpToLatest();
                  setPendingSince(Date.now());
                  await load().catch(noop);
                }}
                onOpenBot={noop}
                onOpenPeerMessages={noop}
                memberName={botName}
                peerBot={(botId) => {
                  const bot = bots.find((item) => item.id === botId);
                  return bot ? { name: bot.name, color: bot.color } : undefined;
                }}
                onRefresh={load}
                onBotChanged={asyncNoop}
                onAddRoutine={noop}
                voiceReady={false}
                speaking={false}
                onSpeak={noop}
                onOpenComputer={noop}
                showToolActivity={false}
              />
            </div>
          ))}
          {workingLabel && !focused ? (
            <LoadingState
              label={workingLabel}
              indicator={
                <span aria-hidden>
                  <Shimmer>{workingLabel}</Shimmer>
                </span>
              }
            />
          ) : null}
        </div>
        <button
          type="button"
          aria-label={t`Jump to latest`}
          aria-hidden={atEnd}
          tabIndex={atEnd ? -1 : 0}
          onClick={jumpToLatest}
          className={cn(
            "absolute bottom-4 left-1/2 z-20 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-md",
            atEnd && "pointer-events-none opacity-0",
          )}
        >
          <ArrowDown size={17} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => {
            editRevision.current += 1;
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          aria-label={t`Message`}
          placeholder={t`Message…`}
          className="max-h-40 min-h-10 flex-1 resize-none"
        />
        <Button type="submit" disabled={!draft.trim() || sending}>
          <Trans>Send</Trans>
        </Button>
      </form>
    </section>
  );
}

function nearestShownMessageId(
  around: readonly { id: string; seq: number }[] | null,
  shown: readonly { id: string; seq: number }[] | null,
  messageId: string,
): string | undefined {
  if (!shown?.length) return undefined;
  if (shown.some((message) => message.id === messageId)) return messageId;
  const seq = around?.find((message) => message.id === messageId)?.seq;
  if (seq === undefined) return undefined;
  return (shown.findLast((message) => message.seq <= seq) ?? shown[0])?.id;
}
