import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Artifact,
  ArtifactWithContent,
  ListRecruitingCandidatesOutput,
  MemoryDocument,
  MemoryRevision,
  ReadRecruitingSourceInput,
  RecruitingArtifactRef,
  RecruitingAssessmentSourceRef,
  RecruitingCandidate,
  RecruitingResearchAction,
  RecruitingResearchReadArtifact,
  RecruitingResearchTask,
  RecruitingSourceRef,
} from "@rakazo/contracts";
import {
  readRecruitingJsonString,
  readRecruitingResearchReadArtifact,
  validateRecruitingTextSelection,
  verifyRecruitingArtifactBytes,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { ArtifactFileCard, SourceText } from "../../components/ArtifactFileCard";
import { decodeArtifactBase64 } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { CrmDetails } from "../recruiting/CandidatePresentation";
import type {
  Props,
  Snapshot,
  SourceContent,
  SourceReadTarget,
} from "../recruiting/workspace-types";
import { CandidateReport } from "./CandidatePresentation";

export function ArtifactReference({
  reference,
  label,
  source,
  showDiagnostics = false,
  sourceRequest,
}: {
  reference: RecruitingArtifactRef;
  label: string;
  source?: RecruitingSourceRef | RecruitingAssessmentSourceRef;
  showDiagnostics?: boolean;
  sourceRequest?: ReadRecruitingSourceInput;
}) {
  const [open, setOpen] = useState(false);
  const sourceKey = JSON.stringify([reference, source, showDiagnostics, sourceRequest]);
  const currentSource = useRef({ reference, source, sourceRequest });
  currentSource.current = { reference, source, sourceRequest };
  const [state, setState] = useState<{
    key: string;
    artifact?: Artifact;
    excerpt?: SourceContent;
    unavailable?: boolean;
    failed?: boolean;
  } | null>(null);
  const current = state?.key === sourceKey ? state : null;
  const artifact = current?.artifact;
  useEffect(() => {
    if (!open || artifact || current?.excerpt) return;
    const { reference, source, sourceRequest } = currentSource.current;
    let cancelled = false;
    setState(null);
    if (!showDiagnostics) {
      if (!sourceRequest) {
        setState({ key: sourceKey, unavailable: true });
        return;
      }
      void rpc.recruiting.readSource(sourceRequest).then(
        (excerpt) => {
          if (!cancelled) setState({ key: sourceKey, excerpt });
        },
        () => {
          if (!cancelled) setState({ key: sourceKey, failed: true });
        },
      );
      return () => {
        cancelled = true;
      };
    }
    void rpc.artifacts
      .getById({ artifactId: reference.artifactId, includeDiagnostics: showDiagnostics })
      .then(async (value) => {
        if (value.id !== reference.artifactId) throw new Error("Source Artifact changed");
        const bytes = decodeArtifactBase64(value.contentBase64);
        if (bytes.byteLength !== value.size) throw new Error("Source Artifact size changed");
        await verifyRecruitingArtifactBytes(bytes, reference.sha256);
        let excerpt: Extract<SourceContent, { kind: "text" }> | undefined;
        let unavailable = false;
        if (source?.readState === "read" && source.quote) {
          try {
            const selection = "selection" in source ? source.selection : undefined;
            // ponytail: legacy role sources attest only native text; other strings need a typed path.
            if (
              source.anchor.kind !== "artifact" ||
              selection?.kind === "message_text" ||
              (!selection && source.anchor.locator !== "text")
            )
              throw new Error("Source text unavailable");
            const json = value.mimeType === "application/json" || value.mimeType.endsWith("+json");
            const path =
              selection?.kind === "artifact_json_string"
                ? selection.path
                : !selection && json
                  ? ["text"]
                  : undefined;
            if (path ? !json : !value.mimeType.startsWith("text/") || json)
              throw new Error("Source text unavailable");
            const text = path
              ? readRecruitingJsonString(bytes, path)
              : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const start = selection?.start ?? text.indexOf(source.quote);
            const end = selection?.end ?? start + source.quote.length;
            validateRecruitingTextSelection(text, start, end, source.quote);
            excerpt = { kind: "text", text, start, end };
          } catch {
            unavailable = true;
          }
        }
        if (!cancelled) setState({ key: sourceKey, artifact: value, excerpt, unavailable });
      })
      .catch(() => {
        if (!cancelled) setState({ key: sourceKey, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, artifact, sourceKey, current?.excerpt, showDiagnostics]);
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
          {!showDiagnostics ? (
            !current ? (
              <p role="status">
                <Trans>Loading…</Trans>
              </p>
            ) : current.failed ? (
              <p role="alert">
                <Trans>Source unavailable</Trans>
              </p>
            ) : null
          ) : artifact && target ? (
            <ArtifactFileCard
              target={{ ...target, includeDiagnostics: true }}
              artifactId={reference.artifactId}
              name={artifact.name}
              mimeType={artifact.mimeType}
              size={artifact.size}
            />
          ) : current?.failed || artifact ? (
            <p role="alert">
              <Trans>Source unavailable</Trans>
            </p>
          ) : (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          )}
          {current?.excerpt?.kind === "report" ? (
            <CandidateReport report={current.excerpt.report} showDiagnostics={showDiagnostics} />
          ) : current?.excerpt?.kind === "text" ? (
            <SourceText
              text={current.excerpt.text}
              start={current.excerpt.start}
              end={current.excerpt.end}
            />
          ) : current?.unavailable ? (
            <p role="alert">
              <Trans>Source unavailable</Trans>
            </p>
          ) : null}
          {showDiagnostics ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <Trans>Details</Trans>
              </summary>
              <p className="break-all">{reference.artifactId}</p>
              <p className="break-all">SHA-256 {reference.sha256}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export function Sources({
  sources,
  messageTargets,
  onRevealMessage,
  showDiagnostics = false,
  sourceTarget,
}: {
  sources: readonly (RecruitingSourceRef | RecruitingAssessmentSourceRef)[];
  messageTargets?: Snapshot["assessments"][number]["sourceMessageTargets"];
  onRevealMessage?: Props["onRevealMessage"];
  showDiagnostics?: boolean;
  sourceTarget?: SourceReadTarget;
}) {
  const { t } = useLingui();
  const byMessageId = new Map(messageTargets?.map((target) => [target.messageId, target]));
  return (
    <ul className="space-y-2 text-sm">
      {sources.map((source) => {
        const message =
          source.anchor.kind === "message" ? byMessageId.get(source.anchor.messageId) : undefined;
        return (
          <li key={source.id} className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {showDiagnostics ? (
                <>
                  {source.kind} · {source.readState}
                </>
              ) : (
                <>
                  {source.kind === "provider_report" ? (
                    <Trans>Research findings</Trans>
                  ) : source.kind === "original_material" ? (
                    <Trans>Original source</Trans>
                  ) : source.kind === "candidate_statement" ? (
                    <Trans>Candidate statement</Trans>
                  ) : (
                    <Trans>Recruiter verified</Trans>
                  )}
                  {" · "}
                  {source.readState === "read" ? (
                    <Trans>Reviewed</Trans>
                  ) : source.readState === "unread" ? (
                    <Trans>Not reviewed</Trans>
                  ) : (
                    <Trans>Unavailable</Trans>
                  )}
                </>
              )}
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
                label={showDiagnostics ? source.anchor.locator : t`Source`}
                source={source}
                showDiagnostics={showDiagnostics}
                sourceRequest={
                  sourceTarget ? { ...sourceTarget, sourceRefId: source.id } : undefined
                }
              />
            )}
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="block break-all underline underline-offset-4"
              >
                {showDiagnostics ? source.url : new URL(source.url).hostname}
              </a>
            ) : null}
            {source.quote && (showDiagnostics || source.anchor.kind === "message") ? (
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

export function MemoryDocumentView({
  document,
  showDiagnostics = false,
}: {
  document: MemoryDocument;
  showDiagnostics?: boolean;
}) {
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
        {showDiagnostics && document.botId ? (
          <p className="text-xs text-muted-foreground">{document.botId}</p>
        ) : null}
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
                  {showDiagnostics && entry.sourceThreadId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      <Trans>Thread</Trans> · {entry.sourceThreadId}
                    </p>
                  ) : null}
                  {showDiagnostics && entry.sourceRunId ? (
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

export function CandidateSources({
  candidate,
  research,
  refreshSignal,
  roleRevisionId,
  onAccessError,
  showDiagnostics = false,
}: {
  candidate: RecruitingCandidate;
  research: Snapshot["research"];
  refreshSignal: ListRecruitingCandidatesOutput | null;
  roleRevisionId: string;
  onAccessError: (error: unknown) => void;
  showDiagnostics?: boolean;
}) {
  const { t } = useLingui();
  const [page, setPage] = useState<Awaited<
    ReturnType<typeof rpc.recruiting.listCandidateSources>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const scope = useRef({ active: true, busy: false, generation: 0 });
  useEffect(() => {
    scope.current.active = refreshSignal !== null;
    scope.current.busy = false;
    const generation = ++scope.current.generation;
    setLoading(refreshSignal !== null);
    setFailed(false);
    if (!refreshSignal) return;
    void rpc.recruiting
      .listCandidateSources({
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        limit: 20,
      })
      .then((value) => {
        if (scope.current.active && generation === scope.current.generation) setPage(value);
      })
      .catch((error: unknown) => {
        if (scope.current.active && generation === scope.current.generation) {
          onAccessError(error);
          setFailed(true);
        }
      })
      .finally(() => {
        if (scope.current.active && generation === scope.current.generation) setLoading(false);
      });
    return () => {
      scope.current.active = false;
    };
  }, [candidate.roleId, candidate.candidateKey, refreshSignal, onAccessError]);
  async function more() {
    if (!page?.nextCursor || !scope.current.active || scope.current.busy) return;
    const generation = scope.current.generation;
    scope.current.busy = true;
    setLoading(true);
    setFailed(false);
    try {
      const value = await rpc.recruiting.listCandidateSources({
        roleId: candidate.roleId,
        candidateKey: candidate.candidateKey,
        limit: 20,
        cursor: page.nextCursor,
      });
      if (scope.current.active && generation === scope.current.generation)
        setPage((current) =>
          current ? { ...value, items: current.items.concat(value.items) } : value,
        );
    } catch (error) {
      if (scope.current.active && generation === scope.current.generation) {
        onAccessError(error);
        setFailed(true);
      }
    } finally {
      if (scope.current.active && generation === scope.current.generation) {
        scope.current.busy = false;
        setLoading(false);
      }
    }
  }
  return (
    <section aria-label={t`Saved candidate sources`} className="space-y-3">
      <h4 className="font-medium">
        <Trans>Saved candidate sources</Trans>
      </h4>
      {failed ? (
        <p role="alert">
          <Trans>Could not load candidate sources</Trans>
        </p>
      ) : null}
      {loading ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {page && !page.items.length ? (
        <p className="text-muted-foreground">
          <Trans>No saved discovery sources</Trans>
        </p>
      ) : null}
      {page?.items.map((source, index) => {
        const { crmImports, ...discovery } = source;
        const task = research.tasks.find((item) => item.id === source.taskId);
        const action = research.actions.find(
          (item) => item.id === source.actionId && item.taskId === source.taskId,
        );
        return (
          <div
            key={`${source.artifactRef.artifactId}:${source.rowIndex}:${source.effectId}`}
            className="space-y-2 border-s border-border ps-3"
          >
            {source.providerTaskId === null ? (
              <p className="text-xs font-medium">
                <Trans>Imported list</Trans>
              </p>
            ) : null}
            {source.roleRevisionId !== roleRevisionId ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Saved before latest role update</Trans>
              </p>
            ) : null}
            {showDiagnostics ? (
              <p className="text-xs text-muted-foreground">
                provider_report{action ? ` · ${action.kind}` : ""} · {source.observedAt}
              </p>
            ) : (
              <details open={index === 0} className="space-y-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <Trans>Research findings</Trans>
                  {" · "}
                  <time dateTime={source.observedAt}>
                    {new Date(source.observedAt).toLocaleString(undefined, {
                      timeZone: "America/Los_Angeles",
                      timeZoneName: "short",
                    })}
                  </time>
                </summary>
                {source.report ? (
                  <CandidateReport
                    report={source.report}
                    showDiagnostics={showDiagnostics}
                    condensed
                  />
                ) : (
                  <p className="text-muted-foreground">
                    <Trans>Source unavailable</Trans>
                  </p>
                )}
              </details>
            )}
            {showDiagnostics ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  <Trans>Discovery details</Trans>
                </summary>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(discovery, null, 2)}
                </pre>
                {crmImports.map((sync) => (
                  <CrmDetails
                    key={sync.effectId}
                    sync={sync}
                    target={sync.target}
                    showDiagnostics={showDiagnostics}
                  />
                ))}
              </details>
            ) : (
              crmImports.map((sync) => (
                <CrmDetails key={sync.effectId} sync={sync} target={sync.target} />
              ))
            )}
            {showDiagnostics ? (
              <ArtifactReference
                reference={source.artifactRef}
                label={t`Source Artifact`}
                showDiagnostics
              />
            ) : null}
            {showDiagnostics && task && action ? (
              <ResearchResults
                task={task}
                action={{ ...action, outputArtifacts: [source.artifactRef] }}
                isCurrent={source.roleRevisionId === roleRevisionId}
              />
            ) : null}
          </div>
        );
      })}
      {page?.nextCursor ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loading || !refreshSignal}
          onClick={() => void more()}
        >
          <Trans>More sources</Trans>
        </Button>
      ) : null}
    </section>
  );
}
export function ResearchResults({
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
        const artifact = await rpc.artifacts.getById({
          artifactId: reference.artifactId,
          includeDiagnostics: true,
        });
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
            const records = rows.map((row) =>
              row !== null && typeof row === "object" && !Array.isArray(row)
                ? (row as Record<string, unknown>)
                : null,
            );
            const columns = [...new Set(records.flatMap((row) => (row ? Object.keys(row) : [])))];
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
                  <Trans>Research findings</Trans>
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
                          {columns.length ? (
                            columns.map((column) => (
                              <th key={column} scope="col" className="py-2 pe-3 font-medium">
                                {column}
                              </th>
                            ))
                          ) : (
                            <th scope="col" className="py-2 pe-3 font-medium">
                              <Trans>Raw value</Trans>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={index} className="border-t border-border">
                            {records[index] && columns.length ? (
                              columns.map((column) => (
                                <td key={column} className="py-2 pe-3 align-top">
                                  <pre className="whitespace-pre-wrap break-words">
                                    {Object.hasOwn(records[index]!, column)
                                      ? JSON.stringify(records[index]![column], null, 2)
                                      : ""}
                                  </pre>
                                </td>
                              ))
                            ) : (
                              <td colSpan={columns.length || 1} className="py-2 pe-3 align-top">
                                <pre className="whitespace-pre-wrap break-words">
                                  {JSON.stringify(row, null, 2)}
                                </pre>
                              </td>
                            )}
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
                    target={{ ...target, includeDiagnostics: true }}
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
