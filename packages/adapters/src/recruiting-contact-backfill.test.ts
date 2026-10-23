import { RecruitingContactBackfillResultSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type BackfillContact,
  backfillCrmContacts,
  type ContactBackfillPorts,
} from "./recruiting-contact-backfill.js";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const contact = (n: number, patch: Partial<BackfillContact> = {}): BackfillContact => ({
  candidateId: id(n),
  name: `Person ${n}`,
  linkedinUrl: `https://www.linkedin.com/in/person-${n}`,
  email: null,
  phone: null,
  location: null,
  title: null,
  company: null,
  ...patch,
});
const lookup = (address: string) => ({
  emails: [{ address, status: "DELIVERABLE" }],
  phones: [],
  source: "FullEnrich",
  checkedAt: "2026-10-20T10:00:00.000Z",
});

function ports(contacts: BackfillContact[], patch: Partial<ContactBackfillPorts> = {}) {
  return {
    listContacts: vi.fn(async () => contacts),
    savedLookup: vi.fn(async () => null),
    poolProfile: vi.fn(async () => null),
    getCredits: vi.fn(async () => 100),
    enrich: vi.fn(async (c: BackfillContact) => ({
      status: "finished" as const,
      lookup: lookup(`${c.name.replace(" ", ".").toLowerCase()}@acme.com`),
    })),
    appendNote: vi.fn(async () => {}),
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    ...patch,
  } satisfies ContactBackfillPorts;
}
const input = { operation: "backfill_contacts" as const, roleId: "role-1", limit: 50 };

describe("backfillCrmContacts", () => {
  it("uses a saved lookup instead of a paid call", async () => {
    const p = ports([contact(1)], { savedLookup: vi.fn(async () => lookup("p1@acme.com")) });
    const result = await backfillCrmContacts({ ...input, fields: ["email"] }, p);
    expect(p.enrich).not.toHaveBeenCalled();
    expect(p.getCredits).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, filled: 1, cacheHits: 1, paidCalls: 0 });
    expect(RecruitingContactBackfillResultSchema.parse(result).fills[0]).toMatchObject({
      field: "email",
      value: "p1@acme.com",
      provider: "FullEnrich",
      confidence: "DELIVERABLE",
    });
  });

  it("makes one paid lookup per contact and writes a provenance note", async () => {
    const p = ports([contact(1), contact(2)]);
    const result = await backfillCrmContacts({ ...input, fields: ["email", "phone"] }, p);
    expect(p.enrich).toHaveBeenCalledTimes(2);
    expect(p.getCredits).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 2, filled: 2, paidCalls: 2, cacheHits: 0 });
    expect(p.appendNote).toHaveBeenCalledTimes(2);
    expect(vi.mocked(p.appendNote).mock.calls[0]![1]).toBe(
      "Contact backfill 2026-10-23: filled empty CRM fields only; nothing was overwritten or deleted.\n- email: person.1@acme.com (FullEnrich, checked 2026-10-20, confidence DELIVERABLE)",
    );
    // phone had no provider value: stays missing, never invented
    expect(result.fills.map((fill) => fill.field)).toEqual(["email", "email"]);
  });

  it("never overwrites non-empty fields and skips complete contacts", async () => {
    const p = ports(
      [
        contact(1, { email: "kept@x.com", location: "Boston", title: "SWE", company: "Acme" }),
        contact(2, {
          email: "a@b.com",
          phone: "1",
          location: "NYC",
          title: "PM",
          company: "B",
        }),
      ],
      {
        poolProfile: vi.fn(async () => ({
          location: "Paris",
          title: "CTO",
          company: "Other",
          source: "Autumn",
          checkedAt: "2026-10-01T00:00:00.000Z",
        })),
        savedLookup: vi.fn(async () => lookup("new@x.com")),
      },
    );
    const result = await backfillCrmContacts(input, p);
    expect(result.processed).toBe(1);
    expect(result.fills).toEqual([]);
    expect(p.appendNote).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ candidateId: id(1), reason: "not_found" }]);
  });

  it("fills profile facts from the saved pool without a paid call", async () => {
    const p = ports([contact(1, { email: "a@b.com", phone: "1" })], {
      poolProfile: vi.fn(async () => ({
        location: "Paris",
        title: "CTO",
        company: null,
        source: "Autumn",
        checkedAt: "2026-10-01T00:00:00.000Z",
      })),
    });
    const result = await backfillCrmContacts(input, p);
    expect(p.enrich).not.toHaveBeenCalled();
    expect(result.fills.map((fill) => [fill.field, fill.value, fill.provider])).toEqual([
      ["location", "Paris", "Autumn"],
      ["title", "CTO", "Autumn"],
    ]);
  });

  it("respects zero credits: no paid call, skipped with reason", async () => {
    const p = ports([contact(1)], { getCredits: vi.fn(async () => 0) });
    const result = await backfillCrmContacts({ ...input, fields: ["email"] }, p);
    expect(p.enrich).not.toHaveBeenCalled();
    expect(result).toMatchObject({ paidCalls: 0, filled: 0 });
    expect(result.skipped).toEqual([{ candidateId: id(1), reason: "no_credits" }]);
  });

  it("stops paid calls when credits run out mid-batch", async () => {
    const p = ports([contact(1), contact(2)], { getCredits: vi.fn(async () => 1) });
    const result = await backfillCrmContacts({ ...input, fields: ["email"] }, p);
    expect(p.enrich).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([{ candidateId: id(2), reason: "no_credits" }]);
  });

  it("budget guard: processes at most limit contacts", async () => {
    const p = ports([1, 2, 3, 4, 5].map((n) => contact(n)));
    const result = await backfillCrmContacts({ ...input, limit: 2, fields: ["email"] }, p);
    expect(result.processed).toBe(2);
    expect(p.enrich).toHaveBeenCalledTimes(2);
  });

  it("reports pending lookups and note failures without claiming fills", async () => {
    const p = ports([contact(1), contact(2)], {
      enrich: vi.fn(async (c: BackfillContact) =>
        c.candidateId === id(1)
          ? { status: "pending" as const }
          : { status: "finished" as const, lookup: lookup("p2@acme.com") },
      ),
      appendNote: vi.fn(async () => {
        throw new Error("stale notes");
      }),
    });
    const result = await backfillCrmContacts({ ...input, fields: ["email"] }, p);
    expect(result).toMatchObject({ processed: 2, filled: 0, paidCalls: 2, fills: [] });
    expect(result.skipped).toEqual([
      { candidateId: id(1), reason: "lookup_pending" },
      { candidateId: id(2), reason: "note_failed" },
    ]);
  });
});
