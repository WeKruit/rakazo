import { Trans, useLingui } from "@lingui/react/macro";
import type { MailReplyMessageFilter, ThreadMessage } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { mergeMessagesById, runThreadSubscription } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useContext, useEffect, useState } from "react";
import { AskCard } from "../../components/AskCard";
import { createCoalescedRefresh } from "../../lib/coalesced-refresh";
import { rpc } from "../../lib/rpc";
import { RetryNotice } from "./RetryNotice";
import type { RecruitingTabProps } from "./shared";
import { RecruitingReadCacheContext, useKeyedRead } from "./shared";

type Props = {
  conversation: NonNullable<RecruitingTabProps["conversation"]>;
  filter: MailReplyMessageFilter;
  readCacheScope?: string;
  refreshSignal?: number;
};

/** Scope the existing pager and its accumulated cards to one authorized mail conversation. */
export function MailReplyCards(props: Props) {
  return (
    <MailReplyCardPage
      key={JSON.stringify([props.readCacheScope, props.conversation, props.filter])}
      {...props}
    />
  );
}

function MailReplyCardPage({ conversation, filter, readCacheScope, refreshSignal = 0 }: Props) {
  const { t } = useLingui();
  const cache = useContext(RecruitingReadCacheContext);
  const [before, setBefore] = useState<number>();
  const [reload, setReload] = useState(0);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const identity = JSON.stringify([conversation, filter]);
  const input = { ...conversation, mailReplyFor: filter, before, includePeerRuns: true };
  const read = useKeyedRead(
    JSON.stringify([readCacheScope, identity, before, reload, refreshSignal]),
    () => rpc.threads.messages(input),
    readCacheScope
      ? { cache, key: `${readCacheScope}:mail-replies:${identity}:${before ?? "latest"}` }
      : {},
  );
  useEffect(() => {
    if (read.data)
      setMessages((current) =>
        mergeMessagesById(read.data!.messages, current).sort((left, right) => left.seq - right.seq),
      );
  }, [read.data]);
  useEffect(() => {
    const abort = new AbortController();
    let head: { threadId: string; cursor: number } | null = null;
    const queue = createCoalescedRefresh(
      () => {
        setBefore(undefined);
        setReload((value) => value + 1);
      },
      { windowMs: 1000 },
    );
    const readHead = async () =>
      (head = await rpc.threads.head(conversation, { signal: abort.signal }));
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: readHead,
      loadHead: readHead,
      currentSnapshot: () => head,
      refresh: async () => {
        queue.request();
        return readHead();
      },
      subscribe: (cursor) =>
        rpc.threads.subscribe({ ...conversation, cursor }, { signal: abort.signal }),
      applyEvent: (event) => {
        if (head) head = { threadId: head.threadId, cursor: event.seq };
      },
      onEvent: (event) => {
        if (event.type === "thread.message.updated") {
          const blocks = MessageBlockSchema.array().safeParse(event.payload.blocks);
          if (blocks.success)
            setMessages((current) =>
              current.map((message) =>
                message.id === event.payload.messageId
                  ? { ...message, blocks: blocks.data }
                  : message,
              ),
            );
        }
        if (event.type === "thread.cleared") {
          setMessages([]);
          queue.request();
        }
        if (
          (event.type === "thread.message.created" || event.type === "thread.message.updated") &&
          Array.isArray(event.payload.blocks) &&
          event.payload.blocks.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "kind" in block &&
              block.kind === "ask" &&
              "mailReply" in block,
          )
        )
          queue.request();
        if (
          ["run.waiting_input", "run.completed", "run.failed", "run.cancelled"].includes(event.type)
        )
          queue.request();
      },
    }).catch(() => {});
    return () => {
      abort.abort();
      queue.dispose();
    };
  }, [identity]);

  if (read.failed)
    return (
      <RetryNotice onRetry={() => setReload((value) => value + 1)}>
        <Trans>Could not load reply drafts.</Trans>
      </RetryNotice>
    );
  const cards = messages.flatMap((message) =>
    message.blocks.flatMap((block, index) =>
      block.kind === "ask" &&
      block.mailReply &&
      message.runId &&
      block.mailReply.inReplyTo.sourceId === filter.sourceId &&
      block.mailReply.from?.trim().toLowerCase() === filter.mailbox.trim().toLowerCase() &&
      ((filter.threadId && block.mailReply.inReplyTo.threadId === filter.threadId) ||
        filter.emailIds?.includes(block.mailReply.inReplyTo.emailId))
        ? [
            <AskCard
              key={`${message.id}:${index}`}
              block={block}
              canAnswer={block.mailReply.canAnswer === true}
              onAnswer={async (answer) => {
                await rpc.threads.answer({
                  ...conversation,
                  runId: message.runId!,
                  messageId: message.id,
                  answer,
                });
                setBefore(undefined);
                setReload((value) => value + 1);
              }}
            />,
          ]
        : [],
    ),
  );
  if (!cards.length) return null;
  return (
    <section aria-label={t`Reply drafts`} className="mt-4 space-y-3">
      {cards}
      {read.data?.olderCursor !== null && read.data?.olderCursor !== undefined ? (
        <Button
          variant="outline"
          disabled={read.loading}
          onClick={() => setBefore(read.data!.olderCursor!)}
        >
          <Trans>Earlier drafts</Trans>
        </Button>
      ) : null}
    </section>
  );
}
