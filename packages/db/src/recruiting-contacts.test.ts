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
