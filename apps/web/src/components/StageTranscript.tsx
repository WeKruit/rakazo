import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web-lazy";
import type { ThreadMessage } from "@rakazo/contracts";
import { loadThreadHistory, workStageMessages } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

/** The stage stays in its original group: opening it never reads a teammate's private thread. */
export function StageTranscript({
  target,
  botId,
  runIds,
  sourceRunIds,
  renderMessage,
  liveMessages = [],
  showToolActivity = false,
  onClose,
}: {
  target: ArtifactTarget;
  botId: string;
  runIds: readonly string[];
  sourceRunIds: readonly string[];
  renderMessage: (message: ThreadMessage) => ReactNode;
  liveMessages?: readonly ThreadMessage[];
  showToolActivity?: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const groupId = "groupId" in target ? target.groupId : undefined;
  const targetBotId = "botId" in target ? target.botId : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setMessages(null);
    setFailed(false);
    void loadThreadHistory({
      signal: controller.signal,
      loadPage: (before, signal) =>
        rpc.threads.messages(
          { ...(groupId ? { groupId } : { botId: targetBotId! }), before, includePeerRuns: true },
          { signal },
        ),
    })
      .then((history) => {
        if (controller.signal.aborted) return;
        setMessages(workStageMessages(history, { botId, runIds, sourceRunIds }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [groupId, targetBotId, botId, runIds, sourceRunIds, attempt]);
  const visibleMessages =
    messages === null
      ? null
      : workStageMessages(
          [
            ...new Map(
              [...messages, ...liveMessages].map((message) => [message.id, message]),
            ).values(),
          ].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)),
          { botId, runIds, sourceRunIds },
        );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col" data-testid="stage-transcript">
        <DialogTitle>
          <Trans>Task transcript</Trans>
        </DialogTitle>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {failed ? (
            <div className="flex items-center gap-2">
              <Trans>Could not load this task.</Trans>
              <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : visibleMessages === null ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : visibleMessages.length === 0 ? (
            <p>
              <Trans>No messages yet.</Trans>
            </p>
          ) : (
            visibleMessages.map((message) => {
              const brief = message.blocks.find(
                (block) => block.kind === "handoff" && block.toBotId === botId,
              );
              if (brief?.kind === "handoff" && !showToolActivity) return null;
              return (
                <div key={message.id}>
                  {brief?.kind === "handoff" ? (
                    <ChatMarkdown>{brief.text}</ChatMarkdown>
                  ) : (
                    renderMessage(message)
                  )}
                </div>
              );
            })
          )}
        </div>
        <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="sm" />}>
          <Trans>Close</Trans>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
