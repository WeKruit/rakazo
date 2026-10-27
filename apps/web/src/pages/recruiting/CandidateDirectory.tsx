import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button } from "@rakazo/ui-web";
import type { VirtualItem } from "@tanstack/react-virtual";
import { ExternalLink, LayoutGrid, MapPin, Table2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { CandidateWindow } from "./CandidateWindow";
import { CompanyLogo } from "./OrgBadge";
import { PersonAvatar } from "./ProfileImage";
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

function Company({ profile, title }: { profile: DirectoryProfile; title: string | null }) {
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
          {title ?? "—"}
        </p>
        {company ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={company}>
            <OrganizationName name={company} href={organizationLogo(company, assets.companyLink)} />
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Education({ profile, compact = false }: { profile: DirectoryProfile; compact?: boolean }) {
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
}

function Fit({
  sections,
  compact = false,
}: {
  sections: DirectoryProfile["sections"];
  compact?: boolean;
}) {
  const { t } = useLingui();
  const score = sections.fit?.score;
  const tier = sections.fit?.tier;
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
              className={compact ? "flex min-w-0 flex-1 items-center gap-1" : "min-w-0 break-words"}
              title={
                compact
                  ? [name, criterion.criterionId, status].filter(Boolean).join(" · ")
                  : undefined
              }
            >
              {name ? (
                <span className={compact ? "truncate font-medium" : "font-medium"}>{name} · </span>
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
    </div>
  );
}

function Status({ row }: { row: RoleCandidate }) {
  const activity = row.crm?.stage || row.crm?.outreachStatus;
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
}

/** Source-only contact presentation. Loading, permissions, writes and profile navigation stay with the caller. */
export function CandidateDirectory({
  rows,
  criterionRevision,
  selectedKey,
  toolbar,
  onOpen,
  renderActions,
}: CandidateDirectoryProps) {
  const { t } = useLingui();
  const [view, setView] = useState<"table" | "cards">("table");
  const profiles = useMemo(
    () => rows.map((row) => directoryProfile(row, criterionRevision)),
    [rows, criterionRevision],
  );
  const itemKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const offsets = useRef({
    table: { offset: 0, measurements: [] as VirtualItem[] },
    cards: { offset: 0, measurements: [] as VirtualItem[] },
  });
  const showEducation = profiles.some((profile) => profile.school);
  const sourceLink = (profile: DirectoryProfile, name: string) =>
    profile.profileUrl ? (
      <a
        href={profile.profileUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={t`Open ${name}'s source profile`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <Trans>Profile</Trans>
        <ExternalLink size={11} aria-hidden />
      </a>
    ) : null;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        {toolbar}
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
          </div>
        </fieldset>
      </div>
      {view === "table" ? (
        <CandidateWindow
          key="table"
          mode="table"
          itemKeys={itemKeys}
          offsets={offsets}
          label={t`Candidate table`}
          header={
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-[16%] px-3 py-2 font-medium">
                  <Trans>Name</Trans>
                </th>
                <th scope="col" className="w-[18%] px-3 py-2 font-medium">
                  <Trans>Current role</Trans>
                </th>
                {showEducation ? (
                  <th scope="col" className="w-[16%] px-3 py-2 font-medium">
                    <Trans>Education</Trans>
                  </th>
                ) : null}
                <th scope="col" className="w-[11%] px-3 py-2 font-medium">
                  <Trans>Location</Trans>
                </th>
                <th scope="col" className="w-[10%] px-3 py-2 font-medium">
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className="w-[13%] px-3 py-2 font-medium">
                  <Trans>Fit</Trans>
                </th>
                {renderActions ? (
                  <th scope="col" className="w-[16%] px-3 py-2 font-medium">
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
                <th scope="row" className="px-3 py-2 font-normal">
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonAvatar name={name} src={profile.assets.photo} size="sm" />
                    <div className="min-w-0 space-y-0.5">
                      {nameButton(row, index)}
                      {sourceLink(profile, name)}
                    </div>
                  </div>
                </th>
                <td className="px-3 py-2">
                  <Company profile={profile} title={row.title} />
                </td>
                {showEducation ? (
                  <td className="px-3 py-2">
                    <Education profile={profile} compact />
                  </td>
                ) : null}
                <td className="break-words px-3 py-2 text-xs text-muted-foreground">
                  {row.location ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <Status row={row} />
                </td>
                <td className="px-3 py-2">
                  <Fit sections={profile.sections} compact />
                </td>
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
                <div className="mt-4 flex-1 border-t border-border pt-3">
                  <Fit sections={profile.sections} />
                </div>
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
