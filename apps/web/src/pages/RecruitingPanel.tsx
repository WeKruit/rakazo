import {
  CandidateCounts,
  CandidateDecision,
  CandidateProfile,
  CandidateResearchMatch,
  CrmDetails,
  ResearchActionStatus,
} from "./recruiting/CandidatePresentation";
import { CriteriaExpression } from "./recruiting/CriteriaEditor";
import { CrmRecruitingPanel } from "./recruiting/CrmWorkbench";
import { RecruitingEvidenceTab } from "./recruiting/RecruitingEvidenceTab";
import { RecruitingRoleTab } from "./recruiting/RecruitingRoleTab";
import {
  ArtifactReference,
  CandidateSources,
  MemoryDocumentView,
  Sources,
} from "./recruiting/SourceDocuments";
import { useRecruitingWorkspace } from "./recruiting/useRecruitingWorkspace";
import { VerdictLabel } from "./recruiting/VerdictLabel";
import type { Props } from "./recruiting/workspace-types";

export type {
  CandidateDiscussionContext,
  CandidateFeedback,
  CrmBrowseSelection,
  CrmReplyDraftContext,
} from "./recruiting/workspace-types";

import { Plural, Trans } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { BriefcaseBusiness, Building2, Check, RefreshCw, X } from "lucide-react";
import { AskCard } from "../components/AskCard";
import { authClient } from "../lib/auth";
import { clearRecruitingReads } from "../lib/recruiting-read-cache";
import type { RecruitingPanelState } from "../lib/right-panel-state";
import { rpc } from "../lib/rpc";
import { CandidateFeedbackForm, FeedbackHistory } from "./recruiting/CandidateFeedback";

import { RetryNotice } from "./recruiting/RetryNotice";
import { TabLoading } from "./recruiting/shared";

// Reset all fetched records when navigation changes the source thread, even before its reads finish.
export function RecruitingPanel(props: Props) {
  return props.crmBrowse ? (
    <CrmRecruitingPanel
      key={JSON.stringify([props.readCacheScope, props.threadId, props.crmBrowse.selection])}
      {...props}
      browse={props.crmBrowse}
      agent={props.roleConversation ? <RoleAgentSection {...props} /> : undefined}
    />
  ) : (
    <NativeRecruitingPanel {...props} />
  );
}

/**
 * The role conversation's own saved results for the current workbench tab. A CRM role and an
 * agent-created role share one workbench: CRM records render below this section when linked.
 */
function RoleAgentSection({ crmBrowse, roleConversation: _, correspondence, ...props }: Props) {
  const view = crmBrowse?.view;
  if (view === "brief" || view === "feedback")
    return <NativeRecruitingPanel {...props} presentation="workspace" summary={view} />;
  if (view === "sequence" || view === "inbox" || view === "interview") return <>{correspondence}</>;
  if (view === "conversation") return null;
  return (
    <NativeRecruitingPanel
      {...props}
      presentation="workspace"
      // Search results and CRM contacts are one list.
      view={view === "shortlist" ? view : view === "workflow" ? "results" : "contacts"}
      tab={view === "workflow" ? "dashboard" : "evidence"}
    />
  );
}

function NativeRecruitingPanel(props: Props) {
  const userId = authClient.useSession().data?.user.id;
  return (
    <RecruitingWorkspace
      key={`${userId}:${props.threadId}:${props.botId ?? "group"}`}
      {...props}
      userId={userId}
    />
  );
}

function RecruitingWorkspace(props: Props & { userId?: string }) {
  const model = useRecruitingWorkspace(props);
  const {
    threadId,
    botId,
    readCache,
    readCacheScope,
    refreshSignal,
    onClose,
    onRevealMessage,
    onDiscussCandidate,
    onCandidateFeedback,
    candidateFeedbackRecipients,
    showDiagnostics,
    presentation,
    summary,
    onTabChange,
    t,
    snapshot,
    workspaceSnapshot,
    refresh,
    setRefresh,
    feedbackRefresh,
    setFeedbackRefresh,
    loading,
    failed,
    setCandidateList,
    activeTab,
    contactsView,
    shortlistView,
    tabsList,
    candidateDetailOpen,
    selection,
    candidateTrigger,
    candidateClose,
    candidateHandoff,
    candidatePage,
    setCandidateDetailOpen,
    candidateLoading,
    candidateFailed,
    selectedEvidence,
    evidenceFailed,
    candidateValidation,
    denyAccess,
    workspace,
    criteria,
    brief,
    briefFieldLabels,
    unphrasedBriefFields,
    roleQuestions,
    roleSources,
    assessments,
    selected,
    assessment,
    candidateFresh,
    selectedCrm,
    selectedCrmTarget,
    revealCandidateMessage,
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
  return (
    <section
      aria-label={t`Recruiting`}
      className={
        presentation === "workspace"
          ? "hire-recruiting-workspace space-y-4 text-sm"
          : "space-y-4 text-sm"
      }
    >
      {shortlistView || contactsView ? (
        <header className="hire-section-header">
          <h1>{shortlistView ? <Trans>Shortlist</Trans> : <Trans>Contacts</Trans>}</h1>
          {workspace ? <p>{workspace.role.title}</p> : null}
          {candidatePage ? (
            <p>
              <Plural
                value={candidatePage.counts.candidates}
                _1="# candidate in the pool"
                other="# candidates in the pool"
              />
            </p>
          ) : null}
        </header>
      ) : null}
      {presentation !== "workspace" ? (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-medium">
            <Trans>Recruiting</Trans>
          </h2>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Refresh`}
              disabled={candidateLoading || (loading && !workspaceSnapshot)}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={16} aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
              <X size={16} aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <RetryNotice onRetry={() => setRefresh((value) => value + 1)}>
          <Trans>Could not load recruiting</Trans>
        </RetryNotice>
      ) : loading &&
        (!workspaceSnapshot ||
          ["dashboard", "missing", "memory", "activity"].includes(activeTab)) ? (
        <TabLoading />
      ) : null}
      {workspaceSnapshot ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = value as RecruitingPanelState["tab"];
            setCandidateList((current) => ({ ...current, tab }));
            onTabChange?.(tab);
          }}
          className="gap-4"
        >
          {presentation !== "workspace" ? (
            <TabsList
              ref={tabsList}
              variant="line"
              aria-label={t`Recruiting views`}
              className="no-scrollbar w-full overflow-x-auto justify-start"
            >
              <TabsTrigger value="role">
                <Trans>Role</Trans>
              </TabsTrigger>
              <TabsTrigger value="dashboard">
                <Trans>Dashboard</Trans>
              </TabsTrigger>
              <TabsTrigger value="evidence">
                <Trans>Evidence</Trans>
              </TabsTrigger>
              <TabsTrigger value="missing">
                <Trans>Missing info</Trans>
              </TabsTrigger>
              <TabsTrigger value="memory">
                <Trans>Memory</Trans>
              </TabsTrigger>
              <TabsTrigger value="activity">
                <Trans>Activity</Trans>
              </TabsTrigger>
            </TabsList>
          ) : null}
          <TabsContent value="dashboard" className="space-y-4">
            {workspace ? <h3 className="font-medium">{workspace.role.title}</h3> : null}
            {candidateFailed ? (
              <p role="alert">
                <Trans>Could not load candidates</Trans>
              </p>
            ) : candidatePage ? (
              <CandidateCounts counts={candidatePage.counts} />
            ) : candidateLoading ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : null}
            <h3 className="font-medium">
              <Trans>Research history</Trans>
            </h3>
            {snapshot &&
            !snapshot.research.tasks.length &&
            !snapshot.research.observations.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved research</Trans>
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-2 border-s border-border ps-3">
                  <p>
                    {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>} · {task.state}
                  </p>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-1">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <p className="break-all text-xs">
                              {action.id} · {action.roleRevisionId}
                            </p>
                            {action.receiptArtifact ? (
                              <ArtifactReference
                                reference={action.receiptArtifact}
                                label={t`Receipt`}
                                showDiagnostics
                              />
                            ) : null}
                          </details>
                        ) : null}
                      </div>
                    ))}
                </div>
              ))
            )}
            {snapshot?.research.observations.length ? (
              <ul aria-label={t`Saved research results`} className="space-y-3">
                {snapshot?.research.observations.map((observation) => (
                  <li key={observation.effectId} className="space-y-1 border-s border-border ps-3">
                    <p>
                      {observation.rowCount === null ? (
                        <Trans>Saved results</Trans>
                      ) : (
                        <Trans>{observation.rowCount} saved source rows</Trans>
                      )}
                      {" · "}
                      <time dateTime={observation.observedAt}>
                        {new Date(observation.observedAt).toLocaleString(undefined, {
                          timeZone: "America/Los_Angeles",
                          timeZoneName: "short",
                        })}
                      </time>
                    </p>
                    {showDiagnostics ? (
                      <ArtifactReference
                        reference={observation.artifactRef}
                        label={t`Source Artifact`}
                        showDiagnostics
                      />
                    ) : null}
                    {showDiagnostics ? (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">
                          <Trans>Details</Trans>
                        </summary>
                        <dl className="break-all text-xs">
                          <dt>
                            <Trans>Provider task</Trans>
                          </dt>
                          <dd>{observation.providerTaskId}</dd>
                          <dt>
                            <Trans>Run</Trans>
                          </dt>
                          <dd>{observation.runId}</dd>
                          <dt>
                            <Trans>Role revision</Trans>
                          </dt>
                          <dd>{observation.roleRevisionId}</dd>
                        </dl>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </TabsContent>
          <RecruitingRoleTab model={model} />
          <RecruitingEvidenceTab model={model} />
          <TabsContent value="missing" className="space-y-5">
            {snapshot?.questions.map((question) => {
              const candidateKey =
                question.target.kind === "candidate" ? question.target.candidateKey : null;
              const target = question.groupId
                ? { groupId: question.groupId }
                : { botId: question.botId };
              return (
                <div
                  key={`${question.effectId}:${question.messageId}:${question.askIndex}`}
                  className="space-y-2 [&>div]:max-w-full"
                >
                  <p className="text-xs text-muted-foreground">
                    {question.target.kind === "candidate" ? (
                      <>
                        {showDiagnostics
                          ? question.target.candidateKey
                          : (candidatePage?.items.find(
                              (candidate) => candidate.candidateKey === candidateKey,
                            )?.name ?? t`Candidate question`)}{" "}
                        ·{" "}
                      </>
                    ) : null}
                    {question.isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                  </p>
                  <AskCard
                    block={question.block}
                    canAnswer={question.canAnswer}
                    onAnswer={async (answer) => {
                      await rpc.threads.answer({
                        ...target,
                        runId: question.runId,
                        messageId: question.messageId,
                        answer,
                      });
                      setRefresh((value) => value + 1);
                    }}
                  />
                  {onRevealMessage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRevealMessage({ ...target, messageId: question.messageId })}
                    >
                      <Trans>Open original question</Trans>
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Role definition</Trans>
              </h3>
              {roleQuestions.map((question, index) => (
                <p key={`${index}:${question}`}>{question}</p>
              ))}
              {unphrasedBriefFields.length && workspace ? (
                <>
                  <p role="status">
                    <Trans>Role details needing clarification: {unphrasedBriefFields.length}</Trans>
                  </p>
                  <ul className="space-y-3">
                    {unphrasedBriefFields.map((field) => (
                      <li key={field.key} className="space-y-1">
                        <p>
                          {field.state === "conflict" ? (
                            <Trans>Conflicting information</Trans>
                          ) : field.state === "missing" ? (
                            <Trans>Missing info</Trans>
                          ) : (
                            <Trans>Assumption</Trans>
                          )}
                        </p>
                        {field.value !== null ? (
                          <p className="whitespace-pre-wrap">{field.value}</p>
                        ) : null}
                        {field.sourceRefIds.length ? (
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
                                sources={roleSources.filter((source) =>
                                  field.sourceRefIds.includes(source.id),
                                )}
                              />
                            </div>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    <Trans>Ask an agent to clarify in chat.</Trans>
                  </p>
                </>
              ) : null}
              {snapshot && !roleQuestions.length && !unphrasedBriefFields.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved questions</Trans>
                </p>
              ) : null}
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">
                <Trans>Candidate facts</Trans>
              </h3>
              {!snapshot ? null : !assessments.length ? (
                <p className="text-muted-foreground">
                  <Trans>No saved assessments</Trans>
                </p>
              ) : (
                assessments.map(({ assessment, isCurrent }) => (
                  <div
                    key={`${assessment.candidateKey}:${assessment.version}`}
                    className="space-y-1"
                  >
                    <p className="text-xs text-muted-foreground">
                      {showDiagnostics
                        ? assessment.candidateKey
                        : (candidatePage?.items.find(
                            (candidate) => candidate.candidateKey === assessment.candidateKey,
                          )?.name ?? t`Unnamed candidate`)}{" "}
                      · {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                    </p>
                    {[
                      ...assessment.questions,
                      ...assessment.judgments.criteria.flatMap((judgment) => judgment.missing),
                    ].map((question, index) => (
                      <p key={`${index}:${question}`}>{question}</p>
                    ))}
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="memory" className="space-y-3">
            <div className="text-xs text-muted-foreground">
              <p>{botId ? <Trans>User and bot memory</Trans> : <Trans>User memory</Trans>}</p>
              {!botId ? (
                <p>
                  <Trans>Group bot memory is not included</Trans>
                </p>
              ) : null}
            </div>
            {snapshot?.documents.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No saved memory in these scopes</Trans>
              </p>
            ) : (
              snapshot?.documents.map((document) => (
                <MemoryDocumentView
                  key={`${document.id}:${document.revision}`}
                  document={document}
                  showDiagnostics={showDiagnostics}
                />
              ))
            )}
          </TabsContent>
          <TabsContent value="activity" className="space-y-5">
            {workspace ? (
              <FeedbackHistory
                key={workspace.role.id}
                roleId={workspace.role.id}
                refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                readCache={readCache}
                readCacheScope={readCacheScope}
                onAccessError={denyAccess}
              />
            ) : null}
            {snapshot?.research.tasks.length === 0 ? (
              <p className="text-muted-foreground">
                {snapshot?.research.observations.length ? (
                  <Trans>Results saved</Trans>
                ) : (
                  <Trans>No research activity</Trans>
                )}
              </p>
            ) : (
              snapshot?.research.tasks.map((task, index) => (
                <div key={task.id} className="space-y-3">
                  <div>
                    <h3 className="font-medium">
                      {showDiagnostics ? task.id : <Trans>Search {index + 1}</Trans>}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {task.state}{" "}
                      {showDiagnostics && task.providerTaskId ? `· ${task.providerTaskId}` : ""}
                    </p>
                  </div>
                  {snapshot?.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-2 border-s border-border ps-3">
                        <p>
                          {showDiagnostics ? (
                            <>
                              {action.kind} · {action.deliveryState}
                              {action.observedProviderState
                                ? ` · ${action.observedProviderState}`
                                : ""}
                            </>
                          ) : (
                            <ResearchActionStatus action={action} />
                          )}
                        </p>
                        {showDiagnostics ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              <Trans>Details</Trans>
                            </summary>
                            <div className="space-y-1 break-all text-xs text-muted-foreground">
                              <p>{action.id}</p>
                              <p>{action.roleRevisionId}</p>
                              <p>{action.runId}</p>
                              <p>{action.sourceMessageId}</p>
                              {action.usage?.map((usage, index) => (
                                <p key={`${index}:${usage.unit}`}>
                                  {usage.scope} · {usage.amount} {usage.unit}
                                </p>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {action.recallScope ? (
                          <p className="whitespace-pre-wrap">{action.recallScope}</p>
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`request:${action.requestArtifact.artifactId}:${action.requestArtifact.sha256}`}
                            reference={action.requestArtifact}
                            label={t`Request`}
                          />
                        ) : null}
                        {showDiagnostics ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`context:${action.contextArtifact.artifactId}:${action.contextArtifact.sha256}`}
                            reference={action.contextArtifact}
                            label={t`Context`}
                          />
                        ) : null}
                        {showDiagnostics && action.receiptArtifact ? (
                          <ArtifactReference
                            showDiagnostics
                            key={`receipt:${action.receiptArtifact.artifactId}:${action.receiptArtifact.sha256}`}
                            reference={action.receiptArtifact}
                            label={t`Receipt`}
                          />
                        ) : null}
                        {showDiagnostics
                          ? action.outputArtifacts.map((reference) => (
                              <ArtifactReference
                                showDiagnostics
                                key={`${reference.artifactId}:${reference.sha256}`}
                                reference={reference}
                                label={t`Output`}
                              />
                            ))
                          : null}
                      </div>
                    ))}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      ) : null}
      <Dialog
        open={candidateDetailOpen && !!selection}
        onOpenChange={setCandidateDetailOpen}
        onOpenChangeComplete={(open) => {
          if (open) return;
          const handoff = candidateHandoff.current;
          if (!handoff) return;
          // Let the popup unmount before the native chat callback takes focus.
          queueMicrotask(() => {
            if (candidateHandoff.current !== handoff) return;
            candidateHandoff.current = null;
            handoff();
          });
        }}
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={candidateClose}
          data-product-view={presentation === "workspace" ? "recruiting" : undefined}
          finalFocus={candidateHandoff.current ? false : candidateTrigger}
          className={
            presentation === "workspace"
              ? "hire-profile-drawer inset-y-0 right-0 left-auto top-0 h-dvh max-h-dvh translate-x-0 translate-y-0 overflow-y-auto rounded-none text-sm leading-relaxed sm:max-w-2xl"
              : "max-h-[85dvh] overflow-y-auto text-base leading-relaxed sm:max-w-2xl"
          }
        >
          {selection ? (
            <div className="hire-candidate-body space-y-3">
              <div className="hire-candidate-header flex items-start justify-between gap-3">
                <DialogTitle className="break-words">
                  {selection.name ??
                    (showDiagnostics ? selection.candidateKey : t`Unnamed candidate`)}
                  <CandidateDecision decision={selection.decision} />
                </DialogTitle>
                <DialogClose
                  ref={candidateClose}
                  aria-label={t`Close`}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <X size={16} aria-hidden />
                </DialogClose>
              </div>
              {selection.title || selection.company || selection.location ? (
                <p className="text-muted-foreground">
                  {[selection.title, selection.company, selection.location]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              <CandidateProfile candidate={selection} showDiagnostics={showDiagnostics} />
              <CandidateResearchMatch
                candidate={selection}
                roleRevisionId={workspace?.revision.id}
                showDiagnostics={showDiagnostics}
              />
              <div className="hire-candidate-actions">
                {onDiscussCandidate && workspace ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      candidateHandoff.current = () =>
                        onDiscussCandidate({
                          threadId,
                          roleTitle: workspace.role.title,
                          name: selection.name,
                          title: selection.title,
                          company: selection.company,
                          linkedinUrl: selection.linkedinUrl,
                          resumeUrl: selection.resumeUrl,
                        });
                      setCandidateDetailOpen(false);
                    }}
                  >
                    <Trans>Discuss candidate</Trans>
                  </Button>
                ) : null}
                {onCandidateFeedback && workspace && candidateDetailOpen ? (
                  <CandidateFeedbackForm
                    key={`${threadId}:${workspace.role.id}:${workspace.revision.id}:${selection.candidateKey}`}
                    candidate={{
                      threadId,
                      roleTitle: workspace.role.title,
                      roleVersion: workspace.revision.revision,
                      roleId: workspace.role.id,
                      roleRevisionId: workspace.revision.id,
                      candidateKey: selection.candidateKey,
                      candidateRevision: selection.revision,
                      name: selection.name,
                      title: selection.title,
                      company: selection.company,
                      linkedinUrl: selection.linkedinUrl,
                      resumeUrl: selection.resumeUrl,
                    }}
                    onSend={(...args) =>
                      candidateFresh &&
                      (!readCache || candidateValidation.current === readCache.epoch)
                        ? onCandidateFeedback(...args)
                        : Promise.resolve(false)
                    }
                    disabled={!candidateFresh}
                    recipients={candidateFeedbackRecipients}
                    onAccessError={denyAccess}
                    onRecorded={() => {
                      clearRecruitingReads(readCache, readCacheScope);
                      setRefresh((value) => value + 1);
                      setFeedbackRefresh((value) => value + 1);
                    }}
                  />
                ) : null}
              </div>
              {workspace ? (
                <FeedbackHistory
                  key={`feedback:${workspace.role.id}:${selection.candidateKey}`}
                  roleId={workspace.role.id}
                  candidateKey={selection.candidateKey}
                  refreshSignal={(refreshSignal ?? 0) + feedbackRefresh}
                  readCache={readCache}
                  readCacheScope={readCacheScope}
                  onAccessError={denyAccess}
                  collapsed
                />
              ) : null}
              {selectedCrmTarget ? (
                <section aria-label={t`Candidate pipeline`}>
                  <CrmDetails
                    sync={selectedCrm}
                    target={selectedCrmTarget}
                    showDiagnostics={showDiagnostics}
                  />
                </section>
              ) : null}
              {selection.latestAssessment && evidenceFailed ? (
                <p role="alert">
                  <Trans>Could not load assessment</Trans>
                </p>
              ) : selection.latestAssessment && !selectedEvidence ? (
                <p role="status">
                  <Trans>Loading…</Trans>
                </p>
              ) : selection.latestAssessment && !selected ? (
                <p role="alert">
                  <Trans>Assessment unavailable</Trans>
                </p>
              ) : null}
              {workspace && snapshot ? (
                <CandidateSources
                  key={`${selection.roleId}:${selection.candidateKey}`}
                  candidate={selection}
                  research={snapshot.research}
                  refreshSignal={candidateFresh ? candidatePage : null}
                  roleRevisionId={workspace.revision.id}
                  onAccessError={denyAccess}
                  showDiagnostics={showDiagnostics}
                />
              ) : null}
            </div>
          ) : null}
          {assessment && selected ? (
            <section
              key={`${assessment.roleId}:${assessment.candidateKey}:${assessment.version}`}
              aria-label={showDiagnostics ? assessment.candidateKey : t`Candidate assessment`}
              className="space-y-4 border-t border-border pt-4"
            >
              <h3 className="font-medium">
                {showDiagnostics
                  ? assessment.candidateKey
                  : (selection?.name ?? t`Unnamed candidate`)}
              </h3>
              <p className="text-xs text-muted-foreground">
                <Trans>Internal assessment</Trans> · <Trans>Role</Trans> ·{" "}
                <Trans>Version {selected.roleRevision.revision}</Trans>
              </p>
              <p className="flex items-center gap-2">
                <span>
                  <Trans>Hard criteria</Trans>
                </span>
                <VerdictLabel verdict={assessment.judgments.hardGate} />
              </p>
              {assessment.judgments.employment.map((employment) => {
                const count =
                  employment.upperMonths === employment.lowerMonths
                    ? String(employment.lowerMonths)
                    : `${employment.lowerMonths}–${employment.upperMonths ?? "?"}`;
                const cutoff = `${employment.cutoff.year}-${String(employment.cutoff.month).padStart(2, "0")}-${String(employment.cutoff.day).padStart(2, "0")}`;
                return (
                  <div key={employment.atomId} className="space-y-1">
                    <p>{employment.qualificationDefinition}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        <Trans>{count} months</Trans> · ≥ {employment.minimumMonths} · {cutoff}
                      </span>
                      <VerdictLabel verdict={employment.verdict} />
                    </p>
                  </div>
                );
              })}
              {assessment.judgments.criteria.map((judgment) => {
                const criterion = selected.roleRevision.criteria.find(
                  (item) => item.id === judgment.criterionId,
                );
                const facts = assessment.facts.filter((fact) => judgment.factIds.includes(fact.id));
                const sourceIds = new Set([
                  ...facts.flatMap((fact) => fact.sourceRefIds),
                  ...judgment.evidence,
                ]);
                return (
                  <details key={judgment.criterionId} open className="space-y-2">
                    <summary className="cursor-pointer">
                      <span className="me-2">
                        {criterion?.expression.kind === "atom"
                          ? criterion.expression.statement
                          : t`Criterion`}
                      </span>
                      <VerdictLabel verdict={judgment.verdict} />
                      {criterion ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          {criterion.priority === "hard" ? (
                            <Trans>Hard criteria</Trans>
                          ) : (
                            <Trans>Preferred criteria</Trans>
                          )}
                        </span>
                      ) : null}
                    </summary>
                    {criterion && criterion.expression.kind !== "atom" ? (
                      <CriteriaExpression expression={criterion.expression} />
                    ) : null}
                    {facts.map((fact) => (
                      <p key={fact.id}>{fact.statement}</p>
                    ))}
                    <Sources
                      sourceTarget={{
                        kind: "assessment",
                        roleId: assessment.roleId,
                        candidateKey: assessment.candidateKey,
                        version: assessment.version,
                      }}
                      sources={assessment.sourceRefs.filter((source) => sourceIds.has(source.id))}
                      messageTargets={selected.sourceMessageTargets}
                      onRevealMessage={revealCandidateMessage}
                      showDiagnostics={showDiagnostics}
                    />
                    {judgment.missing.map((question) => (
                      <p key={question} className="text-muted-foreground">
                        {question}
                      </p>
                    ))}
                  </details>
                );
              })}
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Saved facts</Trans>
                </summary>
                <ul className="mt-2 space-y-3">
                  {assessment.facts.map((fact) => (
                    <li key={fact.id} className="space-y-2">
                      <p>{fact.statement}</p>
                      <Sources
                        sourceTarget={{
                          kind: "assessment",
                          roleId: assessment.roleId,
                          candidateKey: assessment.candidateKey,
                          version: assessment.version,
                        }}
                        sources={assessment.sourceRefs.filter((source) =>
                          fact.sourceRefIds.includes(source.id),
                        )}
                        messageTargets={selected.sourceMessageTargets}
                        onRevealMessage={revealCandidateMessage}
                        showDiagnostics={showDiagnostics}
                      />
                    </li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Sources</Trans>
                </summary>
                <div className="mt-2">
                  <Sources
                    sourceTarget={{
                      kind: "assessment",
                      roleId: assessment.roleId,
                      candidateKey: assessment.candidateKey,
                      version: assessment.version,
                    }}
                    showDiagnostics={showDiagnostics}
                    sources={assessment.sourceRefs}
                    messageTargets={selected.sourceMessageTargets}
                    onRevealMessage={revealCandidateMessage}
                  />
                </div>
              </details>
            </section>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
