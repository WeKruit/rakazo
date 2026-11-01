import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCompanySiteResolver } from "./company-site.js";
import { createPrismaOrganizationLogoStore } from "./organization-logos.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const ICON = "data:image/png;base64,AAAA";

describePostgres("organization logos (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const club = `Logo Club ${suffix}`;
  const unknown = `Unknown Org ${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(() => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await prisma.organizationLogo.deleteMany({ where: { key: { contains: suffix } } });
    await close();
  });

  it("looks each organization up once for every process, misses included", async () => {
    const store = createPrismaOrganizationLogoStore(prisma);
    const resolveHostname = async () => [{ address: "203.0.113.10", family: 4 as const }];
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const first = createCompanySiteResolver({ store, fetch, resolveHostname });
    await expect(first.companySite(unknown)).resolves.toEqual({ host: null });
    const looked = fetch.mock.calls.length;
    expect(looked).toBeGreaterThan(0);

    // A fresh process (after a deploy) reads the saved miss instead of looking it up again.
    const afterDeploy = vi.fn(async () => new Response("", { status: 404 }));
    const fresh = createCompanySiteResolver({ store, fetch: afterDeploy, resolveHostname });
    await expect(fresh.companySite(unknown)).resolves.toEqual({ host: null });
    expect(afterDeploy).not.toHaveBeenCalled();

    // A logo saved by any process is what every other process answers, unasked.
    const key = club
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join(" ");
    await store.put(key, { host: null, icon: ICON }, Date.now() + 60_000);
    await expect(fresh.companySite(club)).resolves.toEqual({ host: null, icon: ICON });
    expect(afterDeploy).not.toHaveBeenCalled();
  });
});
