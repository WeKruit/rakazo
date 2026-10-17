import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { readActorArtifact } from "@rakazo/adapters";
import type {
  Actor,
  ReadRecruitingSourceInput,
  RecruitingAssessmentSourceRef,
  RecruitingSourceRef,
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
      return { text, start, end };
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
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidates>[2],
) => authenticated(() => recruiting.listRecruitingCandidates(prisma, actor, input));
export const listRecruitingCandidateSources = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidateSources>[2],
) => authenticated(() => recruiting.listRecruitingCandidateSources(prisma, actor, input));
export const setRecruitingCandidateShortlist = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.setRecruitingCandidateShortlist>[2],
) => authenticated(() => recruiting.setRecruitingCandidateShortlist(prisma, actor, input));
