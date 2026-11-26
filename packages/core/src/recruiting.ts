import type {
  RecruitingArtifactRef,
  RecruitingPreferenceFeedbackInput,
  RecruitingResearchAction,
  RecruitingResearchTask,
} from "@rakazo/contracts";
import { RecruitingResearchReadArtifactSchema } from "@rakazo/contracts";

export async function verifyRecruitingArtifactBytes(bytes: Uint8Array, expectedSha256: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== expectedSha256) throw new Error("Recruiting artifact does not match its source");
}

/** Select an own string field from retained JSON bytes, never object/prototype traversal. */
export function readRecruitingJsonString(bytes: Uint8Array, path: readonly (string | number)[]) {
  let value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  for (const key of path) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      value === null ||
      typeof value !== "object" ||
      (typeof key === "number" ? !Array.isArray(value) : Array.isArray(value)) ||
      !Object.hasOwn(value, key)
    )
      throw new Error("Material path does not select a string");
    value = (value as Record<string | number, unknown>)[key];
  }
  if (typeof value !== "string") throw new Error("Material path does not select a string");
  return value;
}

/** The same exact UTF-16 selection is used for persistence and source display. */
export function validateRecruitingTextSelection(
  text: string,
  start: number,
  end: number,
  quote: string,
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    splitsSurrogatePair(text, start) ||
    splitsSurrogatePair(text, end) ||
    text.slice(start, end) !== quote
  )
    throw new Error("Material selection does not match its source");
}

/** Read an exact native report snapshot; the caller obtains its references through authorized API reads. */
export async function readRecruitingResearchReadArtifact(
  bytes: Uint8Array,
  expected: {
    task: Pick<RecruitingResearchTask, "id" | "providerTaskId">;
    action: Pick<RecruitingResearchAction, "id" | "taskId" | "outputArtifacts">;
    artifact: RecruitingArtifactRef;
  },
) {
  const { task, action, artifact } = expected;
  await verifyRecruitingArtifactBytes(bytes, artifact.sha256);
  if (
    action.taskId !== task.id ||
    !action.outputArtifacts.some(
      (ref) => ref.artifactId === artifact.artifactId && ref.sha256 === artifact.sha256,
    )
  )
    throw new Error("Recruiting result snapshot does not match its source");
  const snapshot = RecruitingResearchReadArtifactSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    snapshot.taskId !== task.id ||
    snapshot.actionId !== action.id ||
    !task.providerTaskId ||
    snapshot.request.task_id !== task.providerTaskId ||
    snapshot.observation.providerTaskId !== task.providerTaskId
  )
    throw new Error("Recruiting result snapshot does not match its source");
  return snapshot;
}

/** A preference document without runs of blank lines or trailing whitespace. */
export function tidyPreferenceDocument(content: string): string {
  return content
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function applyRecruitingPreferenceEdit(
  content: string,
  preference: RecruitingPreferenceFeedbackInput,
): {
  content: string;
  previousAnchor: { start: number; end: number; quote: string } | null;
  anchor: { start: number; end: number; quote: string } | null;
} {
  if (preference.operation === "add") {
    // A preference saved again keeps its one line, and blank lines left by earlier removals collapse.
    const base = tidyPreferenceDocument(content);
    const existing = base.indexOf(preference.content.trim());
    if (preference.content.trim() && existing >= 0) {
      const quote = preference.content.trim();
      const anchor = { start: existing, end: existing + quote.length, quote };
      return { content: base, previousAnchor: anchor, anchor };
    }
    const prefix = base ? `${base}\n\n` : "";
    return {
      content: prefix + preference.content,
      previousAnchor: null,
      anchor: {
        start: prefix.length,
        end: prefix.length + preference.content.length,
        quote: preference.content,
      },
    };
  }
  let anchor = preference.anchor;
  if (!("start" in anchor)) {
    if ("end" in anchor)
      throw new Error("Preference anchor does not match the loaded memory revision");
    const start = content.indexOf(anchor.quote);
    if (start < 0)
      throw new Error(
        "Preference anchor quote was not found in the loaded memory revision; reload the document and use an exact quote",
      );
    if (content.indexOf(anchor.quote, start + 1) !== -1)
      throw new Error(
        "Preference anchor quote occurs more than once in the loaded memory revision; provide exact UTF-16 start and end offsets",
      );
    anchor = { start, end: start + anchor.quote.length, quote: anchor.quote };
  }
  const { start, end, quote } = anchor;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    content.slice(start, end) !== quote ||
    splitsSurrogatePair(content, start) ||
    splitsSurrogatePair(content, end)
  )
    throw new Error("Preference anchor does not match the loaded memory revision");
  const replacement = preference.operation === "replace" ? preference.content : "";
  return {
    content: content.slice(0, start) + replacement + content.slice(end),
    previousAnchor: { start, end, quote },
    anchor: replacement ? { start, end: start + replacement.length, quote: replacement } : null,
  };
}

function splitsSurrogatePair(content: string, index: number): boolean {
  const before = content.charCodeAt(index - 1);
  const after = content.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
