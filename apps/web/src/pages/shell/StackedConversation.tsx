import { Trans, useLingui } from "@lingui/react/macro";
import type { AskAnswer, Bot, ThreadSnapshot } from "@rakazo/contracts";
import { answerableAskMessageIds, userVisibleMessages } from "@rakazo/core";
import { Button, Textarea } from "@rakazo/ui-web";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const MessageView = lazyPanel(() => import("../ShellMessage").then((module) => module.MessageView));

const REFRESH_MS = 3000;
const noop = () => undefined;
const asyncNoop = async () => undefined;

/**
 * Another conversation stacked over the open workspace from the right, so a waiting card can be
 * answered without leaving the page. Back closes it and leaves the workspace as it was.
 */
export function StackedConversation({
  groupId,
  messageId,
  title,
  bots,
  onBack,
  onOpenFull,
}: {
  groupId: string;
  /** Opens at this message instead of the latest ones, until the recruiter sends. */
  messageId?: string;
  title: string;
  bots: Bot[];
  onBack: () => void;
  onOpenFull: () => void;
}) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [focused, setFocused] = useState(messageId);
  const [around, setAround] = useState<ThreadSnapshot["messages"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const current = useRef(groupId);
  current.current = groupId;

  const load = useCallback(async () => {
    const next = await rpc.threads.get({ groupId });
    if (current.current === groupId) setSnapshot(next);
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
        if (alive) setError(errorText(err, t`Could not load this conversation`));
      });
    return () => {
      alive = false;
    };
  }, [groupId, focused]);

  useEffect(() => {
    if (!around || !focused) return;
    scroller.current
      ?.querySelector(`[data-message-id="${CSS.escape(focused)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [around, focused]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    let alive = true;
    const tick = () =>
      load().catch((err: unknown) => {
        if (alive) setError(errorText(err, t`Could not load this conversation`));
      });
    void tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  const lastId = snapshot?.messages.at(-1)?.id;
  useEffect(() => {
    const box = scroller.current;
    if (box && !focused) box.scrollTop = box.scrollHeight;
  }, [lastId, focused]);
  // Same filter as the full conversation: internal continuations and peer chatter stay hidden.
  const source = focused ? around : (snapshot?.messages ?? null);
  const shown = source && userVisibleMessages(source);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const answerable = answerableAskMessageIds(snapshot);
  const botName = (botId: string | undefined) => bots.find((bot) => bot.id === botId)?.name;

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await rpc.threads.send({ groupId, text });
      setDraft("");
      setFocused(undefined);
      await load();
    } catch (err) {
      setError(errorText(err, t`Could not send`));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-label={title}
      className="fixed inset-y-0 end-0 z-50 flex w-full max-w-xl flex-col border-s border-border bg-background shadow-2xl animate-in slide-in-from-right duration-200"
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          <Trans>Back</Trans>
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug" title={title}>
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Open full conversation`}
          onClick={onOpenFull}
        >
          <Maximize2 />
        </Button>
      </header>
      <div ref={scroller} className="rk-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {shown === null && !error ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {shown?.map((message) => (
          <div
            key={message.id}
            data-message-id={message.id}
            className={message.id === focused ? "rounded-xl ring-2 ring-ring" : undefined}
          >
            <MessageView
              artifactTarget={{ groupId }}
              message={message}
              canAnswer={answerable.includes(message.id)}
              onAnswer={async (target, answer: AskAnswer, username?: string) => {
                await rpc.threads.answer({
                  groupId,
                  runId: target.runId ?? "",
                  messageId: target.id,
                  answer,
                  ...(username ? { username } : {}),
                });
                await load();
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
          onChange={(event) => setDraft(event.target.value)}
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
