import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Artifact,
  MemoryDocument,
  MemoryRevision,
  RecruitingArtifactRef,
  RecruitingCriterionExpression,
  RecruitingSourceRef,
  Verdict,
} from "@rakazo/contracts";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { Check, CircleHelp, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { Shimmer } from "../components/ai/primitives";
import { rpc } from "../lib/rpc";

type Props = {
  threadId: string;
  botId?: string;
  refreshSignal?: number;
  onClose: () => void;
};
type Snapshot = {
  workspace: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
  assessments: Awaited<ReturnType<typeof rpc.recruiting.listAssessments>>;
  research: Awaited<ReturnType<typeof rpc.recruiting.listResearch>>;
  documents: MemoryDocument[];
};

function expressionText(expression: RecruitingCriterionExpression): string {
  if (expression.kind === "atom") return expression.statement;
  if (expression.kind === "not") return `NOT (${expressionText(expression.item)})`;
  return `(${expression.items.map(expressionText).join(expression.kind === "all" ? " AND " : " OR ")})`;
}

function ArtifactReference({
  reference,
  label,
}: {
  reference: RecruitingArtifactRef;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || artifact) return;
    let cancelled = false;
    setFailed(false);
    void rpc.artifacts
      .getById({ artifactId: reference.artifactId })
      .then((value) => {
        if (!cancelled) setArtifact(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, artifact, reference.artifactId]);
  const target = artifact?.groupId
    ? { groupId: artifact.groupId }
    : artifact?.botId
      ? { botId: artifact.botId }
      : null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="py-1">
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      {open ? (
        <div className="mt-2 space-y-1">
          {artifact && target ? (
            <ArtifactFileCard
              target={target}
              artifactId={reference.artifactId}
              name={artifact.name}
              mimeType={artifact.mimeType}
              size={artifact.size}
            />
          ) : failed || artifact ? (
            <p role="alert">
              <Trans>Source unavailable</Trans>
            </p>
          ) : (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">{reference.artifactId}</p>
          <p className="break-all text-xs text-muted-foreground">SHA-256 {reference.sha256}</p>
        </div>
      ) : null}
    </details>
  );
}

function Sources({ sources }: { sources: readonly RecruitingSourceRef[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {sources.map((source) => (
        <li key={source.id} className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {source.kind} · {source.readState}
          </p>
          {source.anchor.kind === "message" ? (
            <div>
              <p>{source.anchor.locator}</p>
              <p className="break-all text-xs text-muted-foreground">{source.anchor.messageId}</p>
            </div>
          ) : (
            <ArtifactReference
              reference={source.anchor.artifact}
              key={`${source.anchor.artifact.artifactId}:${source.anchor.artifact.sha256}`}
              label={source.anchor.locator}
            />
          )}
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="block break-all underline underline-offset-4"
            >
              {source.url}
            </a>
          ) : null}
          {source.quote ? (
            <blockquote className="border-s-2 border-border ps-3 whitespace-pre-wrap">
              {source.quote}
            </blockquote>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MemoryDocumentView({ document }: { document: MemoryDocument }) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<MemoryRevision[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!showHistory || history) return;
    let cancelled = false;
    setFailed(false);
    void rpc.memory
      .history({ documentId: document.id })
      .then((value) => {
        if (!cancelled) setHistory(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showHistory, history, document.id]);
  return (
    <details className="border-b border-border py-3">
      <summary className="cursor-pointer break-words">
        {document.path}
        <span className="ms-2 text-xs text-muted-foreground">
          {document.scope} · <Trans>Revision {document.revision}</Trans>
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {document.botId ? <p className="text-xs text-muted-foreground">{document.botId}</p> : null}
        <p className="whitespace-pre-wrap break-words">{document.content}</p>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          <Trans>History</Trans>
        </Button>
        {showHistory ? (
          <div className="space-y-3 border-s border-border ps-3">
            {failed ? (
              <p role="alert">
                <Trans>Could not load history</Trans>
              </p>
            ) : !history ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : history.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No saved history</Trans>
              </p>
            ) : (
              history.map((entry) => (
                <div key={entry.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    <Trans>Revision {entry.revision}</Trans> · {entry.createdAt}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                  {entry.sourceThreadId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      <Trans>Thread</Trans> · {entry.sourceThreadId}
                    </p>
                  ) : null}
                  {entry.sourceRunId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      <Trans>Run</Trans> · {entry.sourceRunId}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function VerdictLabel({ verdict }: { verdict: Verdict }) {
  const Icon = verdict === "met" ? Check : verdict === "unmet" ? X : CircleHelp;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${verdict === "unmet" ? "text-destructive" : "text-muted-foreground"}`}
    >
      <Icon size={14} aria-hidden />
      {verdict === "met" ? (
        <Trans>Met</Trans>
      ) : verdict === "unmet" ? (
        <Trans>Unmet</Trans>
      ) : (
        <Trans>Unknown</Trans>
      )}
    </span>
  );
}

// Reset all fetched records when navigation changes the source thread, even before its reads finish.
export function RecruitingPanel(props: Props) {
  return <RecruitingWorkspace key={`${props.threadId}:${props.botId ?? "group"}`} {...props} />;
}

function RecruitingWorkspace({ threadId, botId, refreshSignal, onClose }: Props) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    async function load() {
      try {
        let workspace = await rpc.recruiting.getWorkspace({ threadId });
        while (!cancelled) {
          setSnapshot((current) =>
            current?.workspace?.role.id !== workspace?.role.id ||
            current?.workspace?.revision.id !== workspace?.revision.id
              ? null
              : current,
          );
          const [assessments, research, documents] = await Promise.all([
            workspace
              ? rpc.recruiting.listAssessments({ roleId: workspace.role.id })
              : Promise.resolve([]),
            workspace
              ? rpc.recruiting.listResearch({ roleId: workspace.role.id })
              : Promise.resolve({ tasks: [], actions: [] }),
            Promise.all([
              rpc.memory.list({ scope: "user" }),
              ...(botId ? [rpc.memory.list({ scope: "bot", botId })] : []),
            ]).then((lists) => lists.flat()),
          ]);
          if (cancelled) return;
          const verified = await rpc.recruiting.getWorkspace({ threadId });
          if (cancelled) return;
          if (
            workspace?.role.id !== verified?.role.id ||
            workspace?.revision.id !== verified?.revision.id
          ) {
            workspace = verified;
            continue;
          }
          setSnapshot({ workspace, assessments, research, documents });
          return;
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [threadId, botId, refresh, refreshSignal]);
  const workspace = snapshot?.workspace;
  const criteria = workspace?.revision.criteria ?? [];
  const assessments = snapshot?.assessments ?? [];
  return (
    <section aria-label={t`Recruiting`} className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium">
          <Trans>Recruiting</Trans>
        </h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Refresh`}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
            <X size={16} aria-hidden />
          </Button>
        </div>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not load recruiting</Trans>
        </p>
      ) : null}
      {loading ? (
        <div role="status" className="text-muted-foreground">
          <Shimmer>
            <Trans>Loading…</Trans>
          </Shimmer>
        </div>
      ) : null}
      {snapshot ? (
        <Tabs defaultValue="role" className="gap-4">
          <TabsList
            variant="line"
            aria-label={t`Recruiting views`}
            className="w-full overflow-x-auto justify-start"
          >
            <TabsTrigger value="role">
              <Trans>Role</Trans>
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
          <TabsContent value="role" className="space-y-5">
            {workspace ? (
              <>
                <div>
                  <h3 className="font-medium" dir="auto">
                    {workspace.role.title}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Version {workspace.revision.revision}</Trans>
                  </p>
                </div>
                {(["hard", "preferred"] as const).map((priority) => (
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
                            <p>{expressionText(criterion.expression)}</p>
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                <Trans>Sources</Trans>
                              </summary>
                              <div className="mt-2">
                                <Sources sources={criterion.sourceRefs} />
                              </div>
                            </details>
                            {criterion.definitionQuestions.map((question) => (
                              <p key={question} className="text-muted-foreground">
                                {question}
                              </p>
                            ))}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
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
                {workspace.revision.definitionQuestions.length ? (
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      <Trans>Definition questions</Trans>
                    </h4>
                    {workspace.revision.definitionQuestions.map((question) => (
                      <p key={question}>{question}</p>
                    ))}
                  </div>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    <Trans>Role sources</Trans>
                  </summary>
                  <div className="mt-2">
                    <Sources sources={workspace.revision.sourceRefs} />
                  </div>
                </details>
              </>
            ) : (
              <p className="text-muted-foreground">
                <Trans>No role linked</Trans>
              </p>
            )}
          </TabsContent>
          <TabsContent value="evidence" className="space-y-3">
            {!assessments.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved assessments</Trans>
              </p>
            ) : (
              assessments.map(({ assessment, isCurrent }) => (
                <details
                  key={`${assessment.candidateKey}:${assessment.version}`}
                  className="border-b border-border pb-3"
                >
                  <summary className="cursor-pointer break-words">
                    {assessment.candidateKey}{" "}
                    <span className="text-xs text-muted-foreground">
                      <Trans>Version {assessment.version}</Trans> ·{" "}
                      {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-4">
                    <p className="break-all text-xs text-muted-foreground">
                      {assessment.roleRevisionId}
                    </p>
                    {assessment.judgments.map((judgment) => (
                      <details key={judgment.criterionId} open className="space-y-2">
                        <summary className="cursor-pointer">
                          <span className="me-2">
                            {isCurrent
                              ? expressionText(
                                  criteria.find(
                                    (criterion) => criterion.id === judgment.criterionId,
                                  )?.expression ?? {
                                    kind: "atom",
                                    id: judgment.criterionId,
                                    statement: judgment.criterionId,
                                  },
                                )
                              : judgment.criterionId}
                          </span>
                          <VerdictLabel verdict={judgment.verdict} />
                        </summary>
                        {assessment.facts
                          .filter((fact) => judgment.factIds.includes(fact.id))
                          .map((fact) => (
                            <div key={fact.id} className="space-y-2">
                              <p>{fact.statement}</p>
                              <Sources
                                sources={assessment.sourceRefs.filter((source) =>
                                  fact.sourceRefIds.includes(source.id),
                                )}
                              />
                            </div>
                          ))}
                        <Sources
                          sources={assessment.sourceRefs.filter((source) =>
                            judgment.evidence.includes(source.id),
                          )}
                        />
                        {judgment.missing.map((question) => (
                          <p key={question} className="text-muted-foreground">
                            {question}
                          </p>
                        ))}
                      </details>
                    ))}
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        <Trans>Saved facts</Trans>
                      </summary>
                      <ul className="mt-2 space-y-3">
                        {assessment.facts.map((fact) => (
                          <li key={fact.id} className="space-y-2">
                            <p>{fact.statement}</p>
                            <Sources
                              sources={assessment.sourceRefs.filter((source) =>
                                fact.sourceRefIds.includes(source.id),
                              )}
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
                        <Sources sources={assessment.sourceRefs} />
                      </div>
                    </details>
                  </div>
                </details>
              ))
            )}
          </TabsContent>
          <TabsContent value="missing" className="space-y-5">
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Role definition</Trans>
              </h3>
              {[
                ...(workspace?.revision.definitionQuestions ?? []),
                ...criteria.flatMap((criterion) => criterion.definitionQuestions),
              ].map((question, index) => (
                <p key={`${index}:${question}`}>{question}</p>
              ))}
              {!workspace?.revision.definitionQuestions.length &&
              !criteria.some((criterion) => criterion.definitionQuestions.length) ? (
                <p className="text-muted-foreground">
                  <Trans>No saved questions</Trans>
                </p>
              ) : null}
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">
                <Trans>Candidate facts</Trans>
              </h3>
              {!assessments.length ? (
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
                      {assessment.candidateKey} ·{" "}
                      {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                    </p>
                    {[
                      ...assessment.questions,
                      ...assessment.judgments.flatMap((judgment) => judgment.missing),
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
            {!snapshot.documents.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved memory in these scopes</Trans>
              </p>
            ) : (
              snapshot.documents.map((document) => (
                <MemoryDocumentView
                  key={`${document.id}:${document.revision}`}
                  document={document}
                />
              ))
            )}
          </TabsContent>
          <TabsContent value="activity" className="space-y-5">
            {!snapshot.research.tasks.length ? (
              <p className="text-muted-foreground">
                <Trans>No research tasks</Trans>
              </p>
            ) : (
              snapshot.research.tasks.map((task) => (
                <div key={task.id} className="space-y-3">
                  <div>
                    <h3 className="break-all font-medium">{task.id}</h3>
                    <p className="text-xs text-muted-foreground">
                      {task.state} {task.providerTaskId ? `· ${task.providerTaskId}` : ""}
                    </p>
                  </div>
                  {snapshot.research.actions
                    .filter((action) => action.taskId === task.id)
                    .map((action) => (
                      <div key={action.id} className="space-y-2 border-s border-border ps-3">
                        <p>
                          {action.kind} · {action.deliveryState}
                          {action.observedProviderState ? ` · ${action.observedProviderState}` : ""}
                        </p>
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
                        {action.recallScope ? (
                          <p className="whitespace-pre-wrap">{action.recallScope}</p>
                        ) : null}
                        <ArtifactReference
                          key={`request:${action.requestArtifact.artifactId}:${action.requestArtifact.sha256}`}
                          reference={action.requestArtifact}
                          label={t`Request`}
                        />
                        <ArtifactReference
                          key={`context:${action.contextArtifact.artifactId}:${action.contextArtifact.sha256}`}
                          reference={action.contextArtifact}
                          label={t`Context`}
                        />
                        {action.receiptArtifact ? (
                          <ArtifactReference
                            key={`receipt:${action.receiptArtifact.artifactId}:${action.receiptArtifact.sha256}`}
                            reference={action.receiptArtifact}
                            label={t`Receipt`}
                          />
                        ) : null}
                        {action.outputArtifacts.map((reference) => (
                          <ArtifactReference
                            key={`${reference.artifactId}:${reference.sha256}`}
                            reference={reference}
                            label={t`Output`}
                          />
                        ))}
                      </div>
                    ))}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      ) : null}
    </section>
  );
}
