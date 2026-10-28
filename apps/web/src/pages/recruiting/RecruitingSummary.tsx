import { lazyPanel } from "../../components/ErrorBoundary";
import { withFeatureMessages } from "../../lib/i18n";

import { CriteriaExpression } from "./CriteriaEditor";

const Sources = lazyPanel(() =>
  withFeatureMessages(() => import("./SourceDocuments")).then((m) => m.Sources),
);

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { BriefcaseBusiness, Building2, Check, RefreshCw } from "lucide-react";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";

const FeedbackHistory = lazyPanel(() =>
  withFeatureMessages(() => import("./CandidateFeedback")).then((m) => m.FeedbackHistory),
);

/** A brief field key written as a label (「工作年限」, "Years of experience"), not an id or a question. */
function isBriefLabel(key: string) {
  return key.length <= 24 && !/[_?？:：]/.test(key);
}

export function RecruitingSummary({ model }: { model: ReturnType<typeof useRecruitingWorkspace> }) {
  const { t } = useLingui();
  const {
    threadId,
    readCache,
    readCacheScope,
    refreshSignal,
    summary,
    workspaceSnapshot,
    refresh,
    setRefresh,
    loading,
    failed,
    denyAccess,
    workspace,
    criteria,
    brief,
    briefFieldLabels,
    roleSources,
  } = model;
  if (summary) {
    const CriteriaBody = summary === "feedback" ? "details" : "div";
    return (
      <section
        className="hire-live-criteria"
        data-summary={summary}
        aria-label={summary === "brief" ? t`Search Criteria` : t`Client feedback`}
      >
        <div className="hire-panel-heading">
          {summary === "brief" ? (
            <BriefcaseBusiness size={18} aria-hidden />
          ) : (
            <Building2 size={18} aria-hidden />
          )}
          <div>
            <strong>
              {summary === "brief" ? (
                <Trans>Search Criteria</Trans>
              ) : (
                <Trans>Saved role summary</Trans>
              )}
            </strong>
            <span>
              {summary === "brief" ? (
                <Trans>From this role’s saved requirements</Trans>
              ) : (
                <Trans>Saved feedback for this role</Trans>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={summary === "brief" ? t`Refresh criteria` : t`Refresh`}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} aria-hidden />
          </Button>
        </div>
        {failed ? (
          <p role="alert" className="hire-source-hint">
            <Trans>Could not load recruiting. Refresh to try again.</Trans>
          </p>
        ) : loading && !workspaceSnapshot ? (
          <p role="status" className="hire-source-hint">
            <Trans>Loading…</Trans>
          </p>
        ) : workspace ? (
          <>
            {summary === "brief" ? (
              <div className="hire-jd-summary">
                <strong>{workspace.role.title}</strong>
              </div>
            ) : null}
            {summary === "feedback" ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + refresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
                showEmpty
              />
            ) : null}
            <CriteriaBody className={summary === "feedback" ? "hire-criterion-row" : "contents"}>
              {summary === "feedback" ? (
                <>
                  <summary>
                    <Trans>Search Criteria</Trans>
                  </summary>
                  <div className="hire-criterion-row">
                    <strong>{workspace.role.title}</strong>
                  </div>
                </>
              ) : null}
              {brief?.fields
                .filter((field) => field.value !== null)
                .map((field) => (
                  <div className="hire-criterion-row" key={field.key}>
                    {Object.hasOwn(briefFieldLabels, field.key) ? (
                      <span>{briefFieldLabels[field.key]}</span>
                    ) : isBriefLabel(field.key) ? (
                      <span>{field.key}</span>
                    ) : null}
                    <strong className="whitespace-pre-wrap">{field.value}</strong>
                    {field.state === "conflict" ? (
                      <span>
                        <Trans>Conflicting information</Trans>
                      </span>
                    ) : field.state !== "known" ? (
                      <span>
                        <Trans>Unknown</Trans>
                      </span>
                    ) : null}
                    {field.origin === "inferred" ? (
                      <span>
                        <Trans>Assumption</Trans>
                      </span>
                    ) : null}
                  </div>
                ))}
              {brief?.searchFilters.map((filter) => (
                <div className="hire-criterion-row" key={filter.id}>
                  <span>
                    {filter.mode === "include" ? (
                      <Trans>Include</Trans>
                    ) : filter.mode === "exclude" ? (
                      <Trans>Exclude</Trans>
                    ) : (
                      <Trans>Prefer</Trans>
                    )}
                  </span>
                  <strong>{filter.statement}</strong>
                </div>
              ))}
              {criteria.map((criterion) => (
                <div className="hire-criterion-row" key={criterion.id}>
                  <span>
                    {criterion.priority === "hard" ? (
                      <Trans>Required</Trans>
                    ) : (
                      <Trans>Preferred</Trans>
                    )}
                  </span>
                  <CriteriaExpression expression={criterion.expression} />
                </div>
              ))}
              {workspace.revision.preferences.length ? (
                <div className="hire-criterion-row">
                  <span>
                    <Trans>Preferences</Trans>
                  </span>
                  <ul>
                    {workspace.revision.preferences.map((preference) => (
                      <li key={preference}>{preference}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!brief?.fields.some((field) => field.value !== null) &&
              !brief?.searchFilters.length &&
              !criteria.length &&
              !workspace.revision.preferences.length ? (
                <p className="hire-source-hint">
                  <Trans>
                    Share the role requirements in the conversation to build this brief.
                  </Trans>
                </p>
              ) : null}
              {roleSources.length ? (
                <details className="hire-criterion-row">
                  <summary>
                    <Trans>Role sources</Trans>
                  </summary>
                  <Sources
                    sourceTarget={{ kind: "role", threadId, roleRevisionId: workspace.revision.id }}
                    sources={roleSources}
                    showDiagnostics={false}
                  />
                </details>
              ) : null}
            </CriteriaBody>
            <p className="hire-source-hint">
              <Check size={15} aria-hidden />
              <Trans>Requirements and feedback stay with this role.</Trans>
            </p>
          </>
        ) : (
          <p className="hire-source-hint">
            <Trans>No role linked yet. Describe the role in this conversation.</Trans>
          </p>
        )}
      </section>
    );
  }
  return null;
}
