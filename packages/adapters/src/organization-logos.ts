import type { PrismaClient } from "@rakazo/db";
import type { OrganizationLogoStore } from "./company-site.js";

function savedAnswer(row: { host: string | null; icon: string | null; checkAgainAt: Date }) {
  return {
    host: row.host,
    ...(row.icon ? { icon: row.icon } : {}),
    expiresAt: row.checkAgainAt.getTime(),
  };
}

/**
 * Logos kept in the database, shared by every user: organization names only, never a person. Each
 * company or school is looked up once, when a page first shows it; a miss is saved too.
 */
export function createPrismaOrganizationLogoStore(
  prisma: Pick<PrismaClient, "organizationLogo">,
): OrganizationLogoStore {
  return {
    async get(key) {
      const row = await prisma.organizationLogo.findUnique({ where: { key } });
      return row ? savedAnswer(row) : null;
    },
    async getMany(keys) {
      const rows = await prisma.organizationLogo.findMany({ where: { key: { in: [...keys] } } });
      return new Map(rows.map((row) => [row.key, savedAnswer(row)]));
    },
    async put(key, found, expiresAt) {
      const data = {
        host: found.host,
        icon: found.icon ?? null,
        checkedAt: new Date(),
        checkAgainAt: new Date(expiresAt),
      };
      await prisma.organizationLogo.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    },
  };
}
