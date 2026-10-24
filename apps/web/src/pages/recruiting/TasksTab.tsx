import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingReminder } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { relativeTime } from "./activity";
import { RetryNotice } from "./RetryNotice";
import { formatDate, TabLoading, TabNotice, useKeyedRead } from "./shared";

type ReminderFields = { title: string; dueAt: string };

/**
 * The reminder key for a person: their search result when they have one, else their CRM record;
 * none when neither forms a valid key.
 */
export function reminderCandidateKey(
  searchKey: string | null | undefined,
  crmId: string | false | null | undefined,
) {
  return reminderCandidateKeys(searchKey, crmId)[0] ?? null;
}

/** Every valid reminder key for a person, the primary one first: search result, then CRM record. */
export function reminderCandidateKeys(
  searchKey: string | null | undefined,
  crmId: string | false | null | undefined,
) {
  return [searchKey && `autumn:${searchKey}`, crmId && `crm:${crmId}`].filter(
    (key): key is string => !!key && /^(autumn|crm):\S+$/.test(key) && key.length <= 300,
  );
}

/** ISO time as a `datetime-local` value in the viewer's zone. */
const localInput = (iso: string | undefined) => {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function ReminderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ReminderFields;
  onSave: (fields: ReminderFields) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [due, setDue] = useState(localInput(initial?.dueAt));
  const [saving, setSaving] = useState(false);
  const ready = Boolean(title.trim() && due);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await onSave({ title: title.trim(), dueAt: new Date(due).toISOString() });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
      <Input
        aria-label={t`Reminder`}
        placeholder={t`Reminder`}
        value={title}
        maxLength={200}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
      />
      <Input
        type="datetime-local"
        aria-label={t`Due`}
        required
        value={due}
        onChange={(event) => setDue(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" size="sm" disabled={saving || !ready}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </form>
  );
}

/**
 * One person's open reminders for the role, overdue first. `candidateKey` is the reminder key,
 * "autumn:<search key>" or "crm:<CRM candidate id>".
 */
export function TasksTab({
  roleId,
  candidateKey,
  candidateKeys = [candidateKey],
  refreshSignal = 0,
}: {
  roleId: string;
  /** Primary key, used for new reminders. */
  candidateKey: string;
  /** Every key whose reminders are listed; defaults to the primary key. */
  candidateKeys?: readonly string[];
  refreshSignal?: number;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const api = rpc.recruiting.reminders;
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<string>();
  const [saveFailed, setSaveFailed] = useState(false);
  const read = useKeyedRead(
    JSON.stringify([roleId, candidateKey, candidateKeys, refreshSignal, reload]),
    () => api.list({ roleId, candidateKeys: [...candidateKeys], status: "open" }),
  );
  const run = async (change: () => Promise<unknown>) => {
    setSaveFailed(false);
    try {
      await change();
      setEditing(undefined);
      setReload((value) => value + 1);
    } catch {
      setSaveFailed(true);
    }
  };
  const now = Date.now();
  const byDue = (a: RecruitingReminder, b: RecruitingReminder) =>
    Date.parse(a.dueAt) - Date.parse(b.dueAt);
  const items = (read.data?.items ?? []).filter((item) => item.status === "open").sort(byDue);
  const overdue = items.filter((item) => Date.parse(item.dueAt) < now);
  const upcoming = items.filter((item) => Date.parse(item.dueAt) >= now);
  const groups = [
    { key: "overdue", title: t`Overdue (${overdue.length})`, items: overdue },
    { key: "upcoming", title: t`Upcoming (${upcoming.length})`, items: upcoming },
  ];
  return (
    <section aria-label={t`Tasks`} className="space-y-4 text-sm">
      {editing === "" ? (
        <ReminderForm
          onCancel={() => setEditing(undefined)}
          onSave={(fields) => run(() => api.create({ ...fields, roleId, candidateKey }))}
        />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setEditing("")}>
          <Plus size={15} aria-hidden />
          <Trans>Create reminder</Trans>
        </Button>
      )}
      {saveFailed ? (
        <TabNotice alert>
          <Trans>Could not save the reminder.</Trans>
        </TabNotice>
      ) : null}
      {read.loading ? <TabLoading /> : null}
      {read.failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load reminders.</Trans>
        </RetryNotice>
      ) : null}
      {read.data
        ? groups.map((group) => (
            <section key={group.key} aria-label={group.title} className="space-y-2">
              <h3 className="font-semibold">{group.title}</h3>
              <ul className="space-y-2">
                {group.items.map((item) =>
                  editing === item.id ? (
                    <li key={item.id}>
                      <ReminderForm
                        initial={item}
                        onCancel={() => setEditing(undefined)}
                        onSave={(fields) => run(() => api.update({ id: item.id, ...fields }))}
                      />
                    </li>
                  ) : (
                    <li key={item.id} className="rounded-lg border px-3 py-2">
                      <p className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-medium">{item.title}</span>
                        <time
                          dateTime={item.dueAt}
                          title={formatDate(item.dueAt)}
                          className={`shrink-0 text-xs ${
                            group.key === "overdue" ? "text-destructive" : "text-muted-foreground"
                          }`}
                        >
                          {relativeTime(item.dueAt, locale, now)}
                        </time>
                      </p>
                      {item.note ? (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                          {item.note}
                        </p>
                      ) : null}
                      <div className="mt-1 flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(item.id)}>
                          <Trans>Edit</Trans>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => run(() => api.update({ id: item.id, status: "done" }))}
                        >
                          <Trans>Done</Trans>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => run(() => api.delete({ id: item.id }))}
                        >
                          <Trans>Delete</Trans>
                        </Button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))
        : null}
    </section>
  );
}
