import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Group,
  ListRecruitingContactsOutput,
  RecruitingContact,
  RecruitingContactFilters,
} from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Textarea,
} from "@rakazo/ui-web";
import { ChevronDown, ListFilter, Mail, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { writeComposerDraft } from "../../lib/composer-draft";
import { rpc } from "../../lib/rpc";
import { AddToSequenceDialog } from "./AddToSequenceDialog";
import { CompanyLogo } from "./CompanyLogo";
import type { RecruitingDetailTarget } from "./detail";
import { pendingDetailTarget, useRecruitingDetail } from "./detail";
import { LinkedInIcon } from "./LinkedInIcon";
import { PersonAvatar } from "./ProfileImage";
import { ProfileMailIcon } from "./ProfileMailIcon";
import { profileImageUrl } from "./profileAssets";
import { RetryNotice } from "./RetryNotice";
import { statusText, TabLoading } from "./shared";

const PAGE_SIZE = 50;
const EXPORT_MAX = 5000;
const DAY_MS = 86_400_000;

function websiteHost(value: string | null) {
  const url = profileImageUrl(value);
  return url ? new URL(url).hostname : null;
}

type Facets = Awaited<ReturnType<typeof rpc.recruiting.contacts.facets>>;
type TextKey = "location" | "company" | "title" | "school" | "skills";
type DateKey = "added" | "contacted" | "replied";
type FlagKey = "contacted" | "replied" | "shortlisted";

/** Everyone across the account's roles and CRM in one filterable list. */
export function AllContacts({
  groups,
  refreshSignal,
  spaceId,
}: {
  groups: readonly Group[];
  refreshSignal: number;
  spaceId?: string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get("query") ?? "";
  const detail = useRecruitingDetail();
  const [query, setQuery] = useState(urlQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(urlQuery.trim());
  useEffect(() => setQuery(urlQuery), [urlQuery]);
  const [filters, setFilters] = useState<RecruitingContactFilters>({});
  const [text, setText] = useState<Partial<Record<TextKey, string>>>({});
  const [days, setDays] = useState<Partial<Record<DateKey, number>>>({});
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<{
    key: string;
    data: ListRecruitingContactsOutput;
  }>();
  const [failed, setFailed] = useState(false);
  const [facets, setFacets] = useState<Facets>();
  const [enroll, setEnroll] = useState(false);
  const [selected, setSelected] = useState<Map<string, RecruitingContact>>(new Map());
  const [dialog, setDialog] = useState<"tag" | "activity">();
  const [dialogText, setDialogText] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!location.state?.recruitingSearch) return;
    setQuery(urlQuery);
    setDebouncedQuery(urlQuery.trim());
    setFilters({});
    setText({});
    setDebouncedText({});
    setDays({});
    setOffset(0);
  }, [location.key]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const [debouncedText, setDebouncedText] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const request = useMemo(() => {
    const now = Date.now();
    const since = (key: DateKey) =>
      days[key] ? new Date(now - days[key]! * DAY_MS).toISOString() : undefined;
    const trimmed = Object.fromEntries(
      Object.entries(debouncedText)
        .map(([key, value]) => [key, value?.trim()])
        .filter(([, value]) => value),
    );
    return {
      ...filters,
      ...trimmed,
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
      ...(since("added") ? { addedAfter: since("added") } : {}),
      ...(since("contacted") ? { contactedAfter: since("contacted") } : {}),
      ...(since("replied") ? { repliedAfter: since("replied") } : {}),
    } satisfies RecruitingContactFilters;
  }, [filters, debouncedText, debouncedQuery, days]);
  const filterKey = JSON.stringify(request);
  const readKey = JSON.stringify([filterKey, offset, reload, refreshSignal]);

  // A new filter starts from the first page with nothing selected.
  useEffect(() => {
    setOffset(0);
    setSelected(new Map());
  }, [filterKey]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    rpc.recruiting.contacts
      .list({
        filters: request,
        limit: PAGE_SIZE,
        ...(offset ? { cursor: String(offset) } : {}),
      })
      .then((data) => {
        if (!cancelled) setPage({ key: readKey, data });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [readKey]);

  useEffect(() => {
    void rpc.recruiting.contacts
      .facets({})
      .then(setFacets)
      .catch(() => undefined);
  }, [refreshSignal, reload]);

  const data = page?.data;
  const loading = page?.key !== readKey && !failed;
  const rows = data?.items ?? [];
  const allOnPage = rows.length > 0 && rows.every((row) => selected.has(row.personKey));
  function profileTarget(index: number): RecruitingDetailTarget | undefined {
    const person = rows[index];
    const home = person?.roles.find((role) => role.threadId && role.groupId && role.candidateKey);
    if (!person) return undefined;
    const crm = Boolean(home?.candidateKey?.startsWith("crm:"));
    return {
      view: "contact",
      collection: { label: t`Contacts`, index, total: rows.length },
      crm,
      role:
        home && spaceId
          ? { roleId: home.id, spaceId, conversation: { groupId: home.groupId! } }
          : null,
      person: {
        candidateId:
          home?.candidateKey?.replace(/^crm:/, "") ?? person.noteKey.replace(/^crm:/, ""),
        searchCandidateKey: home?.candidateKey && !crm ? home.candidateKey : undefined,
        name: person.name ?? person.email ?? t`Unnamed`,
        email: person.email,
        title: person.title,
        company: person.company,
        location: person.location,
        linkedinUrl: person.linkedinUrl,
        savedProfile: person.savedProfile,
        profileImageUrl: person.profileImageUrl,
        companyLogoUrl: person.companyLogoUrl,
        companyWebsiteUrl: person.companyWebsiteUrl,
        roles: person.roles,
      },
      walk: (step) => profileTarget(index + step),
    };
  }
  useEffect(() => {
    if (!detail?.pending) return;
    for (let index = 0; index < rows.length; index++) {
      const target = profileTarget(index);
      const restored = target && pendingDetailTarget(target, detail.pending);
      if (restored) return detail.restore(restored);
    }
  }, [rows, detail?.pending, spaceId]);
  const productRoles = (facets?.roles ?? []).filter((role) => !role.id.startsWith("crm:"));
  const globalGroup = groups.find((group) => group.id.startsWith("recruiting-global-"));

  const toggle = <K extends "statuses" | "roleIds" | "tags">(key: K, value: string) =>
    setFilters((current) => {
      const list = new Set(current[key] ?? []);
      if (list.has(value)) list.delete(value);
      else list.add(value);
      const next = { ...current, [key]: [...list] };
      if (!list.size) delete next[key];
      return next;
    });
  const setFlag = (key: FlagKey, value: string) =>
    setFilters((current) => {
      const next = { ...current };
      if (value === "any") delete next[key];
      else next[key] = value === "yes";
      return next;
    });

  const statusLabel = (status: string) =>
    ({
      shortlisted: t`Shortlisted`,
      saved: t`Saved`,
      on_hold: t`On hold`,
      passed: t`Passed`,
    })[status] ?? statusText(status);
  const textLabels: Record<TextKey, string> = {
    location: t`Location`,
    company: t`Current company`,
    title: t`Job title`,
    school: t`School`,
    skills: t`Skills`,
  };
  const dateLabels: Record<DateKey, string> = {
    added: t`Date added`,
    contacted: t`Last contacted`,
    replied: t`Last replied`,
  };
  const flagLabels: Record<FlagKey, string> = {
    contacted: t`Contacted`,
    replied: t`Replied`,
    shortlisted: t`Shortlisted`,
  };
  const roleTitle = (id: string) => facets?.roles.find((role) => role.id === id)?.title ?? id;

  const people = [...selected.values()];
  const peopleLines = (list: readonly RecruitingContact[]) =>
    list
      .map((person) =>
        [
          person.name ?? person.email ?? t`Unnamed`,
          person.title,
          person.company,
          person.linkedinUrl,
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join("\n");

  /** Hands work that needs the assistant (sending, importing) to it as a draft to review. */
  const askAssistant = (message: string) => {
    if (!globalGroup) return;
    writeComposerDraft(`group:${globalGroup.id}`, message);
    navigate(`/app/g/${encodeURIComponent(globalGroup.id)}?view=conversation`);
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setNotice({ error: false, text: await work() });
    } catch {
      setNotice({ error: true, text: t`Could not finish. Try again.` });
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () =>
    run(async () => {
      let list: RecruitingContact[] = people;
      if (!list.length) {
        list = [];
        let cursor: string | null = null;
        do {
          const next: ListRecruitingContactsOutput = await rpc.recruiting.contacts.list({
            filters: request,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          list.push(...next.items);
          cursor = next.nextCursor;
        } while (cursor && list.length < EXPORT_MAX);
      }
      const header = [
        t`Name`,
        t`Job title`,
        t`Company`,
        t`Location`,
        t`School`,
        t`Email`,
        "LinkedIn",
        t`Roles`,
        t`Tags`,
        t`Status`,
        t`Date added`,
        t`Last contacted`,
        t`Last replied`,
      ];
      const cell = (value: string | null | undefined) => {
        const plain = value ?? "";
        // A leading formula character would run in a spreadsheet; quote everything.
        const safe = /^[=+\-@]/.test(plain) ? `'${plain}` : plain;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const lines = [
        header,
        ...list.map((person) => [
          person.name,
          person.title,
          person.company,
          person.location,
          person.school,
          person.email,
          person.linkedinUrl,
          person.roles.map((role) => role.title).join("; "),
          person.tags.join("; "),
          statusLabel(person.status),
          person.addedAt?.slice(0, 10),
          person.lastContactedAt?.slice(0, 10),
          person.lastRepliedAt?.slice(0, 10),
        ]),
      ].map((line) => line.map(cell).join(","));
      const url = URL.createObjectURL(
        new Blob([`﻿${lines.join("\r\n")}`], {
          type: "text/csv;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "contacts.csv";
      link.click();
      URL.revokeObjectURL(url);
      return t`Exported ${list.length} contacts.`;
    });

  const shortlistIn = (roleId: string) =>
    run(async () => {
      const inRole = people.flatMap((person) => {
        const role = person.roles.find(
          (entry) => entry.id === roleId && entry.threadId && entry.revision !== null,
        );
        return role ? [{ person, role }] : [];
      });
      for (const { role } of inRole.filter(({ role }) => !role.shortlisted))
        await rpc.recruiting.setCandidateShortlist({
          threadId: role.threadId!,
          roleId,
          candidateKey: role.candidateKey!,
          expectedRevision: role.revision!,
          shortlisted: true,
        });
      const missing = people.filter((person) => !inRole.some((entry) => entry.person === person));
      if (missing.length)
        askAssistant(
          t`Add these people to the ${roleTitle(roleId)} role and shortlist them:` +
            `\n${peopleLines(missing)}`,
        );
      setReload((value) => value + 1);
      return t`Shortlisted ${inRole.length} in ${roleTitle(roleId)}.`;
    });

  const applyDialog = () =>
    run(async () => {
      const value = dialogText.trim();
      setDialog(undefined);
      setDialogText("");
      if (dialog === "tag") {
        await rpc.recruiting.contacts.updateTags({
          personKeys: people.map((person) => person.personKey),
          add: [value],
        });
        setReload((current) => current + 1);
        return t`Tagged ${people.length} contacts.`;
      }
      for (const person of people)
        await rpc.recruiting.notes.create({
          candidateKey: person.noteKey,
          body: value,
        });
      return t`Logged for ${people.length} contacts.`;
    });

  const activeChips = [
    ...(filters.statuses ?? []).map((value) => ({
      key: `status:${value}`,
      label: `${t`Status`}: ${statusLabel(value)}`,
      clear: () => toggle("statuses", value),
    })),
    ...(filters.roleIds ?? []).map((value) => ({
      key: `role:${value}`,
      label: `${t`Role`}: ${roleTitle(value)}`,
      clear: () => toggle("roleIds", value),
    })),
    ...(filters.tags ?? []).map((value) => ({
      key: `tag:${value}`,
      label: `${t`Tag`}: ${value}`,
      clear: () => toggle("tags", value),
    })),
    ...(Object.keys(flagLabels) as FlagKey[])
      .filter((key) => filters[key] !== undefined)
      .map((key) => ({
        key: `flag:${key}`,
        label: `${flagLabels[key]}: ${filters[key] ? t`Yes` : t`No`}`,
        clear: () => setFlag(key, "any"),
      })),
    ...(Object.keys(days) as DateKey[])
      .filter((key) => days[key])
      .map((key) => ({
        key: `date:${key}`,
        label: `${dateLabels[key]}: ${t`last ${days[key]} days`}`,
        clear: () => setDays((current) => ({ ...current, [key]: undefined })),
      })),
  ];

  return (
    <section aria-label={t`All contacts`} className="min-w-0 space-y-3">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-background py-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            size={15}
            aria-hidden
            className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-9"
            value={query}
            placeholder={t`Search by name, company, etc.`}
            aria-label={t`Search contacts`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t`Refresh contacts`}
          disabled={loading || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={15} aria-hidden />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <ListFilter size={15} aria-hidden />
            <Trans>Filter</Trans>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Trans>Status</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {(facets?.statuses ?? []).map((status) => (
                  <DropdownMenuCheckboxItem
                    key={status}
                    checked={filters.statuses?.includes(status) ?? false}
                    onCheckedChange={() => toggle("statuses", status)}
                  >
                    {statusLabel(status)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Trans>Role</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {(facets?.roles ?? []).map((role) => (
                  <DropdownMenuCheckboxItem
                    key={role.id}
                    checked={filters.roleIds?.includes(role.id) ?? false}
                    onCheckedChange={() => toggle("roleIds", role.id)}
                  >
                    {role.title}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {facets?.tags.length ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Trans>Tags</Trans>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {facets.tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag}
                      checked={filters.tags?.includes(tag) ?? false}
                      onCheckedChange={() => toggle("tags", tag)}
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuSeparator />
            {(Object.keys(textLabels) as TextKey[]).map((key) => (
              <DropdownMenuItem
                key={key}
                onClick={() =>
                  setText((current) => ({
                    ...current,
                    [key]: current[key] ?? "",
                  }))
                }
              >
                {textLabels[key]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {(Object.keys(dateLabels) as DateKey[]).map((key) => (
              <DropdownMenuSub key={key}>
                <DropdownMenuSubTrigger>{dateLabels[key]}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={String(days[key] ?? 0)}
                    onValueChange={(value) =>
                      setDays((current) => ({
                        ...current,
                        [key]: Number(value) || undefined,
                      }))
                    }
                  >
                    {[7, 30, 90].map((count) => (
                      <DropdownMenuRadioItem key={count} value={String(count)}>
                        {t`Last ${count} days`}
                      </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem value="0">{t`Any time`}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            <DropdownMenuSeparator />
            {(Object.keys(flagLabels) as FlagKey[]).map((key) => (
              <DropdownMenuSub key={key}>
                <DropdownMenuSubTrigger>{flagLabels[key]}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={filters[key] === undefined ? "any" : filters[key] ? "yes" : "no"}
                    onValueChange={(value) => setFlag(key, String(value))}
                  >
                    <DropdownMenuRadioItem value="yes">{t`Yes`}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="no">{t`No`}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="any">{t`Any`}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        {people.length ? (
          <span className="text-sm text-muted-foreground">
            <Trans>{people.length} selected</Trans>
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" disabled={busy} />}>
            <Trans>Actions</Trans>
            <ChevronDown size={15} aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              disabled={!globalGroup}
              onClick={() =>
                askAssistant(
                  t`I want to import a contact list. I'll attach the file; add the people to the role I name.`,
                )
              }
            >
              <Trans>Import contacts</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!data?.total} onClick={() => void exportCsv()}>
              <Trans>Export</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!people.length} onClick={() => setDialog("tag")}>
              <Trans>Add tag</Trans>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!people.length || !productRoles.length}>
                <Trans>Shortlist in role</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {productRoles.map((role) => (
                  <DropdownMenuItem key={role.id} onClick={() => void shortlistIn(role.id)}>
                    {role.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              disabled={!people.length || !globalGroup}
              onClick={() => setEnroll(true)}
            >
              <Trans>Add to sequence</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!people.length} onClick={() => setDialog("activity")}>
              <Trans>Log activity</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {people.length ? (
        <div
          role="toolbar"
          aria-label={t`Selected contacts`}
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2"
        >
          <span className="text-sm">
            <Trans>{people.length} selected</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!globalGroup || busy}
            onClick={() => setEnroll(true)}
          >
            <Trans>Add to sequence</Trans>
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("tag")}>
            <Trans>Add tag</Trans>
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void exportCsv()}>
            <Trans>Export selected</Trans>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
            <Trans>Clear selection</Trans>
          </Button>
        </div>
      ) : null}
      {activeChips.length || Object.keys(text).length ? (
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(text) as TextKey[]).map((key) => (
            <span
              key={key}
              className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-3 text-sm"
            >
              {textLabels[key]}:
              <input
                // biome-ignore lint/a11y/noAutofocus: the person just picked this filter to type into
                autoFocus={!text[key]}
                className="w-32 bg-transparent outline-none"
                aria-label={textLabels[key]}
                value={text[key] ?? ""}
                onChange={(event) =>
                  setText((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t`Remove ${textLabels[key]} filter`}
                onClick={() =>
                  setText((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  })
                }
              >
                <X size={12} />
              </Button>
            </span>
          ))}
          {activeChips.map((chip) => (
            <span
              key={chip.key}
              className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-3 text-sm"
            >
              {chip.label}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t`Remove ${chip.label} filter`}
                onClick={chip.clear}
              >
                <X size={12} />
              </Button>
            </span>
          ))}
        </div>
      ) : null}

      {notice ? (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice.text}
        </p>
      ) : null}
      {failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load contacts.</Trans>
        </RetryNotice>
      ) : null}
      {loading && !data ? <TabLoading /> : null}

      {data ? (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {data.total ? (
              <Trans>
                {offset + 1}–{offset + rows.length} of {data.total}
              </Trans>
            ) : (
              <Trans>No contacts match.</Trans>
            )}
          </p>
          {rows.length ? (
            <div className="hire-contact-table-scroll max-h-[65vh] max-w-full overflow-auto rounded-xl border border-border">
              <table className="w-full min-w-[1100px] text-left text-sm" aria-busy={loading}>
                <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <Checkbox
                        aria-label={t`Select all on this page`}
                        checked={allOnPage}
                        indeterminate={
                          !allOnPage && rows.some((row) => selected.has(row.personKey))
                        }
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Map(current);
                            for (const row of rows) {
                              if (checked) next.set(row.personKey, row);
                              else next.delete(row.personKey);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Name</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Roles</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Tags</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Current role</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Company</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Education</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Location</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Status</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Last contacted</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Date added</Trans>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <Trans>Last replied</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((person, index) => {
                    const name = person.name ?? person.email ?? t`Unnamed`;
                    const linkedinUrl = profileImageUrl(person.linkedinUrl);
                    const target = profileTarget(index);
                    return (
                      <tr key={person.personKey} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <Checkbox
                            aria-label={t`Select ${name}`}
                            checked={selected.has(person.personKey)}
                            onCheckedChange={(checked) =>
                              setSelected((current) => {
                                const next = new Map(current);
                                if (checked) next.set(person.personKey, person);
                                else next.delete(person.personKey);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-medium">
                          <div className="flex w-56 min-w-0 items-center gap-2">
                            <PersonAvatar name={name} src={person.profileImageUrl} size="sm" />
                            {target && detail ? (
                              <button
                                type="button"
                                className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                                title={name}
                                aria-haspopup="dialog"
                                onClick={() => detail.open(target)}
                              >
                                {name}
                              </button>
                            ) : (
                              <span className="min-w-0 flex-1 truncate" title={name}>
                                {name}
                              </span>
                            )}
                            {person.email ? (
                              <a
                                className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                href={`mailto:${encodeURIComponent(person.email)}`}
                                aria-label={t`Email ${name}`}
                              >
                                <ProfileMailIcon className="size-4" />
                              </a>
                            ) : null}
                            {linkedinUrl ? (
                              <a
                                className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                href={linkedinUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={t`Open ${name} on LinkedIn`}
                              >
                                <LinkedInIcon className="size-4" />
                              </a>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex max-w-56 flex-wrap gap-1">
                            {person.roles.map((role) => (
                              <span
                                key={role.id}
                                className="rounded-md bg-muted px-2 py-0.5 text-xs"
                              >
                                {role.title}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex max-w-40 flex-wrap gap-1">
                            {!person.tags.length ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setSelected(new Map([[person.personKey, person]]));
                                  setDialog("tag");
                                }}
                              >
                                <Trans>Add tags</Trans>
                              </Button>
                            ) : null}
                            {person.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-md border border-border px-2 py-0.5 text-xs"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="max-w-56 px-3 py-2">{person.title ?? "—"}</td>
                        <td className="px-3 py-2">
                          {person.company ? (
                            <div className="flex w-40 min-w-0 items-center gap-2">
                              <CompanyLogo
                                name={person.company}
                                src={person.companyLogoUrl}
                                host={websiteHost(person.companyWebsiteUrl)}
                                small
                              />
                              <span className="truncate" title={person.company}>
                                {person.company}
                              </span>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {person.school ? (
                            <div className="flex w-40 min-w-0 items-center gap-2">
                              <CompanyLogo
                                name={person.school}
                                src={person.schoolLogoUrl}
                                host={websiteHost(person.schoolWebsiteUrl)}
                                small
                              />
                              <span className="truncate" title={person.school}>
                                {person.school}
                              </span>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2">{person.location ?? "—"}</td>
                        <td className="px-3 py-2">{statusLabel(person.status)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {person.lastContactedAt
                            ? new Date(person.lastContactedAt).toLocaleDateString()
                            : "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {person.addedAt ? new Date(person.addedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {person.lastRepliedAt
                            ? new Date(person.lastRepliedAt).toLocaleDateString()
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.total > PAGE_SIZE ? (
            <div className="sticky bottom-0 z-10 flex min-h-12 items-center gap-2 border-t bg-background py-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!offset || loading}
                onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              >
                <Trans>Previous</Trans>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!data.nextCursor || loading}
                onClick={() => setOffset(Number(data.nextCursor))}
              >
                <Trans>Next</Trans>
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      <AddToSequenceDialog
        open={enroll}
        onOpenChange={setEnroll}
        people={people.map((person) => ({
          key: person.personKey,
          name: person.name ?? person.email ?? t`Unnamed`,
          email: person.email,
          linkedinUrl: person.linkedinUrl,
        }))}
        onContinue={askAssistant}
      />
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "tag" ? (
                <Trans>Add tag to {people.length} contacts</Trans>
              ) : (
                <Trans>Log activity for {people.length} contacts</Trans>
              )}
            </DialogTitle>
          </DialogHeader>
          {dialog === "tag" ? (
            <>
              <Input
                aria-label={t`Tag`}
                value={dialogText}
                maxLength={60}
                list="contact-tags"
                onChange={(event) => setDialogText(event.target.value)}
              />
              <datalist id="contact-tags">
                {(facets?.tags ?? []).map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </>
          ) : (
            <Textarea
              aria-label={t`Activity`}
              value={dialogText}
              maxLength={4000}
              onChange={(event) => setDialogText(event.target.value)}
            />
          )}
          <DialogFooter>
            <Button disabled={!dialogText.trim() || busy} onClick={() => void applyDialog()}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
