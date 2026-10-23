import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

export type MemoryEdit = { find: string; replace: string };

export function nativeMemorySaveError(args: Record<string, unknown>): string | undefined {
  if (args.edit !== undefined) {
    const edit = args.edit as Partial<MemoryEdit> | null;
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return "edit must be an object";
    if (typeof edit.find !== "string" || !edit.find) return "edit.find must be a non-empty string";
    if (typeof edit.replace !== "string") return "edit.replace must be a string";
    if (args.content !== undefined) return "use either content or edit, not both";
    if (args.recruitingFeedback !== undefined)
      return "edit cannot be combined with recruitingFeedback";
  } else if (typeof args.content !== "string") return "content must be a string";
  if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) {
    return "path is required";
  }
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) {
    return "expectedRevision must be a nonnegative integer";
  }
  return undefined;
}

/**
 * Merge a partial edit into the loaded document. The caller commits the result with the
 * revision it read, so a stale read is still rejected by the store. Errors never echo
 * document text.
 */
export function applyMemoryEdit(
  content: string,
  edit: MemoryEdit,
): { content: string } | { error: string } {
  const first = content.indexOf(edit.find);
  if (first < 0)
    return {
      error:
        "edit.find was not found in the current document. Read it with read_memory and use its exact text.",
    };
  if (content.indexOf(edit.find, first + edit.find.length) >= 0)
    return {
      error:
        "edit.find matches more than one place. Include more surrounding text so it matches exactly once.",
    };
  return {
    content: content.slice(0, first) + edit.replace + content.slice(first + edit.find.length),
  };
}

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}
