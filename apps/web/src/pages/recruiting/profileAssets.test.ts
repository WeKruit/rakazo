import { describe, expect, it } from "vitest";
import {
  organizationLogo,
  profileAssets,
  profileContentFields,
  profileImageUrl,
} from "./profileAssets";

const field = (label: string, value: string) => ({ label, value, sourceUrls: [] });

describe("sourced profile images", () => {
  it("uses supplied image columns with explicit organization identities", () => {
    const assets = profileAssets([
      field("Profile photo URL", "https://assets.example.test/person.png"),
      field("Company logo URL", "https://assets.example.test/company.png"),
      field("Current company", "Example Labs"),
      field("School logo URL", "https://assets.example.test/school.png"),
      field("School", "Example University"),
    ]);
    expect(assets.photo).toBe("https://assets.example.test/person.png");
    expect(organizationLogo("Example Labs", assets.company)).toBe(
      "https://assets.example.test/company.png",
    );
    expect(organizationLogo("Example University", assets.school)).toBe(
      "https://assets.example.test/school.png",
    );
    expect(organizationLogo("Example", assets.company)).toBeNull();
    expect(organizationLogo("Previous Employer", assets.company)).toBeNull();
  });

  it("never derives photos or logos from a profile or citation URL", () => {
    expect(
      profileAssets([
        field("Linkedin url", "https://www.linkedin.com/in/example"),
        {
          ...field("Experience", "Engineer at Example"),
          sourceUrls: ["https://example.test/about"],
        },
      ]),
    ).toEqual({ photo: null, company: null, school: null, companyLink: null, schoolLink: null });
    expect(
      profileAssets([field("School logo URL", "https://assets.example.test/school.png")]).school,
    ).toBeNull();
  });

  it("retains source links when a school identity repeats the education entry", () => {
    const fields = profileContentFields([
      { ...field("School", "Example University"), sourceUrls: ["https://school.example.test"] },
      {
        ...field("Education", "Example University, BS, 2010–2014"),
        sourceUrls: ["https://profile.example.test"],
      },
    ]);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.sourceUrls).toEqual([
      "https://profile.example.test",
      "https://school.example.test",
    ]);
  });

  it("preserves school concerns and distinct identities instead of hiding source evidence", () => {
    const school = { ...field("School", "Example University"), evidence: "Degree not verified" };
    const education = field("Education", "Example University, BS, 2010–2014");
    expect(profileContentFields([school, education])).toContain(school);
    const distinct = field("School", "York");
    expect(
      profileContentFields([distinct, field("Education", "New York University, BS")]),
    ).toContain(distinct);
  });

  it("uses only explicit organization website links with the matching source identity", () => {
    const assets = profileAssets([
      field("Company", "Example Labs"),
      field("Company website", "https://example.test/team"),
      field("School", "Example University"),
      field("School URL", "https://school.example.test"),
    ]);
    expect(organizationLogo("Example Labs", assets.companyLink)).toBe("https://example.test/team");
    expect(organizationLogo("Other Labs", assets.companyLink)).toBeNull();
    expect(organizationLogo("Example University", assets.schoolLink)).toBe(
      "https://school.example.test/",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,abc",
    "http://assets.example.test/a.png",
    "https://user:password@assets.example.test/a.png",
    "https://assets.example.test/a.png more",
  ])("rejects unsafe or ambiguous image value %s", (url) => {
    expect(profileImageUrl(url)).toBeNull();
  });
});
