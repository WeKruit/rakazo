import {
  ARRAY_LIST_RPC_PATHS,
  DATABASE_PAGED_LIST_RPC_PATHS,
  STRUCTURED_LIST_RPC_FIELDS,
} from "@rakazo/contracts";

const arrayPaths: ReadonlySet<string> = new Set(ARRAY_LIST_RPC_PATHS);
const databasePaths: ReadonlySet<string> = new Set(DATABASE_PAGED_LIST_RPC_PATHS);
const PAGE_SIZE = 200;

/** Page only explicitly listed read results; never modify mutation receipts. */
export function paginateListOutput(
  path: readonly string[],
  input: unknown,
  output: unknown,
): unknown {
  const key = path.join("/");
  if (databasePaths.has(key)) return output;
  const value = input && typeof input === "object" && "offset" in input ? input.offset : 0;
  const offset = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (arrayPaths.has(key)) {
    return Array.isArray(output) ? output.slice(offset, offset + PAGE_SIZE) : output;
  }
  const fields = Object.hasOwn(STRUCTURED_LIST_RPC_FIELDS, key)
    ? STRUCTURED_LIST_RPC_FIELDS[key]
    : undefined;
  if (!fields || !output || typeof output !== "object" || Array.isArray(output)) return output;
  const page: Record<string, unknown> = { ...output };
  for (const field of fields) {
    const rows = page[field];
    if (Array.isArray(rows)) page[field] = rows.slice(offset, offset + PAGE_SIZE);
  }
  return page;
}
