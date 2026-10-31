import { Trans, useLingui } from "@lingui/react/macro";
import type { InternalUsageAmounts, InternalUsageCosts, UsageVendor } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const number = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
const usd = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value);

function CostAmount({ value }: { value: InternalUsageAmounts }) {
  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums">
      {!value.priced ? (
        <span className="text-xs text-muted-foreground">
          <Trans>Unpriced usage</Trans>
        </span>
      ) : null}
      <span>{usd(value.costUsd)}</span>
    </span>
  );
}

function VendorCosts({ vendors }: { vendors: UsageVendor[] }) {
  const { t } = useLingui();
  return vendors.map((vendor) => (
    <details
      key={vendor.vendor}
      data-testid="cost-vendor"
      className="group/vendor border-t border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm outline-offset-4 hover:text-foreground">
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/vendor:rotate-180"
        />
        <span className="min-w-0 flex-1 break-words font-medium">{vendor.vendor}</span>
        <CostAmount value={vendor} />
      </summary>
      <div className="pb-3 ps-5">
        {vendor.models.map((model) => (
          <details
            key={`${model.unit}:${model.model}`}
            data-testid="cost-model"
            className="group/model border-t border-border"
          >
            <summary className="flex cursor-pointer list-none items-start gap-2 py-3 text-[13px] outline-offset-4">
              <ChevronDown
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/model:rotate-180"
              />
              <span className="min-w-0 flex-1 break-words">
                <span className="font-medium">{model.model}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {number(model.unit === "tokens" ? model.tokens : model.quantity)} {model.unit}
                </span>
              </span>
              <CostAmount value={model} />
            </summary>
            <div className="pb-4 ps-5">
              <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                {(model.unit === "tokens"
                  ? ([
                      [t`Input`, model.inputTokens],
                      [t`Output`, model.outputTokens],
                      [t`Cache read`, model.cacheReadTokens],
                      [t`Cache write`, model.cacheWriteTokens],
                      [t`Cache write (1h)`, model.cacheWrite1hTokens],
                      [t`Reasoning`, model.reasoningTokens],
                      [t`Total tokens`, model.tokens],
                    ] as const)
                  : ([[t`Usage`, model.quantity]] as const)
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1 tabular-nums text-foreground">{number(value)}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted-foreground">
                    <Trans>Credits</Trans>
                  </dt>
                  <dd className="mt-1 tabular-nums">{number(model.credits)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                {model.unit === "tokens" ? (
                  <Trans>Average / 1M tokens</Trans>
                ) : (
                  <Trans>Average / {model.unit}</Trans>
                )}
                <span className="ms-2 tabular-nums text-foreground">
                  {usd(model.averageUnitCostUsd)}
                </span>
              </p>
              {model.costSources.length ? (
                <p className="mt-3 break-words text-xs text-muted-foreground">
                  {model.costSources.join(" · ")}
                </p>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </details>
  ));
}

export function InternalCostsSettingsPanel() {
  const { t } = useLingui();
  const [data, setData] = useState<InternalUsageCosts | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    setError(false);
    rpc.usage.internalCosts().then(
      (value) => {
        if (active) setData(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  if (error)
    return (
      <div className="flex items-center justify-between gap-4" role="alert">
        <p className="text-sm text-destructive">
          <Trans>Could not load internal costs</Trans>
        </p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading costs…</Trans>
      </p>
    );

  const query = search.trim().toLocaleLowerCase();
  const accounts = data.accounts.filter((account) =>
    `${account.email ?? ""} ${account.name ?? ""} ${account.userId}`
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <div data-testid="internal-costs-settings" className="space-y-7">
      <div className="overflow-x-auto">
        <table aria-label={t`All account totals`} className="w-full text-[13px]">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 text-start font-normal">
                <Trans>All accounts</Trans>
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                <Trans>Tokens</Trans>
              </th>
              <th scope="col" className="py-2 ps-4 text-end font-normal">
                <Trans>Credits</Trans>
              </th>
              <th scope="col" className="py-2 ps-4 text-end font-normal">
                <Trans>Cost</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                [t`This month`, data.month],
                [t`All time`, data.total],
              ] as const
            ).map(([label, value]) => (
              <tr key={label} className="border-t border-border tabular-nums">
                <th scope="row" className="py-3 text-start font-normal">
                  {label}
                </th>
                <td className="py-3 text-end">{number(value.tokens)}</td>
                <td className="py-3 ps-4 text-end">{number(value.credits)}</td>
                <td className="py-3 ps-4 text-end">
                  <span className="inline-flex">
                    <CostAmount value={value} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <ChevronDown
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180"
          />
          <Trans>By vendor</Trans>
        </summary>
        <div className="mt-3">
          <VendorCosts vendors={data.vendors} />
        </div>
      </details>
      <section className="space-y-3" aria-label={t`Accounts`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">
            <Trans>Accounts</Trans>{" "}
            <span className="ms-1 text-muted-foreground">{data.accounts.length}</span>
          </h3>
          <Input
            aria-label={t`Search accounts`}
            placeholder={t`Search accounts`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 w-full sm:w-56"
          />
        </div>
        <div>
          {accounts.map((account) => (
            <details
              key={account.userId}
              data-testid="cost-account"
              className="group/account border-t border-border"
            >
              <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-sm outline-offset-4">
                <ChevronDown
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open/account:rotate-180"
                />
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-medium">
                    {account.email ?? account.name ?? account.userId}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {number(account.credits)} <Trans>credits</Trans>
                  </span>
                </span>
                <CostAmount value={account} />
              </summary>
              <div className="pb-3 ps-2 sm:ps-7">
                {account.vendors.length ? (
                  <VendorCosts vendors={account.vendors} />
                ) : (
                  <p className="pb-2 text-xs text-muted-foreground">
                    <Trans>No usage yet</Trans>
                  </p>
                )}
              </div>
            </details>
          ))}
          {!accounts.length ? (
            <p className="py-4 text-sm text-muted-foreground">
              {query ? <Trans>No matching accounts</Trans> : <Trans>No accounts</Trans>}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
