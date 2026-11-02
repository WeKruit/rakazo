import { Trans, useLingui } from "@lingui/react/macro";
import type {
  GlobalRecruitingInboxOutput,
  RecruitingContact,
  RecruitingSearchTarget,
} from "@rakazo/contracts";
import {
  Button,
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@rakazo/ui-web";
import { BriefcaseBusiness, Mail, Search, Send, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { PersonAvatar } from "./ProfileImage";
import { campaignName } from "./SequenceTab";

export function recruitingTargetHref(target: RecruitingSearchTarget) {
  const query = new URLSearchParams({
    view: target.kind === "role" ? "conversation" : "sequence",
  });
  if (target.campaignId) query.set("campaign", target.campaignId);
  if (target.serverId) query.set("campaignServer", target.serverId);
  return `${target.groupId ? `/app/g/${encodeURIComponent(target.groupId)}` : target.botId ? `/app/${encodeURIComponent(target.botId)}` : "/app"}?${query}`;
}

export function recruitingContactHref(person: RecruitingContact, query: string) {
  const home = person.roles.find((role) => role.threadId && role.groupId && role.candidateKey);
  const id = home?.candidateKey?.replace(/^crm:/, "") ?? person.noteKey.replace(/^crm:/, "");
  return `/app?${new URLSearchParams({ view: "contacts", role: "all", query, detail: `contact.${id}` })}`;
}

type Results = {
  key: string;
  contacts: RecruitingContact[];
  targets: RecruitingSearchTarget[];
  mail: GlobalRecruitingInboxOutput["items"];
  moreContacts: boolean;
  moreMail: boolean;
  failed: boolean;
  pending: number;
};

/** Search existing owned stores, never fetch providers or copy records into another index. */
export function RecruitingGlobalSearch({
  open,
  onOpenChange,
  spaceId,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId?: string;
  onNavigate: (href: string) => void;
}) {
  const { t } = useLingui();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>();
  const [retry, setRetry] = useState(0);
  const needle = query.trim();
  const key = JSON.stringify([spaceId, needle, retry]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(undefined);
    }
  }, [open]);
  useEffect(() => {
    if (!open || !spaceId || !needle) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      let next: Results = {
        key,
        contacts: [],
        targets: [],
        mail: [],
        moreContacts: false,
        moreMail: false,
        failed: false,
        pending: 3,
      };
      setResults(next);
      const complete = (change: Partial<Results>) => {
        if (abort.signal.aborted) return;
        next = { ...next, ...change, pending: next.pending - 1 };
        setResults(next);
      };
      const failed = () => complete({ failed: true });
      void rpc.recruiting.contacts
        .list({ filters: { query: needle }, sort: "name", limit: 8 }, { signal: abort.signal })
        .then(
          (contacts) =>
            complete({ contacts: contacts.items, moreContacts: Boolean(contacts.nextCursor) }),
          failed,
        );
      void rpc.search
        .recruitingTargets({ q: needle }, { signal: abort.signal })
        .then((targets) => complete({ targets: targets.items }), failed);
      void rpc.recruiting
        .globalInbox({ spaceId, query: needle, limit: 8 }, { signal: abort.signal })
        .then((mail) => complete({ mail: mail.items, moreMail: Boolean(mail.nextCursor) }), failed);
    }, 300);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [open, spaceId, needle, key]);
  const current = results?.key === key && needle ? results : undefined;
  const loading = Boolean(open && spaceId && needle && (!current || current.pending > 0));
  const navigate = (href: string) => {
    onNavigate(href);
    onOpenChange(false);
  };
  const roles = current?.targets.filter((target) => target.kind === "role") ?? [];
  const sequences = current?.targets.filter((target) => target.kind === "sequence") ?? [];
  const count =
    (current?.targets.length ?? 0) + (current?.contacts.length ?? 0) + (current?.mail.length ?? 0);
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`Search`}
      description={t`Search roles, contacts, sequences and saved mail.`}
      className="sm:max-w-2xl"
      initialFocus={searchInput}
    >
      <Command shouldFilter={false}>
        <CommandInput
          ref={searchInput}
          value={query}
          onValueChange={setQuery}
          maxLength={200}
          placeholder={t`Search`}
          aria-label={t`Global search`}
        />
        <CommandList className="max-h-[min(70dvh,640px)]" aria-busy={loading}>
          {!needle ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">
              <Trans>Search roles, contacts, sequences and saved mail.</Trans>
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="px-4 py-5 text-sm text-muted-foreground">
              <Trans>Searching…</Trans>
            </p>
          ) : null}
          {current?.failed ? (
            <div
              role="status"
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <Trans>Some results could not be loaded.</Trans>
              <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {current && !loading && !current.failed && count === 0 ? (
            <p role="status" className="px-4 py-5 text-sm text-muted-foreground">
              <Trans>No results</Trans>
            </p>
          ) : null}
          {roles.length ? (
            <CommandGroup heading={t`Roles`}>
              {roles.map((target) => (
                <CommandItem
                  key={target.roleId}
                  value={`role:${target.roleId}`}
                  onSelect={() => navigate(recruitingTargetHref(target))}
                >
                  <BriefcaseBusiness aria-hidden />
                  <span className="truncate" dir="auto">
                    {target.title}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {current?.contacts.length ? (
            <CommandGroup heading={t`Contacts`}>
              {current.contacts.map((person) => (
                <CommandItem
                  key={person.personKey}
                  value={`contact:${person.personKey}`}
                  onSelect={() => navigate(recruitingContactHref(person, needle))}
                >
                  <PersonAvatar
                    name={person.name ?? person.email ?? t`Unnamed`}
                    src={person.profileImageUrl}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p className="truncate" dir="auto">
                      {person.name ?? person.email ?? t`Unnamed`}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" dir="auto">
                      {[person.title, person.company, person.email].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </CommandItem>
              ))}
              {current.moreContacts ? (
                <CommandItem
                  value="more-contacts"
                  onSelect={() =>
                    navigate(
                      `/app?${new URLSearchParams({ view: "contacts", role: "all", query: needle })}`,
                    )
                  }
                >
                  <Users aria-hidden />
                  <Trans>View all contacts</Trans>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}
          {sequences.length ? (
            <CommandGroup heading={t`Sequence`}>
              {sequences.map((target) => (
                <CommandItem
                  key={`${target.roleId}:${target.serverId}:${target.campaignId}`}
                  value={`sequence:${target.roleId}:${target.serverId}:${target.campaignId}`}
                  onSelect={() => navigate(recruitingTargetHref(target))}
                >
                  <Send aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate" dir="auto">
                      {campaignName(target.title)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" dir="auto">
                      {target.roleTitle}
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {current?.mail.length ? (
            <CommandGroup heading={t`Inbox`}>
              {current.mail.map((item) => (
                <CommandItem
                  key={`${item.roleId}:${item.key}`}
                  value={`mail:${item.roleId}:${item.key}`}
                  onSelect={() =>
                    navigate(
                      `/app?${new URLSearchParams({ view: "inbox", role: "all", query: needle, mailThread: item.key })}`,
                    )
                  }
                >
                  <Mail aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate" dir="auto">
                      {item.email.subject || t`No subject`}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" dir="auto">
                      {item.person?.name || item.email.sender || t`Unknown sender`}
                    </p>
                  </div>
                </CommandItem>
              ))}
              {current.moreMail ? (
                <CommandItem
                  value="more-mail"
                  onSelect={() =>
                    navigate(
                      `/app?${new URLSearchParams({ view: "inbox", role: "all", query: needle })}`,
                    )
                  }
                >
                  <Search aria-hidden />
                  <Trans>View all messages</Trans>
                </CommandItem>
              ) : null}
              <p className="px-2 py-2 text-xs text-muted-foreground">
                <Trans>Mail results include indexed saved messages.</Trans>
              </p>
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
