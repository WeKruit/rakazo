import { expect, it } from "vitest";
import { linkedinIdentity, mergeRoleCandidates, roleCandidateFit } from "./roleCandidates";

const entry = (
  key: string,
  extra: Partial<{ email: string; linkedinUrl: string; score: string }>,
) => ({
  key,
  name: key,
  title: null,
  location: null,
  email: extra.email ?? null,
  linkedinUrl: extra.linkedinUrl ?? null,
  value: { key, score: extra.score },
});
const fit = (value: { score?: string }) =>
  roleCandidateFit(value.score ? [{ label: "Match score", value: value.score }] : []);

it("normalizes LinkedIn profiles across hosts, case, slashes and queries", () => {
  expect(linkedinIdentity("https://www.linkedin.com/in/Ada-L/?trk=x")).toBe(
    "linkedin.com/in/ada-l",
  );
  expect(linkedinIdentity("uk.linkedin.com/in/ada-l")).toBe("linkedin.com/in/ada-l");
  expect(linkedinIdentity("not a url")).toBeNull();
  expect(linkedinIdentity(null)).toBeNull();
});

it("joins a CRM contact to the same search result by LinkedIn, then by email", () => {
  const rows = mergeRoleCandidates({
    sourced: [
      entry("a", { linkedinUrl: "https://linkedin.com/in/ada" }),
      entry("b", { email: "Ben@Example.com" }),
    ],
    crm: [
      entry("crm-ada", { linkedinUrl: "https://www.linkedin.com/in/ADA/", email: "ada@x.test" }),
      entry("crm-ben", { email: "ben@example.com" }),
      entry("crm-cy", { email: "cy@example.com" }),
    ],
    fit,
  });
  expect(rows.map((row) => [row.key, row.sourced?.key ?? null, row.crm?.key ?? null])).toEqual([
    ["a", "a", "crm-ada"],
    ["b", "b", "crm-ben"],
    ["crm-cy", null, "crm-cy"],
  ]);
  // The joined row fills what the search did not return from the CRM record.
  expect(rows[0]!.email).toBe("ada@x.test");
});

it("orders search rows by score, highest first, then CRM-only rows; keeps a second CRM record", () => {
  const rows = mergeRoleCandidates({
    sourced: [entry("low", { score: "40" }), entry("none", {}), entry("high", { score: "92" })],
    crm: [
      entry("crm-1", { email: "same@example.com" }),
      entry("crm-2", { email: "same@example.com" }),
    ],
    fit,
  });
  expect(rows.map((row) => row.key)).toEqual(["high", "low", "none", "crm-1", "crm-2"]);
  const given = mergeRoleCandidates({
    sourced: [entry("low", { score: "40" }), entry("high", { score: "92" })],
    crm: [],
    fit,
    sortByScore: false,
  });
  expect(given.map((row) => row.key)).toEqual(["low", "high"]);
});
