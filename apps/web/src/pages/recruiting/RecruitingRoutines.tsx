import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, Routine, ThinkingLevel } from "@rakazo/contracts";
import { cronFromPreset, parseModelOptionKey } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { localTimezone } from "../../lib/local-timezone";
import { rpc } from "../../lib/rpc";
import { RoutineEditor } from "../RoutineEditor";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "../RoutineList";
import { RetryNotice } from "./RetryNotice";
import { TabLoading } from "./shared";

/** Native routines target the selected conversation; the existing scheduler owns execution. */
export function RecruitingRoutines({
  accountKey,
  groups,
  bots,
  groupId,
}: {
  accountKey: string;
  groups: readonly Group[];
  bots: readonly Bot[];
  groupId?: string;
}) {
  const { t } = useLingui();
  const global = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const [params, setParams] = useSearchParams();
  const selected = params.get("role") ?? groupId ?? "all";
  const target = groups.find((group) => group.id === selected) ?? global;
  const targetBotId = target?.members.find((member) => member.name === "Main")?.botId;
  const [items, setItems] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<Routine | null>(null);
  const botId = editing?.botId ?? targetBotId;
  const [draft, setDraft] = useState(emptyRoutineDraft);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const bot = bots.find((item) => item.id === botId);
  const ensureWebhook = async () => {
    if (botId && !bot?.webhookConfigured && !secret) {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setSecret(result.secret);
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setOpen(false);
    setSecret(null);
    setItems([]);
    if (!targetBotId || !target) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void rpc.routines
      .list({
        botId: targetBotId,
        ...(selected === "all" ? { allConversations: true } : { threadId: target.threadId }),
      })
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey, targetBotId, target?.threadId, selected, reload]);
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReload((value) => value + 1);
    } catch {
      setError(t`Could not save routine`);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!botId || !target) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setError(t`Add a name and prompt.`);
      return;
    }
    const model = draft.modelKey ? parseModelOptionKey(draft.modelKey) : null;
    const crons = draft.schedules.map(cronFromPreset);
    const fields = {
      name: draft.name,
      prompt: draft.prompt,
      crons,
      active: draft.active,
      webhookEnabled: draft.webhookEnabled,
      githubEnabled: draft.githubEnabled,
      messageProvider: draft.messageProvider,
      modelProvider: model?.provider ?? null,
      modelId: model?.modelId ?? null,
      thinkingLevel: (model && draft.thinkingLevel
        ? draft.thinkingLevel
        : null) as ThinkingLevel | null,
    };
    let runAt: string | undefined;
    if (editing && draft.active && routineNeedsOneShotArm(editing, crons)) {
      const at = new Date(draft.runAtLocal);
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
        setError(t`Run time must be in the future.`);
        return;
      }
      runAt = at.toISOString();
    }
    await mutate(async () => {
      if (draft.webhookEnabled || draft.githubEnabled) await ensureWebhook();
      return editing
        ? rpc.routines.update({ routineId: editing.id, ...fields, ...(runAt ? { runAt } : {}) })
        : rpc.routines.create({
            botId,
            threadId: target.threadId,
            ...fields,
            timezone: localTimezone(),
            notify: true,
          });
    });
  };
  return (
    <section className="max-w-3xl space-y-3">
      <NativeSelect
        aria-label={t`Routine conversation`}
        value={selected}
        onChange={(event) => {
          const next = new URLSearchParams(params);
          next.set("role", event.target.value);
          setParams(next);
        }}
      >
        <NativeSelectOption value="all">{t`All roles`}</NativeSelectOption>
        {groups.map((group) => (
          <NativeSelectOption key={group.id} value={group.id}>
            {group.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error && !open ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!target ? (
        <p>
          <Trans>No conversation yet.</Trans>
        </p>
      ) : null}
      {loading ? <TabLoading /> : null}
      {failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load routines.</Trans>
        </RetryNotice>
      ) : null}
      {open ? (
        <RoutineEditor
          draft={draft}
          onChange={setDraft}
          editing={editing}
          timezone={editing?.timezone ?? localTimezone()}
          webhook={{
            path: `/api/v1/bots/${botId}/webhook`,
            secret,
            configured: Boolean(bot?.webhookConfigured || secret),
          }}
          githubPath={`/api/v1/bots/${botId}/github`}
          messageProviders={[]}
          saving={busy}
          running={busy}
          error={error}
          onBack={() => setOpen(false)}
          onClose={() => setOpen(false)}
          onSave={() => void save()}
          onTestRun={() => {
            if (editing) void mutate(() => rpc.routines.testRun({ routineId: editing.id }));
          }}
          onDelete={() => {
            if (editing) void mutate(() => rpc.routines.remove({ routineId: editing.id }));
          }}
          onEnsureWebhook={ensureWebhook}
        />
      ) : (
        <>
          <RoutineListHeader
            onCreate={() => {
              setSecret(null);
              setEditing(null);
              setDraft(emptyRoutineDraft());
              setError(null);
              setOpen(true);
            }}
          />
          {items.map((routine) => (
            <div key={routine.id} className="rounded-lg border border-border p-2">
              {selected === "all" ? (
                <p className="px-2.5 pt-2 text-xs text-muted-foreground">
                  {groups.find((group) => group.threadId === routine.threadId)?.name}
                </p>
              ) : null}
              <RoutineListRow
                routine={routine}
                running={false}
                onOpen={() => {
                  setSecret(null);
                  setEditing(routine);
                  setDraft(draftFromRoutine(routine));
                  setError(null);
                  setOpen(true);
                }}
                onStop={() => {}}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    rpc.routines.update({ routineId: routine.id, active: !routine.active }),
                  )
                }
              >
                {routine.active ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void mutate(() => rpc.routines.testRun({ routineId: routine.id }))}
              >
                <Trans>Run now</Trans>
              </Button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
