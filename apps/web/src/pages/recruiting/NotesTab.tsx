import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCandidateNote } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { relativeTime } from "./activity";
import { RetryNotice } from "./RetryNotice";
import { formatDate, TabLoading, TabNotice, useKeyedRead } from "./shared";
import { reminderCandidateKey } from "./TasksTab";

const MAX_NOTE = 8000;

/** Every valid note key a person has: their search result and their CRM record. */
export function noteCandidateKeys(
  searchKey: string | null | undefined,
  crmId: string | false | null | undefined,
) {
  return [reminderCandidateKey(searchKey, null), reminderCandidateKey(null, crmId)].filter(
    (key): key is string => key !== null,
  );
}

function NoteForm({
  initial = "",
  submitLabel,
  onSave,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  onSave: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ready = Boolean(body.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    try {
      if ((await onSave(body.trim())) && !onCancel) setBody("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        aria-label={t`Note`}
        placeholder={t`Type your note here`}
        value={body}
        disabled={saving}
        maxLength={MAX_NOTE}
        autoFocus={Boolean(onCancel)}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={saving || !ready}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * The signed-in recruiter's notes on one person, newest first. `candidateKeys` lists every key the
 * person has ("autumn:<search key>", "crm:<CRM candidate id>"); new notes go under `createKey`.
 */
export function NotesTab({
  roleId,
  candidateKeys,
  createKey,
}: {
  roleId: string;
  candidateKeys: string[];
  createKey: string;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const api = rpc.recruiting.notes;
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<string>();
  const [saveFailed, setSaveFailed] = useState(false);
  const read = useKeyedRead(JSON.stringify([candidateKeys, reload]), () =>
    api.list({ candidateKeys }),
  );
  const run = async (change: () => Promise<unknown>) => {
    setSaveFailed(false);
    try {
      await change();
      setEditing(undefined);
      setReload((value) => value + 1);
      return true;
    } catch {
      setSaveFailed(true);
      return false;
    }
  };
  const now = Date.now();
  const newest = (a: RecruitingCandidateNote, b: RecruitingCandidateNote) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const items = [...(read.data?.items ?? [])].sort(newest);
  const author = (note: RecruitingCandidateNote) =>
    note.createdBy === "agent" ? t`Assistant` : (note.authorName ?? t`You`);
  return (
    <section aria-label={t`Notes`} className="space-y-4 text-sm">
      <NoteForm
        submitLabel={t`Add note`}
        onSave={(body) => run(() => api.create({ candidateKey: createKey, roleId, body }))}
      />
      {saveFailed ? (
        <TabNotice alert>
          <Trans>Could not save the note.</Trans>
        </TabNotice>
      ) : null}
      {read.loading ? <TabLoading /> : null}
      {read.failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load notes.</Trans>
        </RetryNotice>
      ) : null}
      {read.data && !items.length ? (
        <TabNotice>
          <Trans>No notes yet.</Trans>
        </TabNotice>
      ) : null}
      {items.length ? (
        <ul className="space-y-2">
          {items.map((note) =>
            editing === note.id ? (
              <li key={note.id}>
                <NoteForm
                  initial={note.body}
                  submitLabel={t`Save`}
                  onCancel={() => setEditing(undefined)}
                  onSave={(body) => run(() => api.update({ id: note.id, body }))}
                />
              </li>
            ) : (
              <li key={note.id} className="rounded-lg border px-3 py-2">
                <p className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {author(note)}
                  </span>
                  <time dateTime={note.createdAt} title={formatDate(note.createdAt)}>
                    {relativeTime(note.createdAt, locale, now)}
                  </time>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{note.body}</p>
                <div className="mt-1 flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(note.id)}>
                    <Trans>Edit</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => api.delete({ id: note.id }))}
                  >
                    <Trans>Delete</Trans>
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </section>
  );
}
