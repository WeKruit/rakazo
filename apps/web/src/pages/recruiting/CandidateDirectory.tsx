import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button } from "@rakazo/ui-web";
import { ExternalLink, LayoutGrid, MapPin, Table2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { PersonAvatar } from "./DetailPanel";
import { CompanyLogo } from "./ProfileTimeline";
import { candidateSections } from "./profile";
import {
  organizationLogo,
  profileAssets,
  profileContentFields,
  profileImageUrl,
} from "./profileAssets";
import { parseTimeline } from "./profileTimeline";
import { statusText } from "./shared";
import type { RoleCandidate } from "./useRoleCandidates";

export type CandidateDirectoryProps = {
  rows: readonly RoleCandidate[];
  selectedKey?: string;
  onOpen: (row: RoleCandidate, index: number, trigger: HTMLElement) => void;
  renderActions?: (row: RoleCandidate, index: number) => ReactNode;
};

function directoryProfile(row: RoleCandidate) {
  const fields = row.autumn?.latestSource?.report?.fields ?? [];
  const company = row.crm?.company ?? row.autumn?.company ?? null;
  const assets = profileAssets(fields, company);
  const sections = candidateSections(profileContentFields(fields));
  const school = parseTimeline(sections.education[0]?.value, "education", new Date())[0];
  return { company, assets, sections, school, profileUrl: profileImageUrl(row.linkedinUrl) };
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
    <div className="flex min-w-0 items-center gap-2.5">
      {company ? (
        <CompanyLogo name={company} src={organizationLogo(company, assets.company)} />
      ) : null}
      <div className="min-w-0">
        <p className="line-clamp-2 break-words font-medium" title={title ?? undefined}>
          {title ?? "—"}
        </p>
        {company ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            <OrganizationName name={company} href={organizationLogo(company, assets.companyLink)} />
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Education({ profile }: { profile: DirectoryProfile }) {
  const { school, assets } = profile;
  if (!school) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <CompanyLogo name={school.primary} src={organizationLogo(school.primary, assets.school)} />
      <div className="min-w-0">
        <p className="line-clamp-2 break-words text-xs font-medium" title={school.text}>
          <OrganizationName
            name={school.primary}
            href={organizationLogo(school.primary, assets.schoolLink)}
          />
        </p>
        {school.secondary ? (
          <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
            {school.secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Fit({ sections }: { sections: DirectoryProfile["sections"] }) {
  const { t } = useLingui();
  const score = sections.fit?.score;
  const tier = sections.fit?.tier;
  const criteria = sections.requirements.slice(0, 2);
  if (!score && !tier && !criteria.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-1.5">
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
            <span className="min-w-0 break-words">
              {criterion.label ? <span className="font-medium">{criterion.label} · </span> : null}
              <span className="text-muted-foreground">{status}</span>
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
  selectedKey,
  onOpen,
  renderActions,
}: CandidateDirectoryProps) {
  const { t } = useLingui();
  const [view, setView] = useState<"table" | "cards">("table");
  const profiles = rows.map(directoryProfile);
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
      aria-haspopup="dialog"
      aria-current={selectedKey === row.key ? "true" : undefined}
      className="line-clamp-2 w-full break-words text-left font-semibold hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      onClick={(event) => onOpen(row, index, event.currentTarget)}
    >
      {row.name ?? t`Unnamed candidate`}
    </button>
  );
  if (!rows.length) return null;
  return (
    <div className="min-w-0 space-y-3">
      <fieldset className="flex min-w-0 justify-end" aria-label={t`Contact layout`}>
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
      {view === "table" ? (
        <section
          aria-label={t`Candidate table`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus and scroll the overflowing table.
          tabIndex={0}
          className="max-h-[70vh] max-w-full overflow-auto rounded-xl border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full min-w-[960px] table-fixed border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-52 px-4 py-3 font-medium">
                  <Trans>Name</Trans>
                </th>
                <th scope="col" className="w-52 px-4 py-3 font-medium">
                  <Trans>Current role</Trans>
                </th>
                {showEducation ? (
                  <th scope="col" className="w-48 px-4 py-3 font-medium">
                    <Trans>Education</Trans>
                  </th>
                ) : null}
                <th scope="col" className="w-36 px-4 py-3 font-medium">
                  <Trans>Location</Trans>
                </th>
                <th scope="col" className="w-32 px-4 py-3 font-medium">
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className="w-40 px-4 py-3 font-medium">
                  <Trans>Fit</Trans>
                </th>
                {renderActions ? (
                  <th scope="col" className="w-60 px-4 py-3 font-medium">
                    <Trans>Actions</Trans>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const profile = profiles[index]!;
                const name = row.name ?? t`Unnamed candidate`;
                return (
                  <tr
                    key={row.key}
                    data-selected={selectedKey === row.key || undefined}
                    className="border-t border-border align-middle hover:bg-muted/40 data-selected:bg-muted"
                  >
                    <th scope="row" className="px-4 py-3 font-normal">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PersonAvatar name={name} src={profile.assets.photo} size="sm" />
                        <div className="min-w-0 space-y-1">
                          {nameButton(row, index)}
                          {sourceLink(profile, name)}
                        </div>
                      </div>
                    </th>
                    <td className="px-4 py-3">
                      <Company profile={profile} title={row.title} />
                    </td>
                    {showEducation ? (
                      <td className="px-4 py-3">
                        <Education profile={profile} />
                      </td>
                    ) : null}
                    <td className="break-words px-4 py-3 text-xs text-muted-foreground">
                      {row.location ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Status row={row} />
                    </td>
                    <td className="px-4 py-3">
                      <Fit sections={profile.sections} />
                    </td>
                    {renderActions ? (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {renderActions(row, index)}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <ul
          aria-label={t`Candidate cards`}
          className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {rows.map((row, index) => {
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
          })}
        </ul>
      )}
    </div>
  );
}
