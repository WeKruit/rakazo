import { Trans, useLingui } from "@lingui/react/macro";
import { type Bot, GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, type Group } from "@rakazo/contracts";
import { resolveMentionPickerKey } from "@rakazo/core";
import { BotAvatar, Button, Input, Textarea } from "@rakazo/ui-web";
import { ArrowRight, Check, Paperclip, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isFileDrag, isFilePaste } from "../lib/pending-attachments";
import { errorText } from "../lib/user-error";
import { DeleteItemDialog } from "./shell/dialogs";

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function MemberPicker({
  bots,
  selected,
  onChange,
  maxHeight,
}: {
  bots: Bot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxHeight: "max-h-[240px]" | "max-h-[280px]";
}) {
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    if (selected.includes(botId)) {
      onChange(selected.filter((id) => id !== botId));
    } else if (selected.length < GROUP_MEMBER_MAX) {
      onChange([...selected, botId]);
    }
  }

  return (
    <div className={`mt-2 ${maxHeight} space-y-1 overflow-y-auto`}>
      {selectable.map((bot) => {
        const checked = selected.includes(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            aria-pressed={checked}
            onClick={() => toggle(bot.id)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start ${
              checked ? "bg-muted" : "hover:bg-accent"
            }`}
          >
            <BotAvatar color={bot.color} identity={bot.id} size={32} status={bot.status} />
            <span className="flex-1 text-[15px] text-foreground" dir="auto">
              {bot.name}
            </span>
            {checked ? <Check size={14} className="text-muted-foreground" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function CreateGroupForm({
  bots,
  recruiting = false,
  initialDescription = "",
  attachments = [],
  attachmentNotice,
  attachmentAccept,
  onAttachmentPick,
  onRemoveAttachment,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  recruiting?: boolean;
  initialDescription?: string;
  attachments?: readonly { id: string; file: File; previewUrl?: string }[];
  attachmentNotice?: string | null;
  attachmentAccept?: string;
  onAttachmentPick?: (files: FileList | null) => boolean;
  onRemoveAttachment?: (id: string) => void;
  onCancel: () => void;
  onCreate: (input: { name: string; botIds: string[]; description?: string }) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [selection, setSelected] = useState<string[]>([]);
  const selected = recruiting
    ? bots.filter((bot) => !bot.archivedAt).map((bot) => bot.id)
    : selection;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleName = recruiting ? t`New role` : name.trim();
  const canCreate =
    validSelection(roleName, selected) &&
    (!recruiting || Boolean(description.trim()) || attachments.length > 0);

  async function create() {
    if (submitting || !canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: roleName,
        botIds: selected,
        ...(recruiting ? { description: description.trim() } : {}),
      });
    } catch (cause) {
      setError(errorText(cause, recruiting ? t`Could not create role` : t`Could not create group`));
    } finally {
      setSubmitting(false);
    }
  }

  if (recruiting) {
    return (
      <div className="hire-new">
        <div className="hire-new-inner">
          <Button
            variant="ghost"
            size="icon-sm"
            className="hire-new-cancel"
            aria-label={t`Cancel new role`}
            disabled={submitting}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </Button>
          <h1>
            <Trans>Who are you looking for?</Trans>
          </h1>
          <fieldset
            aria-label={t`Job description and files`}
            className="hire-composer"
            onDragOver={(event) => {
              if (onAttachmentPick && isFileDrag(event.dataTransfer)) event.preventDefault();
            }}
            onDrop={(event) => {
              if (onAttachmentPick && isFileDrag(event.dataTransfer)) {
                event.preventDefault();
                if (!submitting) onAttachmentPick(event.dataTransfer.files);
              }
            }}
          >
            <Textarea
              aria-label={t`Job description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                const action = resolveMentionPickerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  enterToSend: true,
                  isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                  optionCount: 0,
                  highlightedIndex: 0,
                });
                if (action.type === "send") {
                  event.preventDefault();
                  void create();
                }
              }}
              onPaste={(event) => {
                if (submitting || !onAttachmentPick || !isFilePaste(event.clipboardData)) return;
                event.preventDefault();
                onAttachmentPick(event.clipboardData.files);
                const text = event.clipboardData.getData("text/plain");
                if (text)
                  setDescription(
                    `${description.slice(0, event.currentTarget.selectionStart)}${text}${description.slice(event.currentTarget.selectionEnd)}`,
                  );
              }}
              placeholder={t`Start with a role title or paste a job description…`}
              disabled={submitting}
            />
            {attachmentNotice ? (
              <p role="status" className="px-5 text-sm">
                {attachmentNotice}
              </p>
            ) : null}
            {attachments.length ? (
              <ul className="flex flex-wrap gap-2 px-5 pb-3">
                {attachments.map((attachment) => (
                  <li
                    key={attachment.id}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-sm"
                  >
                    {attachment.previewUrl ? (
                      <img
                        src={attachment.previewUrl}
                        alt=""
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <Paperclip size={14} aria-hidden />
                    )}
                    <span>{attachment.file.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Remove ${attachment.file.name}`}
                      disabled={submitting}
                      onClick={() => onRemoveAttachment?.(attachment.id)}
                    >
                      <X size={14} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="hire-composer-actions">
              {onAttachmentPick ? (
                <>
                  <input
                    ref={fileInput}
                    aria-label={t`Attach role files`}
                    type="file"
                    multiple
                    accept={attachmentAccept}
                    hidden
                    disabled={submitting}
                    onChange={(event) => {
                      onAttachmentPick(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t`Attach file or screenshot`}
                    disabled={submitting}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip size={16} aria-hidden />
                    <Trans>Attach</Trans>
                  </Button>
                </>
              ) : null}
              <Button disabled={submitting || !canCreate} onClick={() => void create()}>
                {submitting ? <Trans>Creating…</Trans> : <Trans>Continue</Trans>}
                <ArrowRight size={15} aria-hidden="true" />
              </Button>
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this group`}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members (pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[280px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={submitting || !canCreate}
        onClick={() => void create()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
      </Button>
    </div>
  );
}

export function GroupSettings({
  group,
  bots,
  onSave,
  onRemove,
  onClose,
  covered = false,
}: {
  group: Group;
  bots: Bot[];
  onSave: (input: { name?: string; botIds?: string[] }) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
  /** A full-screen overlay is on top, so Escape belongs to it. */
  covered?: boolean;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Closing while a save is in flight would let its completion close the panel
  // again after a reopen. While the delete confirmation or an overlay is open,
  // Escape belongs to it.
  useEffect(() => {
    if (saving || confirmingDelete || covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, confirmingDelete, covered, onClose]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim() !== group.name ? name.trim() : undefined,
        botIds: sameMembers(
          selected,
          group.members.map((member) => member.botId),
        )
          ? undefined
          : selected,
      });
    } catch (cause) {
      setError(errorText(cause, t`Could not save group`));
      return;
    } finally {
      setSaving(false);
    }
    // A save that finishes after the user switched chats must not close
    // whatever panel is open there.
    if (mounted.current) onClose();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close panel`}
          disabled={saving}
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[240px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={saving || !validSelection(name, selected)}
        onClick={() => void save()}
      >
        {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={saving}
        onClick={() => setConfirmingDelete(true)}
      >
        <Trans>Delete group</Trans>
      </Button>
      {confirmingDelete ? (
        <DeleteItemDialog
          item={group}
          noun="group"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onRemove}
        />
      ) : null}
    </div>
  );
}

export { memberName } from "./shell/group-members";
