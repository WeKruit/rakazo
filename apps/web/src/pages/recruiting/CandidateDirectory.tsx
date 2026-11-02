import { Trans, useLingui } from "@lingui/react/macro";
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import type { VirtualItem } from "@tanstack/react-virtual";
import { LayoutGrid, MapPin, Table2 } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { preloadCandidateDetail } from "../shell/preload-detail";
import { CandidateWindow } from "./CandidateWindow";
import { CompanyLogo } from "./CompanyLogo";
import { PersonAvatar } from "./ProfileImage";
import { ProfileSourceIcon } from "./ProfileSourceIcon";
import type { ProfileCriterionRevision } from "./profile";
import { candidateSections, withSavedProfile } from "./profile";
import {
  organizationLogo,
  profileAssets,
  profileContentFields,
  profileImageUrl,
} from "./profileAssets";
import { parseTimeline, structuredProfileTimeline } from "./profileTimelineModel";
import { organizationHosts, organizationKey } from "./quickOutput";
import { statusText } from "./shared";
import type { RoleCandidate } from "./useRoleCandidates";

export type CandidateDirectoryProps = {
  rows: readonly RoleCandidate[];
  board?: boolean;
  ownerName?: string;
  selection?: { keys: ReadonlySet<string>; set: (keys: Set<string>) => void };
  criterionRevision?: ProfileCriterionRevision;
  selectedKey?: string;
  toolbar?: ReactNode;
  onOpen: (row: RoleCandidate, index: number, trigger: HTMLElement) => void;
  renderActions?: (row: RoleCandidate, index: number) => ReactNode;
};

function directoryProfile(row: RoleCandidate, revision?: ProfileCriterionRevision) {
  const fields = withSavedProfile(
    row.autumn?.savedProfile,
    row.autumn?.latestSource?.report?.fields ?? [],
  );
  const company = row.crm?.company ?? row.autumn?.company ?? null;
  const assets = profileAssets(fields, company);
  const sections = candidateSections(profileContentFields(fields), {
    roleRevisionId: row.autumn?.latestSource?.roleRevisionId,
    revision,
  });
  const now = new Date();
  const school =
    sections.education.flatMap((field) =>
      field.structuredValue === undefined
        ? []
        : structuredProfileTimeline(field.structuredValue, "education", now, field.sourceUrlsById),
    )[0] ?? parseTimeline(sections.education[0]?.value, "education", now)[0];
  const hosts = organizationHosts(sections.quick.entities, {
    name: company,
    host: sections.company.host,
  });
  const host = (name: string | null | undefined) =>
    name ? hosts.get(organizationKey(name)) : undefined;
  return {
    ranking: row.autumn?.ranking,
    company,
    companyHost: host(company),
    assets,
    sections,
    school,
    schoolHost: school?.website ?? host(school?.primary),
    profileUrl: profileImageUrl(row.linkedinUrl),
  };
}

type DirectoryProfile = ReturnType<typeof directoryProfile>;

function OrganizationName({ name, href }: { name: string; href: string | null }) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-words hover:underline focus-visible:underline"
    >
      {name}
    </a>
  ) : (
    <span className="break-words">{name}</span>
  );
}

// Row cells take only stable per-row values, so opening a person re-renders just the selection.
const Company = memo(function Company({
  profile,
  title,
  companyOnly = false,
}: {
  profile: DirectoryProfile;
  title: string | null;
  companyOnly?: boolean;
}) {
  const { company, assets } = profile;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {company ? (
        <span className="shrink-0 [&>span]:size-6 [&>span]:text-[9px]">
          <CompanyLogo
            name={company}
            src={organizationLogo(company, assets.company)}
            host={profile.companyHost}
          />
        </span>
      ) : null}
      <div className="min-w-0">
        <p className="truncate font-medium" title={title ?? undefined}>
          {companyOnly && company ? (
            <OrganizationName name={company} href={organizationLogo(company, assets.companyLink)} />
          ) : (
            (title ?? "—")
          )}
        </p>
        {company && !companyOnly ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={company}>
            <OrganizationName name={company} href={organizationLogo(company, assets.companyLink)} />
          </p>
        ) : null}
      </div>
    </div>
  );
});

const Education = memo(function Education({
  profile,
  compact = false,
}: {
  profile: DirectoryProfile;
  compact?: boolean;
}) {
  const { school, assets } = profile;
  if (!school) return <span className="text-muted-foreground">—</span>;
  return (
    <div className={`flex min-w-0 items-center ${compact ? "gap-2" : "gap-2.5"}`}>
      <span className={compact ? "shrink-0 [&>span]:size-6 [&>span]:text-[9px]" : "shrink-0"}>
        <CompanyLogo
          name={school.primary}
          src={profileImageUrl(school.logoUrl) ?? organizationLogo(school.primary, assets.school)}
          host={profile.schoolHost}
        />
      </span>
      <div className="min-w-0">
        <p
          className={`${compact ? "truncate" : "line-clamp-2 break-words"} text-xs font-medium`}
          title={[school.primary, school.secondary, school.dateLabel].filter(Boolean).join(" · ")}
        >
          <OrganizationName
            name={school.primary}
            href={
              profileImageUrl(school.organizationUrl) ??
              organizationLogo(school.primary, assets.schoolLink)
            }
          />
        </p>
        {school.secondary ? (
          <p
            className={`mt-0.5 ${compact ? "truncate" : "line-clamp-2 break-words"} text-xs text-muted-foreground`}
            title={school.secondary}
          >
            {school.secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
});

const Fit = memo(function Fit({
  sections,
  compact = false,
  ranking,
}: {
  ranking?: DirectoryProfile["ranking"];
  sections: DirectoryProfile["sections"];
  compact?: boolean;
}) {
  const { t } = useLingui();
  const score = ranking
    ? ranking.state === "outdated" || ranking.score === null
      ? null
      : { label: t`Saved match score`, value: ranking.score.toLocaleString() }
    : sections.fit?.score;
  const groupLabel =
    ranking?.group === "strong_match"
      ? t`Strong Match`
      : ranking?.group === "worth_talking"
        ? t`Worth Talking`
        : ranking?.group === "partial"
          ? t`Partial`
          : ranking?.group === "uncertain"
            ? t`Uncertain`
            : ranking?.group === "outdated"
              ? t`Outdated review`
              : ranking?.group === "unreviewed"
                ? t`Unreviewed`
                : ranking?.group === "unscored"
                  ? t`Unscored`
                  : null;
  const tier = groupLabel
    ? { label: ranking?.grade ?? groupLabel, value: groupLabel }
    : sections.fit?.tier;
  const criteria = sections.requirements.slice(0, 2);
  if (!score && !tier && !criteria.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      {score || tier ? (
        <div className="flex flex-wrap gap-1">
          {score ? (
            <Badge variant="secondary" title={score.label}>
              {score.value}
            </Badge>
          ) : null}
          {tier ? (
            <Badge variant="outline" title={tier.label}>
              {tier.value}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {criteria.length ? (
        <details open={!compact} className="text-xs">
          <summary className={compact ? "cursor-pointer text-muted-foreground" : "hidden"}>
            <Trans>Criteria</Trans>
          </summary>
          {criteria.map((criterion) => {
            const name =
              criterion.label ?? (criterion.criterionId ? t`Criterion name unavailable` : null);
            const status =
              criterion.status === "match"
                ? t`Match`
                : criterion.status === "gap"
                  ? t`Gap`
                  : criterion.status === "partial"
                    ? t`Partial match`
                    : t`Unknown`;
            return (
              <p key={criterion.key} className="flex items-start gap-1.5 text-xs">
                <span
                  className={`mt-1 size-1.5 shrink-0 rounded-full ${
                    criterion.status === "match"
                      ? "bg-success"
                      : criterion.status === "gap"
                        ? "bg-destructive"
                        : criterion.status === "partial"
                          ? "bg-warning"
                          : "bg-muted-foreground"
                  }`}
                  aria-hidden
                />
                <span
                  className={
                    compact ? "flex min-w-0 flex-1 items-center gap-1" : "min-w-0 break-words"
                  }
                  title={
                    compact
                      ? [name, criterion.criterionId, status].filter(Boolean).join(" · ")
                      : undefined
                  }
                >
                  {name ? (
                    <span className={compact ? "truncate font-medium" : "font-medium"}>
                      {name} ·{" "}
                    </span>
                  ) : null}
                  {criterion.criterionId ? (
                    <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                      {criterion.criterionId} ·{" "}
                    </span>
                  ) : null}
                  <span
                    className={compact ? "shrink-0 text-muted-foreground" : "text-muted-foreground"}
                  >
                    {status}
                  </span>
                </span>
              </p>
            );
          })}
        </details>
      ) : null}
    </div>
  );
});

const Status = memo(function Status({ row }: { row: RoleCandidate }) {
  const activity =
    row.crm?.stage ||
    (row.autumn?.decision === "hold"
      ? "on_hold"
      : row.autumn?.decision === "pass"
        ? "passed"
        : null);
  return (
    <div className="flex flex-wrap gap-1">
      {activity ? (
        <Badge variant="outline" className="max-w-full whitespace-normal break-words">
          {statusText(activity)}
        </Badge>
      ) : null}
      {row.autumn?.shortlisted ? (
        <Badge variant="secondary">
          <Trans>Shortlisted</Trans>
        </Badge>
      ) : null}
      {!activity && !row.autumn?.shortlisted ? (
        <span className="text-muted-foreground">—</span>
      ) : null}
    </div>
  );
});

/** Source-only contact presentation. Loading, permissions, writes and profile navigation stay with the caller. */
export function CandidateDirectory({
  rows,
  board = false,
  ownerName,
  selection,
  criterionRevision,
  selectedKey,
  toolbar,
  onOpen,
  renderActions,
}: CandidateDirectoryProps) {
  const { t } = useLingui();
  const [view, setView] = useState<"table" | "cards" | "board">("table");
  useEffect(preloadCandidateDetail, []);
  const profiles = useMemo(
    () => rows.map((row) => directoryProfile(row, criterionRevision)),
    [rows, criterionRevision],
  );
  const itemKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const offsets = useRef({
    table: { offset: 0, measurements: [] as VirtualItem[] },
    cards: { offset: 0, measurements: [] as VirtualItem[] },
  });
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set());
  const showEducation =
    !hiddenColumns.has("education") && profiles.some((profile) => profile.school);
  // Fit is the research provider's own assessment; people from the quick search have none yet.
  const showFit = profiles.some(
    (profile) =>
      !hiddenColumns.has("fit") &&
      (profile.ranking || profile.sections.fit || profile.sections.requirements.length),
  );
  const sourceLink = (profile: DirectoryProfile, name: string) =>
    profile.profileUrl ? (
      <a
        href={profile.profileUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={t`Open ${name}'s source profile`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        {view !== "table" ? <Trans>Profile</Trans> : null}
        <ProfileSourceIcon href={profile.profileUrl} className="size-4 shrink-0" />
      </a>
    ) : null;
  const recordedStage = (row: RoleCandidate) =>
    row.crm?.stage ||
    (row.autumn?.decision === "hold"
      ? t`On hold`
      : row.autumn?.decision === "pass"
        ? t`Passed`
        : row.autumn?.shortlisted
          ? t`Shortlisted`
          : t`Saved`);
  const nameButton = (row: RoleCandidate, index: number) => (
    <button
      type="button"
      data-candidate-name
      aria-haspopup="dialog"
      aria-current={selectedKey === row.key ? "true" : undefined}
      className={`${view === "table" ? "truncate" : "line-clamp-2 break-words"} w-full text-left font-semibold hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2`}
      title={row.name ?? undefined}
      onClick={(event) => onOpen(row, index, event.currentTarget)}
    >
      {row.name ?? t`Unnamed candidate`}
    </button>
  );
  if (!rows.length) return null;
  return (
    <div className="min-w-0 space-y-2">
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 bg-background py-2">
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
            <Trans>Display columns</Trans>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {[
              ["education", t`Education`],
              ["location", t`Location`],
              ["fit", t`Fit`],
            ].map(([key, label]) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={!hiddenColumns.has(key!)}
                onCheckedChange={(checked) =>
                  setHiddenColumns((current) => {
                    const next = new Set(current);
                    if (checked) next.delete(key!);
                    else next.add(key!);
                    return next;
                  })
                }
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <fieldset className="ml-auto flex min-w-0 justify-end" aria-label={t`Contact layout`}>
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            <Button
              size="sm"
              variant={view === "table" ? "secondary" : "ghost"}
              aria-pressed={view === "table"}
              onClick={() => setView("table")}
            >
              <Table2 size={14} aria-hidden />
              <Trans>Table</Trans>
            </Button>
            <Button
              size="sm"
              variant={view === "cards" ? "secondary" : "ghost"}
              aria-pressed={view === "cards"}
              onClick={() => setView("cards")}
            >
              <LayoutGrid size={14} aria-hidden />
              <Trans>Cards</Trans>
            </Button>
            {board ? (
              <Button
                size="sm"
                variant={view === "board" ? "secondary" : "ghost"}
                aria-pressed={view === "board"}
                onClick={() => setView("board")}
              >
                <LayoutGrid size={14} aria-hidden />
                <Trans>Board</Trans>
              </Button>
            ) : null}
          </div>
        </fieldset>
      </div>
      {view === "board" ? (
        <section
          className="flex max-w-full gap-3 overflow-x-auto pb-3"
          aria-label={t`Shortlist board`}
        >
          {[...new Set(rows.map(recordedStage))].map((stage) => {
            const members = rows
              .map((row, index) => ({ row, index }))
              .filter(({ row }) => recordedStage(row) === stage);
            return (
              <section
                key={stage}
                aria-label={stage}
                className="w-64 shrink-0 space-y-2 rounded-lg bg-muted/50 p-2"
              >
                <h3 className="flex items-center justify-between px-1 py-2 text-sm font-medium">
                  {statusText(stage)}
                  <span className="tabular-nums text-muted-foreground">{members.length}</span>
                </h3>
                {members.map(({ row, index }) => (
                  <article key={row.key} className="space-y-3 rounded-lg border bg-card p-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <PersonAvatar
                        name={row.name ?? t`Unnamed candidate`}
                        src={profiles[index]!.assets.photo}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">{nameButton(row, index)}</div>
                    </div>
                    <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                      {[row.title, profiles[index]!.company].filter(Boolean).join(" · ")}
                    </p>
                    {renderActions ? (
                      <div className="flex flex-wrap gap-2">{renderActions(row, index)}</div>
                    ) : null}
                  </article>
                ))}
              </section>
            );
          })}
        </section>
      ) : view === "table" ? (
        <CandidateWindow
          key="table"
          mode="table"
          tableClassName="w-full min-w-[1280px] table-fixed border-collapse text-left text-sm"
          itemKeys={itemKeys}
          offsets={offsets}
          label={t`Candidate table`}
          header={
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                {selection ? (
                  <th scope="col" className="w-10 px-3 py-2">
                    <Checkbox
                      aria-label={t`Select all on this page`}
                      checked={rows.every((row) => selection.keys.has(row.key))}
                      indeterminate={
                        !rows.every((row) => selection.keys.has(row.key)) &&
                        rows.some((row) => selection.keys.has(row.key))
                      }
                      onCheckedChange={(checked) =>
                        selection.set(checked ? new Set(rows.map((row) => row.key)) : new Set())
                      }
                    />
                  </th>
                ) : null}
                <th scope="col" className="w-56 px-3 py-2 font-medium">
                  <Trans>Name</Trans>
                </th>
                <th scope="col" className="w-[18%] px-3 py-2 font-medium">
                  <Trans>Current role</Trans>
                </th>
                <th scope="col" className="w-[15%] px-3 py-2 font-medium">
                  <Trans>Company</Trans>
                </th>
                {showEducation ? (
                  <th scope="col" className="w-48 px-3 py-2 font-medium">
                    <Trans>Education</Trans>
                  </th>
                ) : null}
                {!hiddenColumns.has("location") ? (
                  <th scope="col" className="w-[11%] px-3 py-2 font-medium">
                    <Trans>Location</Trans>
                  </th>
                ) : null}
                <th scope="col" className="w-[10%] px-3 py-2 font-medium">
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className="w-28 px-3 py-2 font-medium">
                  <Trans>Outreach</Trans>
                </th>
                <th scope="col" className="w-28 px-3 py-2 font-medium">
                  <Trans>Owner</Trans>
                </th>
                <th scope="col" className="w-28 px-3 py-2 font-medium">
                  <Trans>Date added</Trans>
                </th>
                {showFit ? (
                  <th scope="col" className="w-[13%] px-3 py-2 font-medium">
                    <Trans>Fit</Trans>
                  </th>
                ) : null}
                {renderActions ? (
                  <th scope="col" className="w-56 px-3 py-2 font-medium">
                    <Trans>Actions</Trans>
                  </th>
                ) : null}
              </tr>
            </thead>
          }
          renderRow={(index) => {
            const row = rows[index]!;
            const profile = profiles[index]!;
            const name = row.name ?? t`Unnamed candidate`;
            return (
              <tr
                key={row.key}
                data-selected={selectedKey === row.key || undefined}
                className="border-t border-border align-middle hover:bg-muted/40 data-selected:bg-muted"
              >
                {selection ? (
                  <td className="px-3 py-2">
                    <Checkbox
                      aria-label={t`Select ${name}`}
                      checked={selection.keys.has(row.key)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selection.keys);
                        if (checked) next.add(row.key);
                        else next.delete(row.key);
                        selection.set(next);
                      }}
                    />
                  </td>
                ) : null}
                <th scope="row" className="px-3 py-2 font-normal">
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonAvatar name={name} src={profile.assets.photo} size="sm" />
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {nameButton(row, index)}
                      {sourceLink(profile, name)}
                    </div>
                  </div>
                </th>
                <td className="truncate px-3 py-2" title={row.title ?? undefined}>
                  {row.title ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <Company profile={profile} title={null} companyOnly />
                </td>
                {showEducation ? (
                  <td className="px-3 py-2">
                    <Education profile={profile} compact />
                  </td>
                ) : null}
                {!hiddenColumns.has("location") ? (
                  <td
                    className="truncate px-3 py-2 text-xs text-muted-foreground"
                    title={row.location ?? undefined}
                  >
                    {row.location ?? "—"}
                  </td>
                ) : null}
                <td className="px-3 py-2">
                  <Status row={row} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {row.crm?.outreachStatus ? (
                    <Badge variant="outline">{statusText(row.crm.outreachStatus)}</Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="truncate px-3 py-2 text-xs" title={ownerName}>
                  {ownerName ?? "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs">
                  {row.autumn?.firstDiscoveredAt
                    ? new Date(row.autumn.firstDiscoveredAt).toLocaleDateString()
                    : "—"}
                </td>
                {showFit ? (
                  <td className="px-3 py-2">
                    <Fit ranking={profile.ranking} sections={profile.sections} compact />
                  </td>
                ) : null}
                {renderActions ? (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {renderActions(row, index)}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          }}
        />
      ) : (
        <CandidateWindow
          key="cards"
          mode="cards"
          itemKeys={itemKeys}
          offsets={offsets}
          label={t`Candidate cards`}
          renderRow={(index) => {
            const row = rows[index]!;
            const profile = profiles[index]!;
            const name = row.name ?? t`Unnamed candidate`;
            return (
              <li
                key={row.key}
                data-selected={selectedKey === row.key || undefined}
                className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 data-selected:ring-2 data-selected:ring-ring"
              >
                <div className="flex items-start gap-4">
                  <div className="relative mb-1 shrink-0">
                    <PersonAvatar name={name} src={profile.assets.photo} />
                    {profile.company ? (
                      <span className="absolute -right-1 -bottom-1 rounded-md border-2 border-card [&>span]:size-6 [&>span]:text-[9px]">
                        <CompanyLogo
                          name={profile.company}
                          src={organizationLogo(profile.company, profile.assets.company)}
                          host={profile.companyHost}
                        />
                      </span>
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    {nameButton(row, index)}
                    <p className="line-clamp-2 break-words text-xs">{row.title ?? "—"}</p>
                    {profile.company ? (
                      <p className="text-xs text-muted-foreground">
                        <OrganizationName
                          name={profile.company}
                          href={organizationLogo(profile.company, profile.assets.companyLink)}
                        />
                      </p>
                    ) : null}
                    {sourceLink(profile, name)}
                  </div>
                </div>
                {row.location ? (
                  <p className="mt-4 flex items-start gap-2 break-words text-xs text-muted-foreground">
                    <MapPin size={13} className="shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">{row.location}</span>
                  </p>
                ) : null}
                {profile.school ? (
                  <div className="mt-4">
                    <Education profile={profile} />
                  </div>
                ) : null}
                {showFit ? (
                  <div className="mt-4 flex-1 border-t border-border pt-3">
                    <Fit ranking={profile.ranking} sections={profile.sections} />
                  </div>
                ) : null}
                <div className="mt-3">
                  <Status row={row} />
                </div>
                {renderActions ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {renderActions(row, index)}
                  </div>
                ) : null}
              </li>
            );
          }}
        />
      )}
    </div>
  );
}
