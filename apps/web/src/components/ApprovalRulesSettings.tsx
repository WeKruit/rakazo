import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule, ActionAutoReviewSettings } from "@rakazo/contracts";
import { Button, Input, Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

function describeRule(rule: ActionApprovalRule): string {
  if (rule.matchKind === "egress") {
    if (rule.matchValue === "*") return t`Computer reaches only allowed sites`;
    return rule.effect === "block"
      ? t`Computer never reaches ${rule.matchValue}`
      : t`Computer may reach ${rule.matchValue}`;
  }
  if (rule.effect === "block") return t`Block ${rule.matchValue}`;
  if (rule.effect === "hide") return t`Hide ${rule.matchValue}`;
  if (rule.effect === "require_approval") {
    if (rule.matchKind === "category") {
      if (rule.matchValue === "email") return t`Ask before email actions`;
      if (rule.matchValue === "purchase") return t`Ask before purchase actions`;
      return t`Ask before ${rule.matchValue} actions`;
    }
    if (rule.matchKind === "connector") return t`Ask before ${rule.matchValue} connector`;
    return t`Ask before ${rule.matchValue}`;
  }
  if (rule.matchKind === "category") {
    if (rule.matchValue === "email") return t`Allow email actions without asking`;
    if (rule.matchValue === "purchase") return t`Allow purchase actions without asking`;
    return t`Allow ${rule.matchValue} actions without asking`;
  }
  if (rule.matchKind === "connector") return t`Allow ${rule.matchValue} connector without asking`;
  return t`Allow ${rule.matchValue} without asking`;
}

export function ApprovalRulesSettings() {
  const { t } = useLingui();
  const autoReviewId = useId();
  const toolNameId = useId();
  const [rules, setRules] = useState<ActionApprovalRule[]>([]);
  const [autoReview, setAutoReview] = useState<ActionAutoReviewSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [toolName, setToolName] = useState("");
  const sitesLimitId = useId();
  const siteId = useId();
  const [site, setSite] = useState("");
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextAutoReview] = await Promise.all([
        rpc.approvalRules.list(),
        rpc.autoReview.get(),
      ]);
      setRules(nextRules);
      setAutoReview(nextAutoReview);
    } catch (err) {
      setError(errorText(err, t`Could not load approval rules`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addRule(
    effect: ActionApprovalRule["effect"],
    matchKind: "category" | "tool" | "egress",
    value: string,
  ) {
    const matchValue = value.trim();
    if (loading || savingRule || !matchValue) return;
    if (
      rules.some(
        (rule) =>
          rule.effect === effect &&
          rule.matchKind === matchKind &&
          rule.matchValue.toLowerCase() === matchValue.toLowerCase(),
      )
    ) {
      return;
    }
    setSavingRule(matchValue);
    setError(null);
    try {
      const saved = await rpc.approvalRules.set({
        effect,
        matchKind,
        matchValue,
      });
      setRules((current) => [...current, saved]);
      if (matchKind === "tool") setToolName("");
      if (matchKind === "egress") setSite("");
    } catch (err) {
      setError(errorText(err, t`Could not save rule`));
    } finally {
      setSavingRule(null);
    }
  }

  const sitesLimit = rules.find(
    (rule) => rule.matchKind === "egress" && rule.effect === "block" && rule.matchValue === "*",
  );

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ id });
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err) {
      setError(errorText(err, t`Could not remove rule`));
    }
  }

  async function toggleAutoReview(enabled: boolean) {
    if (loading || savingAutoReview) return;
    setSavingAutoReview(true);
    setError(null);
    try {
      setAutoReview(await rpc.autoReview.set({ enabled }));
    } catch (err) {
      setError(errorText(err, t`Could not save Auto Review`));
    } finally {
      setSavingAutoReview(false);
    }
  }

  return (
    <div data-testid="action-confirmation-settings" className="pt-5">
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Action confirmations</Trans>
      </h3>
      <div className="mt-4 flex flex-col items-start gap-2">
        <Button
          variant="outline"
          disabled={loading || savingRule !== null}
          onClick={() => void addRule("require_approval", "category", "email")}
        >
          <Trans>Ask before sending external email</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={loading || savingRule !== null}
          onClick={() => void addRule("require_approval", "category", "purchase")}
        >
          <Trans>Ask before purchases</Trans>
        </Button>
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-foreground/75">
          <Trans>Rules for a specific tool</Trans>
        </summary>
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addRule("require_approval", "tool", toolName);
          }}
        >
          <Label htmlFor={toolNameId}>
            <Trans>Tool name</Trans>
          </Label>
          <div className="flex gap-2">
            <Input
              id={toolNameId}
              aria-label={t`Tool name`}
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              placeholder="mcp__service__tool"
              maxLength={200}
              disabled={loading || savingRule !== null}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={loading || savingRule !== null || !toolName.trim()}
            >
              <Trans>Ask first</Trans>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={loading || savingRule !== null || !toolName.trim()}
              onClick={() => void addRule("block", "tool", toolName)}
            >
              <Trans>Block</Trans>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={loading || savingRule !== null || !toolName.trim()}
              onClick={() => void addRule("hide", "tool", toolName)}
            >
              <Trans>Hide</Trans>
            </Button>
          </div>
        </form>
      </details>
      <div className="mt-5 flex items-start gap-3">
        <Switch
          id={autoReviewId}
          data-testid="auto-review-toggle"
          className="mt-0.5"
          checked={autoReview?.enabled ?? false}
          disabled={loading || savingAutoReview || !autoReview}
          onCheckedChange={(checked) => void toggleAutoReview(checked)}
        />
        <div>
          <Label htmlFor={autoReviewId} className="text-[14px] font-normal text-foreground/75">
            <Trans>Flag unexpected actions</Trans>
          </Label>
          {autoReview?.enabled && !autoReview.checkerAvailable ? (
            <p className="mt-1 text-[13px] text-muted-foreground">
              <Trans>Add a model in Settings to use this.</Trans>
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-5 flex items-start gap-3">
        <Switch
          id={sitesLimitId}
          className="mt-0.5"
          checked={Boolean(sitesLimit)}
          disabled={loading || savingRule !== null}
          onCheckedChange={(checked) =>
            void (checked
              ? addRule("block", "egress", "*")
              : sitesLimit && removeRule(sitesLimit.id))
          }
        />
        <div className="flex-1">
          <Label htmlFor={sitesLimitId} className="text-[14px] font-normal text-foreground/75">
            <Trans>Computer reaches only allowed sites</Trans>
          </Label>
          {sitesLimit ? (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addRule("always_allow", "egress", site);
              }}
            >
              <Input
                id={siteId}
                aria-label={t`Allowed site`}
                value={site}
                onChange={(event) => setSite(event.target.value)}
                placeholder="example.com"
                maxLength={253}
                disabled={loading || savingRule !== null}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={loading || savingRule !== null || !site.trim()}
              >
                <Trans>Allow</Trans>
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      {loading ? (
        <p className="mt-4 text-[13px] text-muted-foreground">
          <Trans>Loading rules…</Trans>
        </p>
      ) : rules.some((rule) => rule !== sitesLimit) ? (
        <ul className="mt-4 space-y-2">
          {rules
            .filter((rule) => rule !== sitesLimit)
            .map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2"
              >
                <span className="text-[13.5px] text-foreground/75">{describeRule(rule)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => void removeRule(rule.id)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
