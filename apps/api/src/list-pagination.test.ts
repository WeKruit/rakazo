import {
  ARRAY_LIST_RPC_PATHS,
  DATABASE_PAGED_LIST_RPC_PATHS,
  STRUCTURED_LIST_RPC_FIELDS,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { paginateListOutput } from "./list-pagination.js";

const rows = Array.from({ length: 1000 }, (_, id) => ({ id }));

describe("list response pagination", () => {
  it.each(
    ARRAY_LIST_RPC_PATHS.filter(
      (path) => !(DATABASE_PAGED_LIST_RPC_PATHS as readonly string[]).includes(path),
    ),
  )("pages %s without modifying source or input", (path) => {
    const input = Object.freeze({ offset: 400, botId: "fixture" });
    const source = Object.freeze([...rows]);
    expect(paginateListOutput(path.split("/"), undefined, source)).toEqual(rows.slice(0, 200));
    expect(paginateListOutput(path.split("/"), input, source)).toEqual(rows.slice(400, 600));
    expect(paginateListOutput(path.split("/"), { offset: 1000 }, source)).toEqual([]);
    expect(source).toHaveLength(1000);
    expect(input).toEqual({ offset: 400, botId: "fixture" });
  });

  it.each(
    Object.entries(STRUCTURED_LIST_RPC_FIELDS).filter(
      ([path]) => !(DATABASE_PAGED_LIST_RPC_PATHS as readonly string[]).includes(path),
    ),
  )("pages %s fields while retaining metadata", (path, fields) => {
    const source = Object.freeze({
      ...Object.fromEntries(fields.map((field) => [field, rows])),
      total: 1000,
    });
    const page = paginateListOutput(path.split("/"), { offset: 900 }, source);
    expect(page).toEqual({
      ...Object.fromEntries(fields.map((field) => [field, rows.slice(900)])),
      total: 1000,
    });
    expect(paginateListOutput(path.split("/"), { offset: 1000 }, source)).toEqual({
      ...Object.fromEntries(fields.map((field) => [field, []])),
      total: 1000,
    });
    for (const field of fields) expect(source[field as keyof typeof source]).toHaveLength(1000);
  });

  it.each(DATABASE_PAGED_LIST_RPC_PATHS)("does not slice already-paged %s twice", (path) => {
    const page = rows.slice(400, 600);
    expect(paginateListOutput(path.split("/"), { offset: 400 }, page)).toBe(page);
  });

  it.each([
    "mcp/assignments/replace",
    "voice/prepare",
    "bots/list",
    "groups/list",
    "usage/list",
    "computer/commands",
    "unknown/list",
  ])("preserves non-whitelisted %s", (path) => {
    expect(paginateListOutput(path.split("/"), { offset: 200 }, rows)).toBe(rows);
  });

  it.each([-1, 1.5, NaN, Infinity, "200", null])("defaults invalid offset %s to zero", (offset) => {
    expect(paginateListOutput(["models", "list"], { offset }, rows)).toEqual(rows.slice(0, 200));
  });

  it("preserves unexpected non-list values", () => {
    expect(paginateListOutput(["models", "list"], {}, null)).toBeNull();
    expect(paginateListOutput(["runs", "list"], {}, null)).toBeNull();
    expect(paginateListOutput(["runs", "list"], {}, { runs: null })).toEqual({ runs: null });
  });
});
