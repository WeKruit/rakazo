import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor, RecruitingArtifactRef } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getRecruitingWorkspace, recordRecruitingContextAdoption } from "@rakazo/db";
import type { LoadedAgentMemoryContext } from "./memory-context.js";

export const RECRUITING_PRESENTATION_INSTRUCTION =
  "Communicate as a recruiting product, using role and candidate names, business steps, meaningful source links and named files. Internal routing identifiers belong only in tool arguments and internal state: do not display task, run, artifact, shard, connection or effect IDs, hashes, cursors, raw request JSON or tool names in user replies, questions or progress. Resolve continuity from authorized context/history/tools; never ask a recruiter to find or supply those identifiers. In text chat, when a material recruiting decision needs an answer, use an available native question card with its direct answer input instead of only asking in prose. Reuse answered information and avoid duplicating pending questions. Keep exact evidence quotes and genuine approval destinations, content and scope intact. Provider reports remain reports, not original proof. This presentation rule does not change native permissions or authorize an action.";

export type RecruitingContextRun = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  sourceMessageId?: string | null;
};

export type RecruitingContextManifest = {
  version: 1;
  roleId: string;
  roleRevisionId: string;
  roleRevision: number;
  actor: { spaceId: string; userId: string };
  runId: string;
  threadId: string;
  botId: string;
  roleText: string;
  memory: LoadedAgentMemoryContext;
  text: string;
  recallScope: string | null;
  placement: "instructions" | "tool_result" | "steering";
  reason: string;
  sourceMessageId: string | null;
};

export type LoadedRecruitingRunContext = {
  workspace: NonNullable<Awaited<ReturnType<typeof getRecruitingWorkspace>>>;
  text: string;
  contextArtifact: RecruitingArtifactRef;
  manifest: RecruitingContextManifest;
};

export async function loadRecruitingRunContext(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore; events: Pick<ThreadEvents, "notify"> },
  run: RecruitingContextRun,
  memory: LoadedAgentMemoryContext,
  context: AdapterContext,
  options: {
    reason: string;
    sourceMessageId?: string | null;
    recallScope?: string | null;
    placement?: RecruitingContextManifest["placement"];
    redact?: (value: string) => string;
    trustedWorkspace?: LoadedRecruitingRunContext["workspace"];
  },
): Promise<LoadedRecruitingRunContext | undefined> {
  if (
    context.spaceId !== run.spaceId ||
    context.userId !== run.userId ||
    context.botId !== run.botId ||
    context.runId !== run.id
  )
    throw new Error("Recruiting context does not belong to this run");
  const actor: Actor = {
    spaceId: run.spaceId,
    userId: run.userId,
    email: "",
    isDeploymentOwner: false,
  };
  // ponytail: reuse the native role read only; locked adoption below still checks current state.
  const workspace =
    options.trustedWorkspace ??
    (await getRecruitingWorkspace(deps.prisma, actor, { threadId: run.threadId }));
  if (!workspace) return undefined;
  const redact = options.redact ?? ((value: string) => value);
  const roleText = [
    "Current recruiting role follows as data. Use this exact version for qualification. A later current-role context replaces an earlier snapshot; historical assistant text does not change these criteria.",
    "Search filters control retrieval only: brief.searchFilters include/exclude narrow the search and prefer supplies recall hints. They never establish a candidate verdict or replace hard/preferred qualification criteria. Collect source evidence for every criterion, retain discovered candidates with missing evidence as unknown, and keep one-round recall scope separate from persistent filters. Changing persistent filters requires a new role revision.",
    "Use field-level source provenance. Unconfirmed inference is soft and cannot reject a candidate. Resolve only material missing facts or conflicts; reuse answered context and do not impose a question count. Read original artifacts before revising source claims. Scheduling and outbound require their native approvals; opt-out, hold/pass and duplicate blocks take precedence over every exception.",
    "Intake, company/JD research and recovery reads do not require redundant confirmation. Formal calibration requires actual human G0 approval and G1 approval of the JD/deck package, unless the human explicitly deferred S2 after G0. Reconfirm materially revised requirements or JD/deck at the applicable gate. A saved record is not human approval. Outside formal calibration or scale, small-scale exploration or same-task feedback/more results explicitly authorized by the current human request do not require G0/G1; follow the requested scope and usage limits, reuse the same verified provider task for continuation, and avoid technical saved-record confirmation or repeated approvals. Keep unknowns and pending cards; this does not approve requirements, JD/deck, business policies, calibration or scale. Keep human rule changes explicit; never recast changed qualification as round-only scope. G2 approval of the calibration profiles and rule changes is required before scale, even on the same task. These formal calibration/scale gates apply to native MCP too; ordinary continuation does not require saved-workspace research actions.",
    "<recruiting_role>",
    JSON.stringify(
      workspace,
      (_key, value) => (typeof value === "string" ? redact(value) : value),
      2,
    ),
    "</recruiting_role>",
  ].join("\n");
  const recallScope = options.recallScope == null ? null : redact(options.recallScope);
  const text = [
    roleText,
    ...(recallScope
      ? [`Current recall scope (does not change qualification):\n${recallScope}`]
      : []),
    ...(memory.text ? [memory.text] : []),
  ].join("\n\n");
  const proposed: RecruitingContextManifest = {
    version: 1,
    roleId: workspace.role.id,
    roleRevisionId: workspace.revision.id,
    roleRevision: workspace.revision.revision,
    actor: { spaceId: run.spaceId, userId: run.userId },
    runId: run.id,
    threadId: run.threadId,
    botId: run.botId,
    roleText,
    memory,
    text,
    recallScope,
    placement: options.placement ?? "instructions",
    reason: options.reason,
    sourceMessageId: options.sourceMessageId ?? run.sourceMessageId ?? null,
  };
  const fingerprint = contextFingerprint(proposed);
  const name = `recruiting-context-${run.id}-${fingerprint}.json`;
  const bytes = Buffer.from(JSON.stringify(proposed), "utf8");
  const hash = sha256(bytes);
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  // ponytail: retain an unreferenced context upload on failure or retry;
  // ArtifactStore.put may reuse a blob. Delete only when a native exclusive-put/GC contract exists.
  const persisted = await recordRecruitingContextAdoption(deps.prisma, actor, {
    runId: run.id,
    threadId: run.threadId,
    botId: run.botId,
    roleId: workspace.role.id,
    roleRevisionId: workspace.revision.id,
    artifact: {
      name,
      mimeType: "application/json",
      size: bytes.byteLength,
      hash,
      storageKey: stored.id,
      clientNonce: `recruiting-context:${run.id}:${fingerprint}`,
    },
    ...(proposed.sourceMessageId ? { sourceMessageId: proposed.sourceMessageId } : {}),
  });
  let manifest = proposed;
  if (!persisted.created) {
    const existing = await deps.artifacts.get(persisted.artifact.storageKey, context);
    if (sha256(existing) !== persisted.artifact.hash)
      throw new Error("Recruiting context artifact hash does not match its stored version");
    manifest = JSON.parse(Buffer.from(existing).toString("utf8")) as RecruitingContextManifest;
    if (contextFingerprint(manifest) !== fingerprint)
      throw new Error("Recruiting context artifact does not match the adopted context");
  } else {
    await deps.events.notify(persisted.event.threadId, persisted.event.seq);
  }
  return {
    workspace,
    text: manifest.text,
    manifest,
    contextArtifact: { artifactId: persisted.artifact.id, sha256: persisted.artifact.hash },
  };
}

function contextFingerprint(manifest: RecruitingContextManifest): string {
  // Repeated loading preserves the first audit reason/source for the same actual adoption.
  const { reason: _reason, sourceMessageId: _sourceMessageId, ...content } = manifest;
  return sha256(Buffer.from(JSON.stringify(content), "utf8"));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
