import type {
  RecruitingContactBackfillField,
  RecruitingContactBackfillInput,
  RecruitingContactBackfillResult,
  RecruitingCorrespondence,
} from "@rakazo/contracts";

/** One role CRM contact as the CRM read returns it; null/blank means missing. */
export type BackfillContact = {
  candidateId: string;
  name: string;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  title: string | null;
  company: string | null;
};
type SavedLookup = Pick<
  RecruitingCorrespondence["contacts"][number],
  "emails" | "phones" | "source" | "checkedAt"
>;
type ProfileFacts = {
  title?: string | null;
  company?: string | null;
  location?: string | null;
  source: string;
  checkedAt: string;
};

/**
 * Each port maps to an existing product path: CRM list read, saved FullEnrich lookups
 * (Contacts tab), saved Autumn pool profile, FullEnrich get_credits / enrich_bulk,
 * and crm_append_candidate_note. The caller keeps those paths' approval rules.
 */
export type ContactBackfillPorts = {
  listContacts(roleId: string): Promise<BackfillContact[]>;
  savedLookup(contact: BackfillContact): Promise<SavedLookup | null>;
  poolProfile(contact: BackfillContact): Promise<ProfileFacts | null>;
  getCredits(): Promise<number>;
  enrich(
    contact: BackfillContact,
  ): Promise<
    { status: "finished"; lookup: SavedLookup } | { status: "pending" } | { status: "failed" }
  >;
  appendNote(contact: BackfillContact, note: string): Promise<void>;
  now(): Date;
};

const ALL_FIELDS: RecruitingContactBackfillField[] = [
  "email",
  "phone",
  "location",
  "title",
  "company",
];
const blank = (value: string | null | undefined) => !value?.trim();

export async function backfillCrmContacts(
  input: RecruitingContactBackfillInput,
  ports: ContactBackfillPorts,
): Promise<RecruitingContactBackfillResult> {
  const fields = input.fields ?? ALL_FIELDS;
  const result: RecruitingContactBackfillResult = {
    processed: 0,
    filled: 0,
    cacheHits: 0,
    paidCalls: 0,
    fills: [],
    skipped: [],
  };
  // ponytail: one balance read, 1 credit per lookup; use FullEnrich's per-field price if phone lookups get enabled.
  let credits: number | undefined;
  const contacts = (await ports.listContacts(input.roleId))
    .filter((contact) => fields.some((field) => blank(contact[field])))
    .slice(0, input.limit);
  for (const contact of contacts) {
    result.processed++;
    const missing = new Set(fields.filter((field) => blank(contact[field])));
    const fills: RecruitingContactBackfillResult["fills"] = [];
    const add = (
      field: RecruitingContactBackfillField,
      value: string | null | undefined,
      provider: string,
      checkedAt: string,
      confidence: string | null,
    ) => {
      if (!missing.has(field) || blank(value)) return;
      missing.delete(field);
      fills.push({
        candidateId: contact.candidateId,
        field,
        value: value!.trim(),
        provider,
        checkedAt,
        confidence,
      });
    };
    let skip: RecruitingContactBackfillResult["skipped"][number]["reason"] | undefined;

    if (missing.has("location") || missing.has("title") || missing.has("company")) {
      const profile = await ports.poolProfile(contact);
      if (profile)
        for (const field of ["location", "title", "company"] as const)
          add(field, profile[field], profile.source, profile.checkedAt, "profile");
    }

    if (missing.has("email") || missing.has("phone")) {
      let lookup = await ports.savedLookup(contact);
      if (lookup) result.cacheHits++;
      else if (blank(contact.linkedinUrl)) skip = "no_linkedin";
      else {
        credits ??= await ports.getCredits();
        if (!(credits >= 1)) skip = "no_credits";
        else {
          credits--;
          result.paidCalls++;
          const outcome = await ports.enrich(contact);
          if (outcome.status === "finished") lookup = outcome.lookup;
          else skip = outcome.status === "pending" ? "lookup_pending" : "lookup_failed";
        }
      }
      if (lookup) {
        const email = lookup.emails[0];
        const phone = lookup.phones[0];
        add("email", email?.address, lookup.source, lookup.checkedAt, email?.status ?? null);
        add("phone", phone?.number, lookup.source, lookup.checkedAt, phone?.type ?? null);
      }
    }

    if (fills.length) {
      const day = ports.now().toISOString().slice(0, 10);
      const note = [
        `Contact backfill ${day}: filled empty CRM fields only; nothing was overwritten or deleted.`,
        ...fills.map(
          (fill) =>
            `- ${fill.field}: ${fill.value} (${fill.provider}, checked ${fill.checkedAt.slice(0, 10)}${fill.confidence ? `, confidence ${fill.confidence}` : ""})`,
        ),
      ].join("\n");
      try {
        await ports.appendNote(contact, note);
        result.fills.push(...fills);
        result.filled++;
      } catch {
        skip = "note_failed";
      }
    } else skip ??= "not_found";
    if (skip) result.skipped.push({ candidateId: contact.candidateId, reason: skip });
  }
  return result;
}
