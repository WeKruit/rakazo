import type { Actor } from "@rakazo/contracts";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { readRecruitingAnalytics, readRecruitingAnalyticsPeople } from "./recruiting-analytics.js";

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
    CREATE TEMP TABLE recruiting_crm_contacts (id text, "userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmCandidateId" text, "identityKey" text, "archivedAt" timestamp, name text, email text, "linkedinUrl" text);
    CREATE TEMP TABLE recruiting_candidate_occurrences ("candidateKey" text, "roleId" text, name text, "pageId" text, "rowIndex" int);
    CREATE TEMP TABLE recruiting_crm_messages ("userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmCandidateId" text, "crmRoleId" text, direction text, "sentAt" timestamp);
    INSERT INTO threads VALUES ('t1','g1'),('t2','g2');
    INSERT INTO recruiting_roles VALUES ('r1','One','t1','u','s',NULL),('r2','Two','t2','u','s',NULL),('foreign','Other','t1','other','s',NULL);
    INSERT INTO recruiting_candidates VALUES ('r1','linkedin:/in/a',true,'2026-10-02'),('r2','linkedin:/in/a',true,'2026-10-03'),('r1','unknown',true,NULL),('foreign','private',true,'2026-10-02');
    INSERT INTO recruiting_crm_workspace_attachments VALUES ('r1','u','s','m','o','cr1'),('r2','u','s','m','o','cr2');
    INSERT INTO recruiting_crm_contacts (id,"userId","spaceId","mcpServerId","organizationId","crmCandidateId","identityKey","archivedAt") VALUES ('a','u','s','m','o','ca','li:linkedin.com/in/a',NULL),('b','u','s','m','o','cb','li:linkedin.com/in/b',NULL);
    UPDATE recruiting_crm_contacts SET name='Avery Example',email='avery@example.test',"linkedinUrl"='https://www.linkedin.com/in/a' WHERE id='a';
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
    expect(result.trend).toEqual([{ date: "2026-10-02", contacted: 1, replied: 1 }]);
    expect(result.groups).toEqual([
      { roleId: "r1", title: "One", contacted: 1, replied: 1 },
      { roleId: "r2", title: "Two", contacted: 1, replied: 0 },
    ]);
    expect(result.groups.reduce((total, row) => total + (row.contacted ?? 0), 0)).toBe(2);
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

it.skipIf(!url)(
  "drills into the exact deduplicated contacted/replied/shortlist cohorts with bounded cursor pages",
  async () => {
    const contacted = await readRecruitingAnalyticsPeople(prisma, actor, {
      ...window,
      metric: "contacted",
      limit: 1,
    });
    expect(contacted.total).toBe(1);
    expect(contacted.items[0]?.name).toBe("Avery Example");
    expect(contacted.items[0]?.roles.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(contacted.items[0]?.repliedAt).toBe("2026-11-04T00:00:00.000Z");
    const replies = await readRecruitingAnalyticsPeople(prisma, actor, {
      ...window,
      metric: "replied",
      limit: 1,
    });
    expect(replies.items).toEqual(contacted.items);
    const shortlisted = await readRecruitingAnalyticsPeople(prisma, actor, {
      ...window,
      metric: "shortlisted",
      limit: 1,
    });
    expect(shortlisted.total).toBe(1);
    const next = await readRecruitingAnalyticsPeople(prisma, actor, {
      ...window,
      metric: "contacted",
      limit: 1,
      cursor: contacted.items[0]!.key,
    });
    expect(next.items).toEqual([]);
    const foreign = await readRecruitingAnalyticsPeople(prisma, actor, {
      ...window,
      metric: "contacted",
      limit: 1,
      roleId: "foreign",
    });
    expect(foreign.total).toBe(0);
    expect(foreign.items).toEqual([]);
  },
);
