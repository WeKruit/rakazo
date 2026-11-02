import { describe, expect, it } from "vitest";
import type { RoleCandidatesSources } from "./recruiting-reads.js";
import { mergeRoleCandidates } from "./recruiting-reads.js";

const CRM_TOTAL = 120;
const CRM_PAGE = 50;

const crmRow = (n: number) =>
  ({
    candidateId: `crm-${n}`,
    name: `Person ${n}`,
    email: `person${n}@example.test`,
    linkedinUrl: n === 0 ? "https://linkedin.com/in/saved" : null,
    title: null,
    location: null,
    stage: null,
    contactStatus: null,
    outreachStatus: "not contacted",
    phone: null,
    serverId: "crm",
    organizationId: "org",
  }) as never;

/** A CRM that pages like the live one and records every page it is asked for. */
function pagedSources() {
  const reads: { offset: number; query: string | undefined }[] = [];
  const sources: RoleCandidatesSources = {
    autumn: async () =>
      ({
        items: [
          {
            candidateKey: "saved",
            name: "Saved",
            title: null,
            location: null,
            linkedinUrl: "https://www.linkedin.com/in/saved/",
            latestSource: null,
            match: null,
            ranking: undefined,
            shortlisted: false,
            shortlistedAt: null,
          },
        ],
        nextCursor: null,
        total: 1,
        counts: { shortlisted: 0 },
        crmTarget: { target: {} },
      }) as never,
    autumnLinkedinUrls: async () => ["https://www.linkedin.com/in/saved/"],
    crm: async (_target, offset, query) => {
      reads.push({ offset, query });
      const end = Math.min(CRM_TOTAL, offset + CRM_PAGE);
      return {
        status: "ok",
        rows: Array.from({ length: end - offset }, (_, index) => crmRow(offset + index)),
        total: CRM_TOTAL,
      };
    },
  };
  return { reads, sources };
}

describe("mergeRoleCandidates pages the CRM instead of reading it all", () => {
  it("reads one CRM page per request and walks every person exactly once", async () => {
    const { reads, sources } = pagedSources();
    const keys: string[] = [];
    const totals: number[] = [];
    let cursor: string | undefined;
    let requests = 0;
    do {
      const before = reads.length;
      const page = await mergeRoleCandidates(
        { threadId: "thread", limit: CRM_PAGE, ...(cursor ? { cursor } : {}) },
        sources,
      );
      requests++;
      expect(reads.length - before).toBe(1);
      keys.push(...page.items.map((item) => item.key));
      totals.push(page.total);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && requests < 20);
    // The saved person is matched to CRM row 0, so it is listed once, on the saved side.
    expect(keys[0]).toBe("autumn:saved");
    expect(keys).not.toContain("crm:crm-0");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(CRM_TOTAL);
    expect(reads.map((read) => read.offset)).toEqual([0, 50, 100]);
    // The total is the saved count plus the CRM's own count, the same on every page.
    expect(totals.every((total) => total === 1 + CRM_TOTAL)).toBe(true);
  });

  it("passes the search to the CRM so later pages are not filtered in memory only", async () => {
    const { reads, sources } = pagedSources();
    await mergeRoleCandidates({ threadId: "thread", limit: 10, query: "  Person " }, sources);
    expect(reads).toEqual([{ offset: 0, query: "person" }]);
  });
});
