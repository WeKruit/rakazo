import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");

// Published before committed events were treated as immutable. Never extend this list: a new
// event shape is read by new code (bump EVENT_FORMAT_VERSION), old rows stay as they were.
const REWROTE_EVENTS_BEFORE_RULE = new Set(["20260901120000_messaging_surface"]);

const REWRITES_EVENTS =
  /\b(?:UPDATE\s+"?events"?\s|DELETE\s+FROM\s+"?events"?\b|TRUNCATE\s+(?:TABLE\s+)?"?events"?\b|ALTER\s+TABLE\s+"?events"?\s+(?:DROP\s+COLUMN|ALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE))/i;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("migrations", () => {
  it("never rewrite committed events", () => {
    const offenders = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !REWROTE_EVENTS_BEFORE_RULE.has(entry.name))
      .filter((entry) => {
        const sql = readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8");
        return REWRITES_EVENTS.test(stripComments(sql));
      })
      .map((entry) => entry.name);
    expect(offenders).toEqual([]);
  });

  it("recognize an event rewrite", () => {
    expect(REWRITES_EVENTS.test(`UPDATE "events" SET "payload" = '{}'`)).toBe(true);
    expect(REWRITES_EVENTS.test(`DELETE FROM events WHERE true`)).toBe(true);
    expect(REWRITES_EVENTS.test(`ALTER TABLE "events" ALTER COLUMN "payload" TYPE TEXT`)).toBe(
      true,
    );
    expect(REWRITES_EVENTS.test(`ALTER TABLE "events" ADD COLUMN "v" INTEGER`)).toBe(false);
    expect(
      REWRITES_EVENTS.test(`REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
    ).toBe(false);
  });
});
