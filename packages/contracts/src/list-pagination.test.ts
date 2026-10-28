import { describe, expect, it } from "vitest";
import type { ZodObject, ZodType } from "zod";
import { ARRAY_LIST_RPC_PATHS, STRUCTURED_LIST_RPC_FIELDS } from "./list-pagination.js";
import { appContract } from "./rpc.js";

function inputAt(path: string): ZodType {
  let node: unknown = appContract;
  for (const part of path.split("/")) node = (node as Record<string, unknown>)[part];
  return (node as { "~orpc": { inputSchema: ZodType } })["~orpc"].inputSchema;
}

describe("list continuation contracts", () => {
  it.each([...ARRAY_LIST_RPC_PATHS, ...Object.keys(STRUCTURED_LIST_RPC_FIELDS)])(
    "%s retains the offset instead of stripping it before the server paginator",
    (path) => {
      let schema = inputAt(path);
      while ("unwrap" in schema) schema = (schema as ZodType & { unwrap(): ZodType }).unwrap();
      const offset = (schema as ZodObject).shape.offset;
      expect(offset).toBeDefined();
      expect(offset.safeParse(200).success).toBe(true);
      expect(offset.safeParse(-1).success).toBe(false);
      expect(offset.safeParse(0.5).success).toBe(false);
    },
  );
});
