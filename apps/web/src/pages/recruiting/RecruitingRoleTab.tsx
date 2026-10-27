import { Trans } from "@lingui/react/macro";
import { Button, NativeSelect, NativeSelectOption, TabsContent, Textarea } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { CandidateCounts } from "../recruiting/CandidatePresentation";
import {
  CriteriaExpression,
  CriteriaExpressionFields,
  criteriaDraft,
  EmploymentRuleSummary,
  expressionAtoms,
  searchFilterDraft,
} from "../recruiting/CriteriaEditor";
import { Sources } from "../recruiting/SourceDocuments";
import type { useRecruitingWorkspace } from "../recruiting/useRecruitingWorkspace";
export function RecruitingRoleTab({ model }: { model: ReturnType<typeof useRecruitingWorkspace> }) {
  const {
    threadId,
    showDiagnostics,
    t,
    setRefresh,
    loading,
    failed,
    confirming,
    setConfirming,
    confirmationFailed,
    setConfirmationFailed,
    candidatePage,
    criteriaEdit,
    setCriteriaEdit,
    savingCriteria,
    criteriaFailed,
    setCriteriaFailed,
    workspace,
    criteria,
    briefClarifications,
    briefFieldLabels,
    roleQuestions,
    roleSources,
    criteriaChanges,
    searchFiltersChanged,
    invalidSearchFilters,
    invalidCriteria,
    saveCriteria,
  } = model;
  return (
    <TabsContent key={workspace?.role.id} value="role" className="space-y-5">
      {workspace ? (
        <>
          {candidatePage ? <CandidateCounts counts={candidatePage.counts} /> : null}
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-medium" dir="auto">
                {workspace.role.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                <Trans>Version {workspace.revision.revision}</Trans>
              </p>
            </div>
            {!criteriaEdit && criteria.length ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCriteriaFailed(false);
                  setCriteriaEdit({
                    roleId: workspace.role.id,
                    revision: workspace.revision,
                    criteria: criteriaDraft(workspace.revision),
                    searchFilters: searchFilterDraft(workspace.revision),
                  });
                }}
              >
                <Trans>Edit criteria</Trans>
              </Button>
            ) : null}
          </div>
          {workspace.revision.brief ? (
            <div className="space-y-2">
              <ul className="space-y-3 text-base leading-relaxed">
                {workspace.revision.brief.fields
                  .filter((field) => field.value !== null)
                  .map((field) => (
                    <li key={field.key} className="space-y-1">
                      {Object.hasOwn(briefFieldLabels, field.key) ? (
                        <p className="text-xs text-muted-foreground">
                          {briefFieldLabels[field.key]}
                        </p>
                      ) : null}
                      <p className="whitespace-pre-wrap">{field.value}</p>
                      {field.state !== "known" ? (
                        <p className="text-xs text-muted-foreground">
                          {field.state === "conflict" ? (
                            <Trans>Conflicting information</Trans>
                          ) : (
                            <Trans>Unknown</Trans>
                          )}
                        </p>
                      ) : null}
                      {field.origin === "inferred" ? (
                        <p className="text-xs text-muted-foreground">
                          <Trans>Assumption</Trans>
                        </p>
                      ) : null}
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          <Trans>Sources</Trans>
                        </summary>
                        <div className="mt-2 space-y-2 text-sm">
                          {showDiagnostics ? <p>{field.key}</p> : null}
                          <p>
                            {field.origin === "user_instruction" ? (
                              <Trans>User instruction</Trans>
                            ) : field.origin === "jd" ? (
                              <Trans>JD</Trans>
                            ) : field.origin === "hm" ? (
                              <Trans>Hiring manager</Trans>
                            ) : (
                              <Trans>Assumption</Trans>
                            )}
                          </p>
                          <Sources
                            sourceTarget={{
                              kind: "role",
                              threadId,
                              roleRevisionId: workspace.revision.id,
                            }}
                            showDiagnostics={showDiagnostics}
                            sources={roleSources.filter((source) =>
                              field.sourceRefIds.includes(source.id),
                            )}
                          />
                        </div>
                      </details>
                    </li>
                  ))}
              </ul>
              {showDiagnostics &&
              workspace.revision.brief.fields.some((field) => field.value === null) ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    <Trans>Details</Trans>
                  </summary>
                  <dl>
                    {workspace.revision.brief.fields
                      .filter((field) => field.value === null)
                      .map((field) => (
                        <div key={field.key}>
                          <dt>{field.key}</dt>
                          <dd>
                            {field.state} · {field.origin}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </details>
              ) : null}
              {workspace.revision.brief.confirmation?.revision !== workspace.revision.revision &&
                roleQuestions.map((question) => (
                  <p key={question} className="text-sm text-muted-foreground">
                    {question}
                  </p>
                ))}
              {workspace.revision.brief.confirmation?.revision === workspace.revision.revision ? (
                <p>
                  <Trans>Brief confirmed</Trans>
                </p>
              ) : (
                <Button
                  disabled={
                    loading ||
                    failed ||
                    confirming ||
                    briefClarifications.length > 0 ||
                    workspace.revision.criteria.some(
                      (criterion) =>
                        criterion.priority === "hard" && criterion.definitionQuestions.length > 0,
                    )
                  }
                  onClick={async () => {
                    setConfirming(true);
                    setConfirmationFailed(false);
                    try {
                      await rpc.recruiting.confirmBrief({
                        threadId,
                        roleId: workspace.role.id,
                        expectedRevision: workspace.revision.revision,
                      });
                      setRefresh((value) => value + 1);
                    } catch {
                      setConfirmationFailed(true);
                    } finally {
                      setConfirming(false);
                    }
                  }}
                >
                  <Trans>Confirm brief</Trans>
                </Button>
              )}
              {confirmationFailed ? (
                <p role="alert">
                  <Trans>Brief changed or could not be confirmed. Refresh and review it.</Trans>
                </p>
              ) : null}
            </div>
          ) : null}
          {workspace.revision.brief ? (
            <section aria-label={t`Search filters`} className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-medium">
                  <Trans>Search filters</Trans>
                </h4>
                {!criteriaEdit ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCriteriaFailed(false);
                      setCriteriaEdit({
                        roleId: workspace.role.id,
                        revision: workspace.revision,
                        criteria: criteriaDraft(workspace.revision),
                        searchFilters: searchFilterDraft(workspace.revision),
                      });
                    }}
                  >
                    <Trans>Edit search filters</Trans>
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                <Trans>Guide retrieval; qualification criteria stay unchanged.</Trans>
              </p>
              {criteriaEdit?.roleId === workspace.role.id ? (
                <>
                  {criteriaEdit.searchFilters.map((filter, index) => (
                    <fieldset key={filter.id} className="space-y-2">
                      <legend className="sr-only">
                        <Trans>Search filter {index + 1}</Trans>
                      </legend>
                      <div className="flex items-start gap-2">
                        <NativeSelect
                          aria-label={t`Search filter mode`}
                          size="sm"
                          value={filter.mode}
                          onChange={(event) => {
                            const mode = event.target.value as typeof filter.mode;
                            setCriteriaEdit((current) =>
                              current
                                ? {
                                    ...current,
                                    searchFilters: current.searchFilters.map((item) =>
                                      item.id === filter.id ? { ...item, mode } : item,
                                    ),
                                  }
                                : null,
                            );
                          }}
                        >
                          <NativeSelectOption value="include">
                            <Trans>Include</Trans>
                          </NativeSelectOption>
                          <NativeSelectOption value="exclude">
                            <Trans>Exclude</Trans>
                          </NativeSelectOption>
                          <NativeSelectOption value="prefer">
                            <Trans>Prefer</Trans>
                          </NativeSelectOption>
                        </NativeSelect>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t`Remove filter`}
                          onClick={() =>
                            setCriteriaEdit((current) =>
                              current
                                ? {
                                    ...current,
                                    searchFilters: current.searchFilters.filter(
                                      (item) => item.id !== filter.id,
                                    ),
                                  }
                                : null,
                            )
                          }
                        >
                          <X size={14} aria-hidden />
                        </Button>
                      </div>
                      <Textarea
                        aria-label={t`Search filter`}
                        value={filter.statement}
                        aria-invalid={!filter.statement.trim()}
                        onChange={(event) => {
                          const statement = event.target.value;
                          setCriteriaEdit((current) =>
                            current
                              ? {
                                  ...current,
                                  searchFilters: current.searchFilters.map((item) =>
                                    item.id === filter.id ? { ...item, statement } : item,
                                  ),
                                }
                              : null,
                          );
                        }}
                      />
                    </fieldset>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setCriteriaEdit((current) =>
                        current
                          ? {
                              ...current,
                              searchFilters: [
                                ...current.searchFilters,
                                { id: crypto.randomUUID(), statement: "", mode: "include" },
                              ],
                            }
                          : null,
                      )
                    }
                  >
                    <Trans>Add filter</Trans>
                  </Button>
                </>
              ) : workspace.revision.brief.searchFilters.length ? (
                <ul className="space-y-3">
                  {workspace.revision.brief.searchFilters.map((filter) => (
                    <li key={filter.id} className="space-y-1">
                      <p>
                        {filter.mode === "include" ? (
                          <Trans>Include</Trans>
                        ) : filter.mode === "exclude" ? (
                          <Trans>Exclude</Trans>
                        ) : (
                          <Trans>Prefer</Trans>
                        )}{" "}
                        · {filter.statement}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {filter.origin === "user_instruction" ? (
                          <Trans>User instruction</Trans>
                        ) : filter.origin === "jd" ? (
                          <Trans>JD</Trans>
                        ) : filter.origin === "hm" ? (
                          <Trans>Hiring manager</Trans>
                        ) : (
                          <Trans>Assumption</Trans>
                        )}
                      </p>
                      {filter.sourceRefIds.length ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            <Trans>Sources</Trans>
                          </summary>
                          <Sources
                            sourceTarget={{
                              kind: "role",
                              threadId,
                              roleRevisionId: workspace.revision.id,
                            }}
                            showDiagnostics={showDiagnostics}
                            sources={[
                              ...new Map(
                                [
                                  ...workspace.revision.sourceRefs,
                                  ...workspace.revision.criteria.flatMap(
                                    (criterion) => criterion.sourceRefs,
                                  ),
                                ].map((ref) => [ref.id, ref]),
                              ).values(),
                            ].filter((ref) => filter.sourceRefIds.includes(ref.id))}
                          />
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">
                  <Trans>No additional search filters</Trans>
                </p>
              )}
            </section>
          ) : null}
          {criteriaEdit?.roleId === workspace.role.id ? (
            <div className="space-y-4">
              {criteriaEdit.revision.criteria.map((criterion, index) => {
                const draft = criteriaEdit.criteria[index]!;
                return (
                  <fieldset key={criterion.id} className="space-y-2">
                    <legend className="sr-only">
                      <Trans>Criterion {index + 1}</Trans>
                    </legend>
                    <NativeSelect
                      aria-label={t`Priority`}
                      size="sm"
                      value={draft.priority}
                      onChange={(event) => {
                        const priority = event.target.value === "hard" ? "hard" : "preferred";
                        setCriteriaEdit((current) =>
                          current
                            ? {
                                ...current,
                                criteria: current.criteria.map((item) =>
                                  item.criterionId === criterion.id ? { ...item, priority } : item,
                                ),
                              }
                            : null,
                        );
                      }}
                    >
                      <NativeSelectOption value="hard">
                        <Trans>Hard</Trans>
                      </NativeSelectOption>
                      <NativeSelectOption value="preferred">
                        <Trans>Preferred</Trans>
                      </NativeSelectOption>
                    </NativeSelect>
                    <CriteriaExpressionFields
                      expression={criterion.expression}
                      atoms={draft.atoms}
                      onChange={(changedAtom) => {
                        setCriteriaEdit((current) =>
                          current
                            ? {
                                ...current,
                                criteria: current.criteria.map((item) => ({
                                  ...item,
                                  atoms: item.atoms.map((atom) =>
                                    atom.atomId === changedAtom.atomId ? changedAtom : atom,
                                  ),
                                })),
                              }
                            : null,
                        );
                      }}
                    />
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        <Trans>Sources</Trans>
                      </summary>
                      <div className="mt-2">
                        <Sources
                          sourceTarget={{
                            kind: "role",
                            threadId,
                            roleRevisionId: workspace.revision.id,
                          }}
                          showDiagnostics={showDiagnostics}
                          sources={criterion.sourceRefs}
                        />
                      </div>
                    </details>
                    {criterion.definitionQuestions.map((question) => (
                      <p key={question} className="text-muted-foreground">
                        {question}
                      </p>
                    ))}
                  </fieldset>
                );
              })}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    loading ||
                    failed ||
                    savingCriteria ||
                    invalidCriteria ||
                    invalidSearchFilters ||
                    (!criteriaChanges.length && !searchFiltersChanged)
                  }
                  aria-busy={savingCriteria}
                  onClick={() => void saveCriteria()}
                >
                  <Trans>Save</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={savingCriteria}
                  onClick={() => {
                    setCriteriaEdit(null);
                    setCriteriaFailed(false);
                  }}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
              {criteriaFailed ? (
                <p role="alert" className="text-destructive">
                  <Trans>Changes could not be saved.</Trans>
                </p>
              ) : null}
            </div>
          ) : (
            (["hard", "preferred"] as const).map((priority) => (
              <div key={priority} className="space-y-2">
                <h4 className="font-medium">
                  {priority === "hard" ? (
                    <Trans>Hard criteria</Trans>
                  ) : (
                    <Trans>Preferred criteria</Trans>
                  )}
                </h4>
                <ul className="space-y-3">
                  {criteria
                    .filter((criterion) => criterion.priority === priority)
                    .map((criterion) => (
                      <li key={criterion.id} className="space-y-2">
                        <CriteriaExpression expression={criterion.expression} />
                        {expressionAtoms(criterion.expression).map((atom) =>
                          "employmentRule" in atom ? (
                            <EmploymentRuleSummary key={atom.atomId} rule={atom.employmentRule} />
                          ) : null,
                        )}
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            <Trans>Sources</Trans>
                          </summary>
                          <div className="mt-2">
                            <Sources
                              sourceTarget={{
                                kind: "role",
                                threadId,
                                roleRevisionId: workspace.revision.id,
                              }}
                              showDiagnostics={showDiagnostics}
                              sources={criterion.sourceRefs}
                            />
                          </div>
                        </details>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          )}
          {workspace.revision.preferences.length ? (
            <div className="space-y-2">
              <h4 className="font-medium">
                <Trans>Preferences</Trans>
              </h4>
              <ul className="space-y-1">
                {workspace.revision.preferences.map((preference) => (
                  <li key={preference}>{preference}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              <Trans>Role sources</Trans>
            </summary>
            <div className="mt-2">
              <Sources
                sourceTarget={{
                  kind: "role",
                  threadId,
                  roleRevisionId: workspace.revision.id,
                }}
                sources={workspace.revision.sourceRefs}
                showDiagnostics={showDiagnostics}
              />
            </div>
          </details>
        </>
      ) : (
        <p className="text-muted-foreground">
          <Trans>No role linked</Trans>
        </p>
      )}
    </TabsContent>
  );
}
