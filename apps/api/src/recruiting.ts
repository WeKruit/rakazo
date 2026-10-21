import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  createRecruitingCandidateReportReader,
  isRecruitingCandidateReportField,
  readActorArtifact,
} from "@rakazo/adapters";
import type {
  Actor,
  ReadRecruitingSourceInput,
  RecruitingAssessmentSourceRef,
  RecruitingCandidateSource,
  RecruitingSourceRef,
  RecruitingSourceSelection,
} from "@rakazo/contracts";
import {
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type { PrismaClient, RecruitingRoleMaterialContext } from "@rakazo/db";
import * as recruiting from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import type { ParseError } from "jsonc-parser";
import { findNodeAtLocation, parseTree } from "jsonc-parser";

async function authenticated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IsolationError)
      throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
    if (error instanceof RecruitingConflictError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof RecruitingPlaybookValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof RecruitingSourceValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof Error && error.name === "ZodError")
      throw new ORPCError("BAD_REQUEST", { message: "Invalid recruiting input" });
    throw error;
  }
}

type RecruitingReadDeps = { prisma: PrismaClient; artifacts: ArtifactStore };

/** Bind exact UTF-16 quotes in MCP array text to one canonical saved person. */
function selectedProviderRow(
  bytes: Uint8Array,
  text: string,
  selection: RecruitingSourceSelection | undefined,
) {
  if (selection?.kind !== "artifact_json_string") throw new IsolationError();
  const { path, start, end } = selection;
  const rowPaths = [
    ["providerResult", "structuredContent", "rows"],
    ["observation", "rows"],
  ];
  const rowPath = rowPaths.find((prefix) => prefix.every((key, index) => path[index] === key));
  if (rowPath) {
    const rowIndex = path[rowPath.length];
    if (typeof rowIndex !== "number" || !Number.isSafeInteger(rowIndex) || rowIndex < 0)
      throw new IsolationError();
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(original);
    const node = findNodeAtLocation(parseTree(original)!, [...rowPath, rowIndex]);
    if (node?.type !== "object") throw new IsolationError();
    return {
      rowIndex,
      row: JSON.parse(original.slice(node.offset, node.offset + node.length)) as Record<
        string,
        unknown
      >,
    };
  }
  if (
    path.length !== 4 ||
    path[0] !== "providerResult" ||
    path[1] !== "content" ||
    typeof path[2] !== "number" ||
    path[3] !== "text"
  )
    throw new IsolationError();
  JSON.parse(text);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const rows = root?.type === "array" ? root : root && findNodeAtLocation(root, ["rows"]);
  if (errors.length || rows?.type !== "array" || !rows.children) throw new IsolationError();
  const overlapping = rows.children.filter(
    (node) => start < node.offset + node.length && end > node.offset,
  );
  const node = overlapping[0];
  if (overlapping.length !== 1 || !node || node.type !== "object") throw new IsolationError();
  const surrounding =
    text.slice(start, Math.min(end, node.offset)) +
    text.slice(Math.max(start, node.offset + node.length), end);
  if (!/^[\s[\],]*$/.test(surrounding)) throw new IsolationError();
  return {
    rowIndex: rows.children.indexOf(node),
    row: JSON.parse(text.slice(node.offset, node.offset + node.length)) as Record<string, unknown>,
  };
}

function sameReportedRow(selected: Record<string, unknown>, canonical: unknown) {
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return false;
  const value = (cell: unknown) =>
    cell && typeof cell === "object" && !Array.isArray(cell) && Object.hasOwn(cell, "value")
      ? (cell as { value: unknown }).value
      : cell;
  const keys = Object.keys(selected).filter(isRecruitingCandidateReportField);
  return (
    keys.length > 0 &&
    keys.length === Object.keys(canonical).filter(isRecruitingCandidateReportField).length &&
    keys.every(
      (key) =>
        Object.hasOwn(canonical, key) &&
        isDeepStrictEqual(value(selected[key]), value((canonical as Record<string, unknown>)[key])),
    )
  );
}

export const readRecruitingSource = (
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  input: ReadRecruitingSourceInput,
) =>
  authenticated(async () => {
    let sources: readonly (RecruitingSourceRef | RecruitingAssessmentSourceRef)[];
    if (input.kind === "role") {
      const workspace = await recruiting.getRecruitingWorkspace(deps.prisma, actor, {
        threadId: input.threadId,
      });
      if (!workspace || workspace.revision.id !== input.roleRevisionId) throw new IsolationError();
      sources = [
        ...workspace.revision.sourceRefs,
        ...workspace.revision.criteria.flatMap((criterion) => criterion.sourceRefs),
      ];
    } else {
      const snapshot = await recruiting.getRecruitingAssessment(deps.prisma, actor, {
        roleId: input.roleId,
        candidateKey: input.candidateKey,
        version: input.version,
      });
      if (!snapshot || snapshot.assessment.version !== input.version) throw new IsolationError();
      sources = snapshot.assessment.sourceRefs;
    }
    const matches = sources.filter((source) => source.id === input.sourceRefId);
    const source = matches[0];
    if (
      !source ||
      matches.some((value) => !isDeepStrictEqual(value, source)) ||
      source.readState !== "read" ||
      !source.quote ||
      source.anchor.kind !== "artifact"
    )
      throw new IsolationError();
    try {
      const { row, bytes } = await readActorArtifact(deps, actor, {
        artifactId: source.anchor.artifact.artifactId,
      });
      if (row.hash !== source.anchor.artifact.sha256) throw new IsolationError();
      const selection = "selection" in source ? source.selection : undefined;
      // ponytail: role sources attest only extracted text; other strings require the stored typed path.
      if (selection?.kind === "message_text" || (!selection && source.anchor.locator !== "text"))
        throw new IsolationError();
      const json = row.mimeType === "application/json" || row.mimeType.endsWith("+json");
      const pdf = row.mimeType === "application/pdf";
      const path =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (path ? !json : (!row.mimeType.startsWith("text/") && !pdf) || json)
        throw new IsolationError();
      const text = path
        ? readRecruitingJsonString(bytes, path)
        : pdf
          ? await extractPdfText(bytes)
          : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const start = selection?.start ?? text.indexOf(source.quote);
      const end = selection?.end ?? start + source.quote.length;
      validateRecruitingTextSelection(text, start, end, source.quote);
      if (input.kind === "assessment" && source.kind === "provider_report" && json) {
        const selected = selectedProviderRow(bytes, text, selection);
        const readReport = createRecruitingCandidateReportReader(deps, actor, input.roleId, {
          artifacts: new Map([[row.id, { row, bytes }]]),
        });
        // ponytail: use existing occurrence pagination; add an artifact selector only if histories grow large.
        const matches: RecruitingCandidateSource[] = [];
        let cursor: string | undefined;
        do {
          const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, {
            roleId: input.roleId,
            candidateKey: input.candidateKey,
            ...(cursor ? { cursor } : {}),
          });
          matches.push(
            ...page.items.filter(
              (item) =>
                item.artifactRef.artifactId === row.id &&
                item.artifactRef.sha256 === row.hash &&
                item.rowIndex === selected.rowIndex,
            ),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (matches.length !== 1) throw new IsolationError();
        const retained = await readReport(matches[0]!);
        if (!sameReportedRow(selected.row, retained.row)) throw new IsolationError();
        return { kind: "report" as const, report: retained.report };
      }
      return { kind: "text" as const, text, start, end };
    } catch {
      throw new IsolationError();
    }
  });

export const createRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.createRecruitingRole(prisma, actor, input, material));
export const bindRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.bindRecruitingRole>[2],
) => authenticated(() => recruiting.bindRecruitingRole(prisma, actor, input));
export const getRecruitingWorkspace = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingWorkspace>[2],
) => authenticated(() => recruiting.getRecruitingWorkspace(prisma, actor, input));
export const reviseRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.reviseRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.reviseRecruitingRole(prisma, actor, input, material));
export const listRecruitingAssessments = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingAssessments>[2],
) => authenticated(() => recruiting.listRecruitingAssessments(prisma, actor, input));
export const listRecruitingFeedback = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingFeedback>[2],
) => authenticated(() => recruiting.listRecruitingFeedback(prisma, actor, input));
export const getRecruitingAssessment = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingAssessment>[2],
) => authenticated(() => recruiting.getRecruitingAssessment(prisma, actor, input));
export const listRecruitingResearch = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingResearch>[2],
) => authenticated(() => recruiting.listRecruitingResearch(prisma, actor, input));

export const listRecruitingQuestions = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingQuestions>[2],
) =>
  authenticated(async () => ({
    questions: await recruiting.listRecruitingQuestions(prisma, actor, input),
  }));

export const confirmRecruitingBrief = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.confirmRecruitingBrief>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.confirmRecruitingBrief(prisma, actor, input, material));

export const editRecruitingCriteria = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.editRecruitingCriteria>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.editRecruitingCriteria(prisma, actor, input, material));

export const listRecruitingCandidates = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidates>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidates(deps.prisma, actor, input);
    const readReport = createRecruitingCandidateReportReader(deps, actor, input.roleId);
    for (const candidate of page.items) {
      if (!candidate.latestSource) continue;
      const { report: _report, ...metadata } = candidate.latestSource;
      try {
        candidate.latestSource = { ...metadata, report: (await readReport(metadata)).report };
      } catch {
        // Authorized provenance remains readable when its report bytes are unavailable.
        candidate.latestSource = metadata;
      }
    }
    return page;
  });
export const listRecruitingCandidateSources = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidateSources>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, input);
    const readReport = createRecruitingCandidateReportReader(deps, actor, input.roleId);
    const items: RecruitingCandidateSource[] = [];
    for (const source of page.items) {
      const { report: _report, ...metadata } = source;
      try {
        items.push({ ...metadata, report: (await readReport(source)).report });
      } catch {
        // Authorized provenance remains readable when its report bytes are unavailable.
        items.push(metadata);
      }
    }
    return { ...page, items };
  });
export const setRecruitingCandidateShortlist = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.setRecruitingCandidateShortlist>[2],
) => authenticated(() => recruiting.setRecruitingCandidateShortlist(prisma, actor, input));
