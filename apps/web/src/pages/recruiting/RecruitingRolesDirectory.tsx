import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { ArrowUpRight, PanelLeftOpen, Search } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { RetryNotice } from "./RetryNotice";
import { TabLoading, useKeyedRead } from "./shared";

const PAGE_SIZE = 50;
type Role = RecruitingAccountViewOutput["roles"][number];

export function recruitingRoleHref(role: Role) {
  if (role.groupId) return `/app/g/${encodeURIComponent(role.groupId)}?view=conversation`;
  if (role.botId) return `/app/${encodeURIComponent(role.botId)}?view=conversation`;
  return null;
}

/** The existing account catalog is complete metadata; its per-role data stays capped at one. */
export function RecruitingRolesDirectory({
  spaceId,
  onNavigate,
  onOpenNavigation,
  refreshSignal = 0,
}: {
  spaceId?: string;
  onNavigate: (href: string) => void;
  onOpenNavigation?: () => void;
  refreshSignal?: number;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [pagination, setPagination] = useState({ query: "", page: 0 });
  const read = useKeyedRead(
    spaceId ? JSON.stringify(["roles-directory", spaceId, refreshSignal, reload]) : null,
    () => rpc.recruiting.accountView({ view: "roles", limit: 1 }),
  );
  const needle = query.trim().toLocaleLowerCase();
  const roles = (read.data?.roles ?? []).filter((role) =>
    role.title.toLocaleLowerCase().includes(needle),
  );
  const pages = Math.max(1, Math.ceil(roles.length / PAGE_SIZE));
  const page = pagination.query === needle ? Math.min(pagination.page, pages - 1) : 0;
  const offset = page * PAGE_SIZE;
  const visible = roles.slice(offset, offset + PAGE_SIZE);
  return (
    <section
      aria-label={t`All roles`}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6"
    >
      <header className="flex items-center gap-3">
        {onOpenNavigation ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={t`Open navigation`}
            onClick={onOpenNavigation}
          >
            <PanelLeftOpen size={18} aria-hidden />
          </Button>
        ) : null}
        <h1 className="text-xl font-semibold">
          <Trans>All roles</Trans>
        </h1>
      </header>
      <div className="relative w-full sm:max-w-sm">
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={t`Search roles`}
          placeholder={t`Search roles`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPagination({ query: event.target.value.trim().toLocaleLowerCase(), page: 0 });
          }}
          className="ps-9"
        />
      </div>
      {!spaceId || read.loading ? (
        <TabLoading />
      ) : read.failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load roles.</Trans>
        </RetryNotice>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {roles.length ? (
              <Trans>
                {offset + 1}–{offset + visible.length} of {roles.length}
              </Trans>
            ) : needle ? (
              <Trans>No roles match your search.</Trans>
            ) : (
              <Trans>No roles yet.</Trans>
            )}
          </p>
          {visible.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {visible.map((role) => {
                const href = recruitingRoleHref(role);
                return (
                  <li key={role.id}>
                    {href ? (
                      <a
                        href={href}
                        onClick={(event) => {
                          if (
                            event.button === 0 &&
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey
                          ) {
                            event.preventDefault();
                            onNavigate(href);
                          }
                        }}
                        className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <span className="min-w-0 break-words" dir="auto">
                          {role.title}
                        </span>
                        <ArrowUpRight
                          size={16}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      </a>
                    ) : (
                      <span className="block px-4 py-3 text-sm text-muted-foreground" dir="auto">
                        {role.title}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {pages > 1 ? (
            <nav aria-label={t`Role pages`} className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPagination({ query: needle, page: page - 1 })}
              >
                <Trans>Previous</Trans>
              </Button>
              <span className="text-sm text-muted-foreground">
                <Trans>
                  Page {page + 1} of {pages}
                </Trans>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 === pages}
                onClick={() => setPagination({ query: needle, page: page + 1 })}
              >
                <Trans>Next</Trans>
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
