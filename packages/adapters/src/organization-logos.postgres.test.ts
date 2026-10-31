import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCompanySiteResolver } from "./company-site.js";
import { createPrismaOrganizationLogoStore, fillOrganizationLogos } from "./organization-logos.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const ICON = "data:image/png;base64,AAAA";

describePostgres("organization logos (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `logo-user-${suffix}`;
  const organizationId = `logo-org-${suffix}`;
  const spaceId = `logo-space-${suffix}`;
  const club = `Logo Club ${suffix}`;
  const school = `Logo School ${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Logos" } });
    await prisma.recruitingSavedProfile.create({
      data: {
        spaceId,
        ownerUserId: userId,
        personKey: "linkedin:logo-person",
        provider: "people-search",
        sourceEffectId: "effect-1",
        fetchedAt: new Date(),
        profile: {
          experience: [{ company_name: club }],
          education: [{ school_name: school }],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.organizationLogo.deleteMany({ where: { key: { contains: suffix } } });
    await prisma.space.deleteMany({ where: { id: spaceId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("saves every saved person's organizations once, and pages read the saved logo", async () => {
    const searchOrganizations = vi.fn(async (name: string) => [
      { url: `https://instagram.com/${name.replace(/\W/g, "")}`, title: name, image: "" },
    ]);
    const store = createPrismaOrganizationLogoStore(prisma);
    const lookups = createCompanySiteResolver({
      store,
      searchOrganizations,
      fetch: vi.fn(async () => new Response("", { status: 404 })),
    });
    // The index answers both names, so each becomes a confirmed miss or logo; only ours matter.
    const first = await fillOrganizationLogos(prisma, lookups, { maxLookups: 50_000 });
    expect(first.names).toBeGreaterThanOrEqual(2);
    const looked = searchOrganizations.mock.calls.length;
    await fillOrganizationLogos(prisma, lookups, { maxLookups: 50_000 });
    expect(searchOrganizations.mock.calls.length).toBe(looked);

    // A logo saved by any process is what a fresh process (after a deploy) answers, unasked.
    await store.put(
      club
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join(" "),
      { host: null, icon: ICON },
      Date.now() + 60_000,
    );
    // A miss saved by the three-result search (kept three days) is looked up again; a newer
    // two-day miss is trusted.
    const day = 24 * 60 * 60 * 1000;
    const old = `old miss ${suffix}`.toLowerCase().replace(/-/g, " ");
    const recent = `recent miss ${suffix}`.toLowerCase().replace(/-/g, " ");
    await prisma.organizationLogo.createMany({
      data: [
        { key: old, checkedAt: new Date(), checkAgainAt: new Date(Date.now() + 3 * day) },
        { key: recent, checkedAt: new Date(), checkAgainAt: new Date(Date.now() + 2 * day) },
      ],
    });
    const recheck = vi.fn(async (name: string) => [
      { url: "https://example.org/", title: name, image: "" },
    ]);
    const again = createCompanySiteResolver({
      store,
      searchOrganizations: recheck,
      fetch: vi.fn(async () => new Response("", { status: 404 })),
    });
    await again.companySite(old);
    await again.companySite(recent);
    expect(recheck.mock.calls.map(([name]) => name)).toEqual([old]);

    const afterDeploy = vi.fn();
    const fresh = createCompanySiteResolver({ store, searchOrganizations: afterDeploy });
    await expect(fresh.companySite(club)).resolves.toEqual({ host: null, icon: ICON });
    expect(afterDeploy).not.toHaveBeenCalled();
  });
});
