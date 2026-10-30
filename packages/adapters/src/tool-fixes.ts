import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * Fixes a bot learned from its own tool calls: a call failed, then a changed call to the same
 * tool worked. They live in the bot's native memory, so the next run starts with them and the
 * same error gets the remembered fix right where it happens.
 */
export const TOOL_FIXES_PATH = "tool-fixes.md";
const MAX_FIXES = 20;
const HEADER =
  "# Tool fixes\n\nLearned automatically: a tool call failed, then a changed call worked. Observed, not verified.\n";
const LINE =
  /^- `([^`]+)` failed with "([^"]*)"; worked after: (.+) \(learned (\d{4}-\d{2}-\d{2})\)$/;
/** Tools whose failures are questions, pauses or memory itself, not something to learn. */
const SKIPPED = new Set([
  "ask_user",
  "request_takeover",
  "read_memory",
  "save_memory",
  "save_shared_memory",
  "remember",
]);

export type ToolFix = { tool: string; error: string; fix: string; at: string };

/** The stable part of an error text: ids, numbers, quotes, links and addresses removed. */
export function errorSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<link>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/(["'`“”‘’]).*?\1/g, "<value>")
    .replace(/["'`“”‘’]/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<id>")
    .replace(/\b(?=\w*\d)[\w-]{12,}\b/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** A value short and plain enough to repeat in memory (an option name, a flag, a number). */
function plainValue(value: unknown): string | undefined {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  if (typeof value === "string" && /^[a-z0-9_:-]{1,32}$/.test(value)) return value;
  return undefined;
}

/** What changed between the failed call and the one that worked, by argument name. */
export function describeFix(failed: Record<string, unknown>, worked: Record<string, unknown>) {
  const changes: string[] = [];
  for (const key of Object.keys(failed)) if (!(key in worked)) changes.push(`removed \`${key}\``);
  for (const [key, value] of Object.entries(worked)) {
    if (key in failed && JSON.stringify(failed[key]) === JSON.stringify(value)) continue;
    const plain = plainValue(value);
    const verb = key in failed ? "changed" : "added";
    changes.push(plain === undefined ? `${verb} \`${key}\`` : `${verb} \`${key}\` to \`${plain}\``);
  }
  return changes.length ? changes.slice(0, 6).join(", ") : "the same call, retried once";
}

export function parseToolFixes(content: string): ToolFix[] {
  return content.split("\n").flatMap((line) => {
    const match = LINE.exec(line.trim());
    return match ? [{ tool: match[1]!, error: match[2]!, fix: match[3]!, at: match[4]! }] : [];
  });
}

export function renderToolFixes(fixes: readonly ToolFix[]): string {
  return `${HEADER}\n${fixes
    .map(
      (fix) =>
        `- \`${fix.tool}\` failed with "${fix.error}"; worked after: ${fix.fix} (learned ${fix.at})`,
    )
    .join("\n")}\n`;
}

/** The list with this fix first, replacing an older fix for the same error; undefined if unchanged. */
export function upsertToolFix(fixes: readonly ToolFix[], fix: ToolFix): ToolFix[] | undefined {
  const same = fixes.find((entry) => entry.tool === fix.tool && entry.error === fix.error);
  if (same && same.fix === fix.fix && same.at === fix.at) return undefined;
  return [fix, ...fixes.filter((entry) => entry !== same)].slice(0, MAX_FIXES);
}

export function knownFixNote(fix: ToolFix): string {
  return `This error happened before with ${fix.tool}. What worked then: ${fix.fix}. Do that now and continue; do not stop or report the error.`;
}

/** The failed result with the remembered fix beside the error, in the shape the model reads. */
export function withKnownFix(result: unknown, note: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const object = result as Record<string, unknown>;
  if (object.kind === "agent_tool_result" && Array.isArray(object.content))
    return { ...object, content: [...object.content, { type: "text", text: note }] };
  return { ...object, knownFix: note };
}

type FailedCall = { signature: string; args: Record<string, unknown> };

/**
 * One run's view of the bot's tool fixes. A failure returns the remembered fix for it, if any;
 * a later success of the same tool records what changed. Memory errors never reach the tool call.
 */
export function createToolFixMemory(input: {
  memory: Pick<MemoryStore, "read" | "commit">;
  context: AdapterContext;
  botId: string;
  runId: string;
  threadId: string;
  now?: () => Date;
}) {
  const failures = new Map<string, FailedCall>();
  let loaded: Promise<{ fixes: ToolFix[]; revision: number }> | undefined;
  const read = async () => {
    const snapshot = await input.memory.read(
      { scope: "bot", botId: input.botId, path: TOOL_FIXES_PATH },
      input.context,
    );
    const document = snapshot.documents[0];
    return { fixes: parseToolFixes(document?.content ?? ""), revision: document?.revision ?? 0 };
  };
  const load = () => {
    loaded ??= read().catch((error) => {
      getLogger().warn("tool.fix.read_failed", { runId: input.runId, error: String(error) });
      return { fixes: [], revision: 0 };
    });
    return loaded;
  };
  const save = async (fix: ToolFix) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = attempt === 0 ? await load() : await read();
      const next = upsertToolFix(current.fixes, fix);
      if (!next) return;
      try {
        const saved = await input.memory.commit(
          {
            scope: "bot",
            botId: input.botId,
            path: TOOL_FIXES_PATH,
            content: renderToolFixes(next),
            expectedRevision: current.revision,
            sourceRunId: input.runId,
            sourceThreadId: input.threadId,
          },
          input.context,
        );
        loaded = Promise.resolve({ fixes: next, revision: saved.revision });
        return;
      } catch (error) {
        if (error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR) continue;
        throw error;
      }
    }
  };
  return {
    /** Remember the failure and return the note for a fix that worked before, if one did. */
    async failed(tool: string, args: Record<string, unknown>, errorText: string) {
      if (SKIPPED.has(tool) || !errorText.trim()) return undefined;
      const signature = errorSignature(errorText);
      if (!signature) return undefined;
      failures.set(tool, { signature, args });
      const known = (await load()).fixes.find(
        (fix) => fix.tool === tool && fix.error === signature,
      );
      if (known) getLogger().info("tool.fix.reused", { runId: input.runId, tool });
      return known ? knownFixNote(known) : undefined;
    },
    /** A success right after a failure of the same tool is the fix; save what changed. */
    async succeeded(tool: string, args: Record<string, unknown>) {
      const failure = failures.get(tool);
      if (!failure) return;
      failures.delete(tool);
      const fix: ToolFix = {
        tool,
        error: failure.signature,
        fix: describeFix(failure.args, args),
        at: (input.now?.() ?? new Date()).toISOString().slice(0, 10),
      };
      await save(fix).then(
        () => getLogger().info("tool.fix.learned", { runId: input.runId, tool }),
        (error) =>
          getLogger().warn("tool.fix.save_failed", { runId: input.runId, error: String(error) }),
      );
    },
  };
}
