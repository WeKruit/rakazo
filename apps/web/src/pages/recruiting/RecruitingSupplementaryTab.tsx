import { lazyPanel } from "../../components/ErrorBoundary";

import { CandidateCounts, ResearchActionStatus } from "./CandidatePresentation";

const ArtifactReference = lazyPanel(() =>
  import("./SourceDocuments").then((m) => m.ArtifactReference),
);
const MemoryDocumentView = lazyPanel(() =>
  import("./SourceDocuments").then((m) => m.MemoryDocumentView),
);
const Sources = lazyPanel(() => import("./SourceDocuments").then((m) => m.Sources));

import { Trans, useLingui } from "@lingui/react/macro";
import { Button, TabsContent } from "@rakazo/ui-web";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";

const AskCard = lazyPanel(() => import("../../components/AskCard").then((m) => m.AskCard));

import { rpc } from "../../lib/rpc";

const FeedbackHistory = lazyPanel(() =>
  import("./CandidateFeedback").then((m) => m.FeedbackHistory),
);

export function RecruitingSupplementaryTab({
  model,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
}) {
  const { t } = useLingui();
  const {
    threadId,
    botId,
    readCache,
    readCacheScope,
    refreshSignal,
    onRevealMessage,
    showDiagnostics,
    snapshot,
    setRefresh,
    feedbackRefresh,
    activeTab,
    candidatePage,
    candidateLoading,
    candidateFailed,
    denyAccess,
    workspace,
    unphrasedBriefFields,
    roleQuestions,
    roleSources,
    assessments,
  } = model;

  return (
    <>
      {activeTab === "dashboard" ? (
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
          {snapshot && !snapshot.research.tasks.length && !snapshot.research.observations.length ? (
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
      ) : null}
      {activeTab === "missing" ? (
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
                <div key={`${assessment.candidateKey}:${assessment.version}`} className="space-y-1">
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
      ) : null}
      {activeTab === "memory" ? (
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
      ) : null}
      {activeTab === "activity" ? (
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
      ) : null}
    </>
  );
}
