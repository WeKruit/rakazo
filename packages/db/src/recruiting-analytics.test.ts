import type { Actor } from "@rakazo/contracts";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { readRecruitingAnalytics } from "./recruiting-analytics.js";

const url = process.env.ANALYTICS_TEST_DATABASE_URL;
const actor: Actor = {
  userId: "u",
  spaceId: "s",
  email: "u@example.test",
  isDeploymentOwner: false,
};
const window = { since: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" };
let db: Client;
let prisma: PrismaClient;
beforeAll(async () => {
  if (!url) return;
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query(`
    CREATE TEMP TABLE recruiting_roles (id text, title text, "sourceThreadId" text, "userId" text, "spaceId" text, "archivedAt" timestamp);
    CREATE TEMP TABLE threads (id text, "groupId" text);
    CREATE TEMP TABLE chat_groups (id text, "archivedAt" timestamp);
    CREATE TEMP TABLE recruiting_candidates ("roleId" text, "candidateKey" text, shortlisted boolean, "shortlistedAt" timestamp);
    CREATE TEMP TABLE recruiting_crm_workspace_attachments ("roleId" text, "userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmRoleId" text);
    CREATE TEMP TABLE recruiting_crm_contacts (id text, "userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmCandidateId" text, "identityKey" text, "archivedAt" timestamp);
    CREATE TEMP TABLE recruiting_crm_messages ("userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmCandidateId" text, "crmRoleId" text, direction text, "sentAt" timestamp);
    INSERT INTO threads VALUES ('t1','g1'),('t2','g2');
    INSERT INTO recruiting_roles VALUES ('r1','One','t1','u','s',NULL),('r2','Two','t2','u','s',NULL),('foreign','Other','t1','other','s',NULL);
    INSERT INTO recruiting_candidates VALUES ('r1','linkedin:/in/a',true,'2026-10-02'),('r2','linkedin:/in/a',true,'2026-10-03'),('r1','unknown',true,NULL),('foreign','private',true,'2026-10-02');
    INSERT INTO recruiting_crm_workspace_attachments VALUES ('r1','u','s','m','o','cr1'),('r2','u','s','m','o','cr2');
    INSERT INTO recruiting_crm_contacts VALUES ('a','u','s','m','o','ca','li:linkedin.com/in/a',NULL),('b','u','s','m','o','cb','li:linkedin.com/in/b',NULL);
    INSERT INTO recruiting_crm_messages VALUES
      ('u','s','m','o','ca','cr1','sent','2026-10-02'),
      ('u','s','m','o','ca','cr2','sent','2026-10-03'),
      ('u','s','m','o','ca','cr1','received','2026-11-04'),
      ('u','s','m','o','cb','cr1','sent','2026-09-01'),
      ('u','s','m','o','cb','cr1','received','2026-10-05');
  `);
  prisma = {
    $queryRaw: async (sql: { text: string; values: unknown[] }) =>
      (await db.query(sql.text, sql.values)).rows,
  } as unknown as PrismaClient;
});
afterAll(async () => {
  if (db) await db.end();
});

it.skipIf(!url)(
  "deduplicates people across roles and attributes later replies to the observed send cohort",
  async () => {
    const result = await readRecruitingAnalytics(prisma, actor, window);
    expect(result.observedShortlistedPeople).toBe(1);
    expect(result.shortlistDateUnknownPeople).toBe(1);
    expect(result.observedContactedPeople).toBe(1);
    expect(result.observedRepliedPeople).toBe(1);
    expect(result.roles).toHaveLength(2);
    expect(result.firstContactedPeople).toBeNull();
    expect(result.replyRate).toBeNull();
    const role = await readRecruitingAnalytics(prisma, actor, {
      ...window,
      roleId: "r2",
    });
    expect(role.observedShortlistedPeople).toBe(1);
    expect(role.observedRepliedPeople).toBe(0);
  },
);
it.skipIf(!url)("keeps incomplete history and zero denominators unknown", async () => {
  const result = await readRecruitingAnalytics(prisma, actor, {
    since: "2027-01-01T00:00:00Z",
    until: "2027-02-01T00:00:00Z",
  });
  expect(result.observedContactedPeople).toBe(0);
  expect(result.replyRate).toBeNull();
  expect(result.coverage).toBe("partial");
});

it.skipIf(!url)(
  "returns unknown mail coverage for an unowned scope, never another owner's counts",
  async () => {
    const result = await readRecruitingAnalytics(prisma, actor, {
      ...window,
      roleId: "foreign",
    });
    expect(result.observedShortlistedPeople).toBe(0);
    expect(result.observedContactedPeople).toBeNull();
    expect(result.observedRepliedPeople).toBeNull();
    expect(result.sources.storedCrmMessages).toBe("unavailable");
  },
);
