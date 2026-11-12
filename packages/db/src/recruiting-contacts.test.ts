import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { listRecruitingContacts } from "./recruiting-contacts.js";

it("projects only the page's owner-scoped saved media and matches the displayed organization", async () => {
  const actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: false,
  } as Actor;
  const row = (person_key: string, company: string) => ({
    person_key,
    company,
    name: person_key,
    title: null,
    location: null,
    linkedin_url: null,
    email: null,
    status: "saved",
    roles: [],
    note_key: person_key,
    added_at: null,
    last_contacted: null,
    last_replied: null,
    total: 2,
  });
  const query = vi
    .fn()
    .mockResolvedValueOnce([
      { person_key: "one", total: 2 },
      { person_key: "two", total: 2 },
    ])
    .mockResolvedValueOnce([row("one", "Current Co"), row("two", "Other Co")])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        person_key: "two",
        profile: {
          profileImageUrl: "https://img.example/two.jpg",
          experience: [],
          education: [],
        },
      },
      {
        person_key: "one",
        profile: {
          profileImageUrl: "https://img.example/one.jpg",
          experience: [
            {
              company_name: "Former Co",
              company_logo_url: "https://img.example/wrong.png",
              company_url: "https://former.example",
            },
            {
              company_name: " current  co ",
              company_logo_url: "https://img.example/current.png",
              company_url: "https://current.example",
            },
          ],
          education: [
            {
              school_name: "School",
              school_logo_url: "https://img.example/school.png",
              school_url: "https://school.example",
            },
          ],
        },
      },
    ]);
  const result = await listRecruitingContacts(
    { $queryRaw: query } as unknown as Pick<PrismaClient, "$queryRaw">,
    actor,
    {},
  );
  expect(result.items[0]).toMatchObject({
    personKey: "one",
    profileImageUrl: "https://img.example/one.jpg",
    companyLogoUrl: "https://img.example/current.png",
    companyWebsiteUrl: "https://current.example",
    school: "School",
    schoolLogoUrl: "https://img.example/school.png",
  });
  expect(result.items[1]).toMatchObject({
    personKey: "two",
    profileImageUrl: "https://img.example/two.jpg",
    companyLogoUrl: null,
    schoolLogoUrl: null,
  });
  const mediaQuery = query.mock.calls[3]![0];
  expect(mediaQuery.text).toMatch(/"spaceId" = \$\d+ AND "ownerUserId" = \$\d+/);
  expect(mediaQuery.text).toContain('"personKey" IN');
  expect(mediaQuery.values).toEqual(["space", "owner", "one", "two"]);
});

it("orders the whole pool in one grouped pass and skips display fields a date order does not need", async () => {
  const actor = { userId: "owner", spaceId: "space" } as Actor;
  const pageSql = async (sort: "name" | "added", filters = {}) => {
    const query = vi.fn().mockResolvedValue([]);
    await listRecruitingContacts({ $queryRaw: query } as unknown as PrismaClient, actor, {
      sort,
      limit: 50,
      filters,
    });
    return (query.mock.calls[0]![0] as { sql: string }).sql;
  };
  const display = /array_agg\(name ORDER BY/;
  for (const sql of [await pageSql("name"), await pageSql("added")]) {
    // Each person's entries are grouped once; no second sort-and-join over everyone.
    expect(sql).not.toMatch(/DISTINCT ON \(person_key\)/);
    expect(sql.match(/GROUP BY person_key/g)).toHaveLength(1);
  }
  expect(await pageSql("name")).toMatch(display);
  expect(await pageSql("added")).not.toMatch(display);
  expect(await pageSql("added", { company: "Acme" })).toMatch(display);
});

it("reads only the filtered roles' people instead of the whole account", async () => {
  const query = vi.fn().mockResolvedValue([]);
  await listRecruitingContacts(
    { $queryRaw: query } as unknown as PrismaClient,
    { userId: "owner", spaceId: "space" } as Actor,
    { sort: "name", limit: 50, filters: { roleIds: ["role-a", "crm:role-b"] } },
  );
  const page = query.mock.calls[0]![0] as { sql: string; values: unknown[] };
  expect(page.sql).toMatch(/matching_keys AS MATERIALIZED/);
  // Every source of people is narrowed to those keys before it is merged and sorted.
  expect(
    page.sql.match(/IN \(SELECT person_key FROM matching_keys\)/g)?.length,
  ).toBeGreaterThanOrEqual(3);
  expect(page.values).toEqual(expect.arrayContaining(["role-a", "crm:role-b"]));
});
