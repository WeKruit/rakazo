import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadBackgroundTask } from "@rakazo/contracts";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";
import { backgroundTaskTime } from "./background-task-time";

export function BackgroundTasks({
  target,
  onClose,
}: {
  target: ArtifactTarget;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [tasks, setTasks] = useState<ThreadBackgroundTask[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTasks(null);
    setFailed(false);
    void rpc.threads
      .backgroundTasks(target, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setTasks(rows);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [target, attempt]);
  const cancel = async (task: ThreadBackgroundTask) => {
    setBusy(task.id);
    setFailed(false);
    try {
      await rpc.threads.cancelTask({ ...target, id: task.id, kind: task.kind });
      setTasks(await rpc.threads.backgroundTasks(target));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="background-tasks">
        <DialogTitle>
          <Trans>Background tasks</Trans>
        </DialogTitle>
        {failed ? (
          <div className="flex items-center gap-2" role="alert">
            <Trans>Could not update tasks.</Trans>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {tasks === null ? (
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        ) : tasks.length === 0 ? (
          <p>
            <Trans>No background tasks.</Trans>
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => {
              const time = backgroundTaskTime(task);
              return (
                <li key={task.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col">
                    <span>
                      {task.kind === "research" || task.kind === "agent_run"
                        ? t`Finding candidates`
                        : task.kind === "run"
                          ? t`Background task`
                          : t`Delegated task`}
                    </span>
                    {time ? <span className="text-muted-foreground text-xs">{time}</span> : null}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null || task.status === "cancelling"}
                    onClick={() => void cancel(task)}
                  >
                    {task.status === "cancelling"
                      ? t`Cancelling…`
                      : task.kind === "agent_run"
                        ? t`Stop following`
                        : task.kind === "research"
                          ? t`Stop updates`
                          : t`Cancel task`}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="sm" />}>
          <Trans>Close</Trans>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
