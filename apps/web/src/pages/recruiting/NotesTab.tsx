import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCandidateNote } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import { Button, Textarea } from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useState } from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import { readFileAsBase64 } from "../../lib/pending-attachments";
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
  conversation,
}: {
  initial?: string;
  submitLabel: string;
  onSave: (body: string, artifactIds?: string[]) => Promise<boolean>;
  conversation?: { groupId: string } | { botId: string };
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<{ file: File; nonce: string }[]>([]);
  const [uploadFailed, setUploadFailed] = useState(false);
  const ready = Boolean(body.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    try {
      setUploadFailed(false);
      const artifactIds = conversation
        ? await Promise.all(
            files.map(async ({ file, nonce }) => {
              const mimeType = inferAttachmentMimeType(file.name, file.type);
              if (!mimeType) throw new Error("Unsupported attachment");
              const artifact = await rpc.artifacts.create({
                ...conversation,
                name: file.name,
                mimeType,
                contentBase64: await readFileAsBase64(file),
                clientNonce: nonce,
              });
              return artifact.id;
            }),
          )
        : [];
      if ((await onSave(body.trim(), artifactIds.length ? artifactIds : undefined)) && !onCancel) {
        setBody("");
        setFiles([]);
      }
    } catch {
      setUploadFailed(true);
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
      {conversation ? (
        <div className="space-y-2">
          <label className="inline-flex cursor-pointer items-center rounded-md border px-3 py-1.5 text-xs focus-within:outline-2 focus-within:outline-ring">
            <Trans>Add attachment</Trans>
            <input
              type="file"
              multiple
              disabled={saving}
              className="sr-only"
              aria-label={t`Add attachment`}
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                if (
                  files.length + picked.length > ATTACHMENT_MAX_COUNT ||
                  picked.some(
                    (file) =>
                      file.size > ATTACHMENT_MAX_BYTES ||
                      !inferAttachmentMimeType(file.name, file.type),
                  )
                ) {
                  setUploadFailed(true);
                  event.target.value = "";
                  return;
                }
                setUploadFailed(false);
                setFiles((current) => [
                  ...current,
                  ...picked.map((file) => ({ file, nonce: crypto.randomUUID() })),
                ]);
                event.target.value = "";
              }}
            />
          </label>
          {files.length ? (
            <ul className="space-y-1">
              {files.map(({ file, nonce }) => (
                <li key={nonce} className="flex min-w-0 items-center justify-between gap-2 text-xs">
                  <span className="truncate" title={file.name}>
                    {file.name}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    aria-label={t`Remove ${file.name}`}
                    onClick={() =>
                      setFiles((current) => current.filter((entry) => entry.nonce !== nonce))
                    }
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {uploadFailed ? (
        <p role="alert" className="text-xs text-destructive">
          <Trans>
            Could not attach files. Use a supported file up to 10 MB, with at most 4 attachments,
            and retry.
          </Trans>
        </p>
      ) : null}
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
  conversation,
}: {
  roleId: string;
  candidateKeys: string[];
  createKey: string;
  conversation?: { groupId: string } | { botId: string };
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
        conversation={conversation}
        onSave={(body, artifactIds) =>
          run(() =>
            api.create({
              candidateKey: createKey,
              roleId,
              body,
              ...(artifactIds ? { artifactIds } : {}),
            }),
          )
        }
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
                {note.attachments.length ? (
                  <ul className="mt-2 space-y-1">
                    {note.attachments.map((artifact) => (
                      <li key={artifact.id}>
                        <Button
                          size="sm"
                          variant="link"
                          className="max-w-full justify-start truncate"
                          onClick={() =>
                            void (async () => {
                              try {
                                const saved = await rpc.artifacts.getById({
                                  artifactId: artifact.id,
                                });
                                downloadArtifactBytes(
                                  saved.name,
                                  saved.mimeType,
                                  decodeArtifactBase64(saved.contentBase64),
                                );
                              } catch {
                                setSaveFailed(true);
                              }
                            })()
                          }
                        >
                          {artifact.name}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
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
