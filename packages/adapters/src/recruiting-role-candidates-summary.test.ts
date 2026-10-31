import { describe, expect, it } from "vitest";
import type { RoleCandidatesSources } from "./recruiting-reads.js";
import { mergeRoleCandidates } from "./recruiting-reads.js";

const crmRow = (n: number) =>
  ({
    candidateId: `crm-${n}`,
    name: `Person ${n}`,
    email: `person${n}@example.test`,
    linkedinUrl: null,
    title: null,
    location: null,
    stage: null,
    contactStatus: null,
    outreachStatus: "not contacted",
    phone: null,
    serverId: "crm",
    organizationId: "org",
  }) as never;

describe("mergeRoleCandidates with a first-page CRM read", () => {
  it("counts the CRM's unread people and offers the next page", async () => {
    const sources: RoleCandidatesSources = {
      autumn: async () =>
        ({
          items: [],
          nextCursor: null,
          total: 3,
          counts: { shortlisted: 0 },
          crmTarget: { target: {} },
        }) as never,
      autumnLinkedinUrls: async () => [],
      crm: async () => ({
        status: "ok",
        rows: Array.from({ length: 50 }, (_, n) => crmRow(n)),
        total: 882,
      }),
    };
    const page = await mergeRoleCandidates({ threadId: "thread", limit: 50 }, sources);
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(3 + 882);
    expect(page.nextCursor).not.toBeNull();
  });
});
