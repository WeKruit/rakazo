import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Artifact,
  ArtifactWithContent,
  MemoryDocument,
  MemoryRevision,
  RecruitingArtifactRef,
  RecruitingCriterionExpression,
  RecruitingResearchAction,
  RecruitingResearchReadArtifact,
  RecruitingResearchTask,
  RecruitingSourceRef,
  Verdict,
} from "@rakazo/contracts";
import { readRecruitingResearchReadArtifact } from "@rakazo/core";
import {
  Button,
  Card,
  CardContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Check, CircleHelp, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { Shimmer } from "../components/ai/primitives";
import { decodeArtifactBase64 } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

type Props = {
  threadId: string;
  botId?: string;
  refreshSignal?: number;
  onClose: () => void;
  onRevealMessage?: (target: { botId?: string; groupId?: string; messageId: string }) => void;
};
type Snapshot = {
  workspace: Awaited<ReturnType<typeof rpc.recruiting.getWorkspace>>;
  assessments: Awaited<ReturnType<typeof rpc.recruiting.listAssessments>>;
  research: Awaited<ReturnType<typeof rpc.recruiting.listResearch>>;
  questions: Awaited<ReturnType<typeof rpc.recruiting.listQuestions>>["questions"];
  documents: MemoryDocument[];
};

function ResearchResults({
  task,
  action,
  isCurrent,
}: {
  task: RecruitingResearchTask;
  action: RecruitingResearchAction;
  isCurrent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sourceKey = JSON.stringify([
    task.id,
    task.roleId,
    task.providerTaskId,
    action.id,
    action.taskId,
    action.roleRevisionId,
    action.outputArtifacts,
  ]);
  const source = useRef({ task, action });
  source.current = { task, action };
  const [state, setState] = useState<{
    key: string;
    results?: {
      artifact: ArtifactWithContent;
      reference: RecruitingArtifactRef;
      snapshot: RecruitingResearchReadArtifact;
    }[];
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    const { task, action } = source.current;
    let cancelled = false;
    setState(null);
    // ponytail: load only an expanded action; batch Artifact reads if saved output history grows.
    void Promise.all(
      action.outputArtifacts.map(async (reference) => {
        const artifact = await rpc.artifacts.getById({ artifactId: reference.artifactId });
        if (artifact.id !== reference.artifactId) throw new Error("Result Artifact changed");
        const snapshot = await readRecruitingResearchReadArtifact(
          decodeArtifactBase64(artifact.contentBase64),
          { task, action, artifact: reference },
        );
        return { artifact, reference, snapshot };
      }),
    )
      .then((results) => {
        if (!cancelled)
          setState({
            key: sourceKey,
            results: results.filter(
              ({ snapshot }) =>
                snapshot.operation === "rows" && snapshot.observation.deliveryState === "accepted",
            ),
          });
      })
      .catch(() => {
        if (!cancelled) setState({ key: sourceKey, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceKey]);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="space-y-3"
      data-research-action={action.id}
    >
      <summary className="cursor-pointer">
        <Trans>Raw search results</Trans> · {action.kind} · <Trans>Role</Trans> ·{" "}
        {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
      </summary>
      {open ? (
        !state || state.key !== sourceKey ? (
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        ) : state.failed ? (
          <p role="alert">
            <Trans>Could not load search results</Trans>
          </p>
        ) : !state.results?.length ? (
          <p className="text-muted-foreground">
            <Trans>No saved result rows</Trans>
          </p>
        ) : (
          state.results.map(({ artifact, reference, snapshot: result }) => {
            const rows = result.observation.rows!;
            const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
            const target = artifact.groupId
              ? { groupId: artifact.groupId }
              : artifact.botId
                ? { botId: artifact.botId }
                : null;
            return (
              <section
                key={`${reference.artifactId}:${reference.sha256}`}
                aria-label={reference.artifactId}
                className="space-y-2 border-s border-border ps-3"
              >
                <p className="text-xs text-muted-foreground">
                  <Trans>Unassessed</Trans> · provider_report
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    <Trans>Details</Trans>
                  </summary>
                  <pre className="whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(
                      {
                        taskId: task.id,
                        providerTaskId: task.providerTaskId,
                        actionId: action.id,
                        roleRevisionId: action.roleRevisionId,
                        actionRunId: action.runId,
                        artifact: reference,
                        capturedByRunId: artifact.runId,
                        capturedAt: artifact.createdAt,
                        effectId: result.effectId,
                        request: result.request,
                        ...(result.observation.nextCursor === undefined
                          ? {}
                          : { nextCursor: result.observation.nextCursor }),
                        ...(result.observation.outputId === undefined
                          ? {}
                          : { outputId: result.observation.outputId }),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {rows.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <caption className="sr-only">
                        <Trans>Raw search results</Trans>
                      </caption>
                      <thead>
                        <tr>
                          {columns.map((column) => (
                            <th key={column} scope="col" className="py-2 pe-3 font-medium">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={index} className="border-t border-border">
                            {columns.map((column) => (
                              <td key={column} className="py-2 pe-3 align-top">
                                <pre className="whitespace-pre-wrap break-words">
                                  {Object.hasOwn(row, column)
                                    ? JSON.stringify(row[column], null, 2)
                                    : ""}
                                </pre>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    <Trans>No saved result rows</Trans>
                  </p>
                )}
                {target ? (
                  <ArtifactFileCard
                    target={target}
                    artifactId={artifact.id}
                    name={artifact.name}
                    mimeType={artifact.mimeType}
                    size={artifact.size}
                  />
                ) : null}
              </section>
            );
          })
        )
      ) : null}
    </details>
  );
}

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

function Sources({
  sources,
  messageTargets,
  onRevealMessage,
}: {
  sources: readonly RecruitingSourceRef[];
  messageTargets?: Snapshot["assessments"][number]["sourceMessageTargets"];
  onRevealMessage?: Props["onRevealMessage"];
}) {
  const byMessageId = new Map(messageTargets?.map((target) => [target.messageId, target]));
  return (
    <ul className="space-y-2 text-sm">
      {sources.map((source) => {
        const message =
          source.anchor.kind === "message" ? byMessageId.get(source.anchor.messageId) : undefined;
        return (
          <li key={source.id} className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {source.kind} · {source.readState}
            </p>
            {source.anchor.kind === "message" ? (
              <div>
                {onRevealMessage && message ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto justify-start whitespace-normal p-0 text-left"
                    onClick={() =>
                      onRevealMessage({ ...message.target, messageId: message.messageId })
                    }
                  >
                    <Trans>Message</Trans>
                  </Button>
                ) : (
                  <p>
                    <Trans>Message</Trans>
                  </p>
                )}
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
        );
      })}
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

function RecruitingWorkspace({ threadId, botId, refreshSignal, onClose, onRevealMessage }: Props) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [candidateView, setCandidateView] = useState<"cards" | "table">("cards");
  const [selection, setSelection] = useState<{ roleId: string; candidateKey: string } | null>(null);
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
          const [assessments, research, questions, documents] = await Promise.all([
            workspace
              ? rpc.recruiting.listAssessments({ roleId: workspace.role.id })
              : Promise.resolve([]),
            workspace
              ? rpc.recruiting.listResearch({ roleId: workspace.role.id })
              : Promise.resolve({ tasks: [], actions: [] }),
            workspace
              ? rpc.recruiting.listQuestions({ threadId, roleId: workspace.role.id })
              : Promise.resolve({ questions: [] }),
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
          setSnapshot({
            workspace,
            assessments,
            research,
            questions: questions.questions,
            documents,
          });
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
  const selected =
    selection && selection.roleId === workspace?.role.id
      ? assessments.find(
          ({ assessment }) =>
            assessment.roleId === selection.roleId &&
            assessment.candidateKey === selection.candidateKey,
        )
      : undefined;
  const assessment = selected?.assessment;
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
          <TabsContent value="evidence" className="space-y-4">
            {snapshot.research.tasks.flatMap((task) =>
              snapshot.research.actions
                .filter((action) => action.taskId === task.id && action.outputArtifacts.length)
                .map((action) => (
                  <ResearchResults
                    key={`${task.roleId}:${action.id}`}
                    task={task}
                    action={action}
                    isCurrent={action.roleRevisionId === workspace?.revision.id}
                  />
                )),
            )}
            {!assessments.length ? (
              <p className="text-muted-foreground">
                <Trans>No saved assessments</Trans>
              </p>
            ) : (
              <>
                <fieldset className="flex gap-1" aria-label={t`Saved assessments`}>
                  <Button
                    size="sm"
                    variant={candidateView === "cards" ? "secondary" : "ghost"}
                    aria-pressed={candidateView === "cards"}
                    onClick={() => setCandidateView("cards")}
                  >
                    <Trans>Cards</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant={candidateView === "table" ? "secondary" : "ghost"}
                    aria-pressed={candidateView === "table"}
                    onClick={() => setCandidateView("table")}
                  >
                    <Trans>Table</Trans>
                  </Button>
                </fieldset>
                {candidateView === "cards" ? (
                  <ul className="grid gap-2">
                    {assessments.map(({ assessment: item, isCurrent }) => (
                      <li key={`${item.roleId}:${item.candidateKey}`}>
                        <Card
                          size="sm"
                          className={
                            assessment?.candidateKey === item.candidateKey
                              ? "ring-primary"
                              : undefined
                          }
                        >
                          <CardContent className="space-y-2">
                            <Button
                              variant="link"
                              className="h-auto justify-start whitespace-normal break-all p-0 text-left"
                              aria-pressed={assessment?.candidateKey === item.candidateKey}
                              onClick={() =>
                                setSelection({
                                  roleId: item.roleId,
                                  candidateKey: item.candidateKey,
                                })
                              }
                            >
                              {item.candidateKey}
                            </Button>
                            <p className="text-xs text-muted-foreground">
                              <Trans>Version {item.version}</Trans> ·{" "}
                              {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                            </p>
                            <VerdictLabel verdict={item.judgments.hardGate} />
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">
                        <Trans>Saved assessments</Trans>
                      </caption>
                      <thead>
                        <tr className="border-b border-border">
                          <th scope="col" className="py-2 pe-3 font-medium">
                            <Trans>Candidate</Trans>
                          </th>
                          <th scope="col" className="py-2 pe-3 font-medium">
                            <Trans>Version</Trans>
                          </th>
                          <th scope="col" className="py-2 pe-3 font-medium">
                            <Trans>Status</Trans>
                          </th>
                          <th scope="col" className="py-2 font-medium">
                            <Trans>Hard criteria</Trans>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {assessments.map(({ assessment: item, isCurrent }) => (
                          <tr
                            key={`${item.roleId}:${item.candidateKey}`}
                            className="border-b border-border"
                          >
                            <th scope="row" className="py-2 pe-3 font-medium">
                              <Button
                                variant="link"
                                className="h-auto justify-start whitespace-normal break-all p-0 text-left"
                                aria-pressed={assessment?.candidateKey === item.candidateKey}
                                onClick={() =>
                                  setSelection({
                                    roleId: item.roleId,
                                    candidateKey: item.candidateKey,
                                  })
                                }
                              >
                                {item.candidateKey}
                              </Button>
                            </th>
                            <td className="py-2 pe-3 tabular-nums">{item.version}</td>
                            <td className="py-2 pe-3 whitespace-nowrap">
                              {isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
                            </td>
                            <td className="py-2">
                              <VerdictLabel verdict={item.judgments.hardGate} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {assessment && selected ? (
                  <section
                    key={`${assessment.roleId}:${assessment.candidateKey}:${assessment.version}`}
                    aria-label={assessment.candidateKey}
                    className="space-y-4 border-t border-border pt-4"
                  >
                    <h3 className="break-all font-medium">{assessment.candidateKey}</h3>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Role</Trans> · <Trans>Version {selected.roleRevision.revision}</Trans>
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
                              <Trans>{count} months</Trans> · ≥ {employment.minimumMonths} ·{" "}
                              {cutoff}
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
                      const facts = assessment.facts.filter((fact) =>
                        judgment.factIds.includes(fact.id),
                      );
                      const sourceIds = new Set([
                        ...facts.flatMap((fact) => fact.sourceRefIds),
                        ...judgment.evidence,
                      ]);
                      return (
                        <details key={judgment.criterionId} open className="space-y-2">
                          <summary className="cursor-pointer">
                            <span className="me-2">
                              {criterion
                                ? expressionText(criterion.expression)
                                : judgment.criterionId}
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
                          {facts.map((fact) => (
                            <p key={fact.id}>{fact.statement}</p>
                          ))}
                          <Sources
                            sources={assessment.sourceRefs.filter((source) =>
                              sourceIds.has(source.id),
                            )}
                            messageTargets={selected.sourceMessageTargets}
                            onRevealMessage={onRevealMessage}
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
                              sources={assessment.sourceRefs.filter((source) =>
                                fact.sourceRefIds.includes(source.id),
                              )}
                              messageTargets={selected.sourceMessageTargets}
                              onRevealMessage={onRevealMessage}
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
                          sources={assessment.sourceRefs}
                          messageTargets={selected.sourceMessageTargets}
                          onRevealMessage={onRevealMessage}
                        />
                      </div>
                    </details>
                  </section>
                ) : null}
              </>
            )}
          </TabsContent>
          <TabsContent value="missing" className="space-y-5">
            {snapshot.questions.map((question) => {
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
                      <>{question.target.candidateKey} · </>
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
