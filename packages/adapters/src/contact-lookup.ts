import { z } from "zod";
import { linkedinPersonKey } from "./recruiting-profiles.js";

/** One person to look up, as the agent reads them from the role's saved candidates. */
export const FindEmailsInput = z.strictObject({
  people: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        linkedin_url: z.string().trim().min(1).max(500),
        company: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(500)
    .optional(),
  /** The first N people of the conversation's role in Results order; the server picks the batch. */
  next_from_role: z.number().int().min(1).max(5000).optional(),
  /** Set by the server with next_from_role: people still to look up after this batch. */
  remaining_after: z.number().int().nonnegative().optional(),
  /** Search again people a source already found nothing for; only when the recruiter asks. */
  recheck: z.boolean().optional(),
});
/** People one call looks up; the rest are named in the result for the next call. */
export const LOOKUP_BATCH = 50;
export type FindEmailsInput = z.infer<typeof FindEmailsInput>;

export type ContactProvider = "fullenrich" | "contactout" | "leadmagic";
export type FoundEmail = {
  address: string;
  type: "work" | "personal";
  /** The provider's own delivery check, e.g. DELIVERABLE; null when it gives none. */
  status: string | null;
  provider: ContactProvider;
};
/** What each provider did for this person, in the order they ran. */
export type ProviderAttempt = {
  provider: ContactProvider | "saved";
  outcome: "found" | "not_found" | "skipped" | "failed" | "pending";
  detail?: string;
};
export type PersonContacts = {
  name: string;
  linkedin_url: string;
  emails: FoundEmail[];
  lookups: ProviderAttempt[];
};
export type FindEmailsResult = {
  people: PersonContacts[];
  summary: {
    looked_up: number;
    found: number;
    verified: number;
    /** People no source was charged for, because every source already searched them before. */
    already_looked_up?: number;
    /** People sent to at least one paid source in this call. */
    paid_lookups: number;
    /** People past the first {@link LOOKUP_BATCH}, left for the next call. */
    not_looked_up?: number;
    next_step?: string;
  };
};

export type ContactLookupKeys = Partial<Record<ContactProvider, string>>;
export type ContactLookupOptions = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  keys: ContactLookupKeys;
  signal: AbortSignal;
  /** Emails this account already paid for, by LinkedIn key; reused instead of a new lookup. */
  emails?: ReadonlyMap<string, FoundEmail[]>;
  /** Sources that already found nothing for a person, by LinkedIn key; not charged again. */
  searched?: ReadonlyMap<string, ReadonlySet<ContactProvider>>;
  waitMs?: number;
  pollMs?: number;
  /** Longest wait for one provider request; a source that stops answering never holds the run. */
  requestMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const FULLENRICH = "https://app.fullenrich.com/api/v1/contact/enrich/bulk";
const CONTACTOUT = "https://api.contactout.com/v1/people/linkedin";
const LEADMAGIC = "https://api.leadmagic.io/v1/people/personal-email-finder";
const EMAIL = z.email();
const SEARCHED_BEFORE = "searched before; nothing found";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

class ProviderError extends Error {}

const REQUEST_MS = 30_000;
const NO_ANSWER = "no answer in time";
const request = (options: ContactLookupOptions, url: string, init: RequestInit = {}) =>
  options.fetch(url, {
    ...init,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.requestMs ?? REQUEST_MS)]),
  });
const failure = (error: unknown) =>
  error instanceof ProviderError
    ? error.message
    : error instanceof Error && error.name === "TimeoutError"
      ? NO_ANSWER
      : "request failed";

async function json(response: Response, provider: string) {
  if (response.status === 402) throw new ProviderError(`${provider} has no credits left`);
  if (response.status === 401 || response.status === 403)
    throw new ProviderError(`${provider} refused the key (HTTP ${response.status})`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new ProviderError(`${provider} HTTP ${response.status}`);
  return record(await response.json().catch(() => undefined));
}

function splitName(name: string) {
  const parts = name
    .replace(/\(.*?\)/g, " ")
    .replace(/\./g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return { firstname: parts[0] ?? name, lastname: parts.slice(1).join(" ") || parts[0] || name };
}

/**
 * Finds emails for saved candidates, one provider after another, and keeps what each one did.
 * Order follows measured value: the first provider returns work and personal emails with its own
 * delivery check; the next two only fill people still without an email. A provider that has no
 * key, no credits or fails is recorded and skipped; it never stops the lookup.
 */
export async function findEmails(
  input: FindEmailsInput,
  options: ContactLookupOptions,
): Promise<FindEmailsResult> {
  const sleep = options.sleep ?? defaultSleep;
  const asked = input.people ?? [];
  const later = asked.slice(LOOKUP_BATCH);
  const people: Array<PersonContacts & { key: string | null; company?: string }> = asked
    .slice(0, LOOKUP_BATCH)
    .map((person) => ({
      name: person.name,
      linkedin_url: person.linkedin_url,
      company: person.company,
      key: linkedinPersonKey(person.linkedin_url),
      emails: [],
      lookups: [],
    }));
  const add = (person: PersonContacts, email: FoundEmail) => {
    const address = email.address.trim().toLowerCase();
    if (!EMAIL.safeParse(address).success) return;
    if (person.emails.some((saved) => saved.address === address)) return;
    person.emails.push({ ...email, address });
  };
  for (const person of people) {
    if (!person.key)
      person.lookups.push({
        provider: "saved",
        outcome: "skipped",
        detail: "no LinkedIn profile link",
      });
    const saved = person.key ? options.emails?.get(person.key) : undefined;
    if (saved?.length) {
      for (const email of saved) add(person, email);
      person.lookups.push({ provider: "saved", outcome: "found" });
    }
  }
  // A source that already searched a person and found nothing is never charged for them again.
  const open = (provider: ContactProvider) =>
    people.filter((person) => {
      if (!person.key || person.emails.length) return false;
      if (input.recheck || !options.searched?.get(person.key)?.has(provider)) return true;
      person.lookups.push({ provider, outcome: "not_found", detail: SEARCHED_BEFORE });
      return false;
    });

  await fullEnrich(open("fullenrich"), options, sleep, add);
  // A source that stopped answering is skipped for everyone after it.
  for (const provider of ["contactout", "leadmagic"] as const) {
    let down = false;
    for (const person of open(provider)) {
      if (down) {
        person.lookups.push({ provider, outcome: "skipped", detail: "source not answering" });
        continue;
      }
      await (provider === "contactout" ? contactOut : leadMagic)(person, options, add);
      down = person.lookups.at(-1)?.detail === NO_ANSWER;
    }
  }

  const output = people.map(({ key: _key, company: _company, ...person }) => ({
    ...person,
    // Delivery-checked first, then personal before work.
    emails: person.emails.sort(
      (a, b) =>
        Number(b.status === "DELIVERABLE") - Number(a.status === "DELIVERABLE") ||
        Number(b.type === "personal") - Number(a.type === "personal"),
    ),
  }));
  return {
    people: output,
    summary: {
      looked_up: output.length,
      found: output.filter((person) => person.emails.length).length,
      verified: output.filter((person) =>
        person.emails.some((email) => email.status === "DELIVERABLE"),
      ).length,
      ...(() => {
        const skipped = people.filter(
          (person) =>
            !person.emails.length &&
            person.lookups.some((lookup) => lookup.detail === SEARCHED_BEFORE) &&
            person.lookups.every(
              (lookup) => lookup.detail === SEARCHED_BEFORE || lookup.outcome === "skipped",
            ),
        ).length;
        return skipped ? { already_looked_up: skipped } : {};
      })(),
      // Only a source that answered (or accepted the job) charged; no credits or a refusal did not.
      paid_lookups: people.filter((person) =>
        person.lookups.some(
          (lookup) =>
            lookup.provider !== "saved" &&
            ["found", "not_found", "pending"].includes(lookup.outcome) &&
            lookup.detail !== SEARCHED_BEFORE,
        ),
      ).length,
      ...(input.remaining_after
        ? {
            not_looked_up: input.remaining_after,
            next_step: `${input.remaining_after} of the first ${input.next_from_role} people are still to look up. Call find_emails again with next_from_role ${input.next_from_role} right away, and keep calling until none are left; do not stop, ask or report a final count before that.`,
          }
        : later.length
          ? {
              not_looked_up: later.length,
              next_step: `Looked up the first ${LOOKUP_BATCH}. Call again with the other ${later.length} people, starting with ${later[0]!.name}.`,
            }
          : {}),
    },
  };
}

type Add = (person: PersonContacts, email: FoundEmail) => void;
type Person = PersonContacts & { company?: string };

async function fullEnrich(
  people: Person[],
  options: ContactLookupOptions,
  sleep: NonNullable<ContactLookupOptions["sleep"]>,
  add: Add,
) {
  if (!people.length) return;
  const key = options.keys.fullenrich;
  const mark = (outcome: ProviderAttempt["outcome"], detail?: string, only?: Person[]) => {
    for (const person of only ?? people)
      person.lookups.push({ provider: "fullenrich", outcome, ...(detail ? { detail } : {}) });
  };
  if (!key) return mark("skipped", "not configured");
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const started = await json(
      await request(options, FULLENRICH, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "contact lookup",
          datas: people.map((person, index) => ({
            ...splitName(person.name),
            linkedin_url: person.linkedin_url,
            ...(person.company ? { company_name: person.company } : {}),
            enrich_fields: ["contact.emails", "contact.personal_emails"],
            custom: { person: String(index) },
          })),
        }),
      }),
      "fullenrich",
    );
    const id = text(started?.enrichment_id);
    if (!id) return mark("failed", "no lookup id returned");
    const deadline = Date.now() + (options.waitMs ?? 240_000);
    let body: Record<string, unknown> | undefined;
    for (;;) {
      await sleep(options.pollMs ?? 5_000, options.signal);
      try {
        body = await json(
          await request(options, `${FULLENRICH}/${encodeURIComponent(id)}`, { headers }),
          "fullenrich",
        );
      } catch (error) {
        // One slow status check is retried on the next poll; the lookup is already paid for.
        if (options.signal.aborted || error instanceof ProviderError) throw error;
        if (Date.now() >= deadline) break;
        continue;
      }
      if (text(body?.status) === "FINISHED" || Date.now() >= deadline) break;
      if (/CANCELED|CREDITS_INSUFFICIENT|RATE_LIMIT|UNKNOWN/i.test(text(body?.status))) break;
    }
    if (text(body?.status) !== "FINISHED")
      return mark(
        text(body?.status) && Date.now() >= deadline ? "pending" : "failed",
        text(body?.status) || "no result",
      );
    const rows = Array.isArray(body?.datas) ? body.datas : [];
    rows.forEach((row, index) => {
      const entry = record(row);
      const custom = record(entry?.custom);
      const person = people[Number(custom?.person ?? index)];
      if (!person) return;
      const contact = record(entry?.contact);
      for (const [field, type] of [
        ["emails", "work"],
        ["personal_emails", "personal"],
      ] as const)
        for (const item of Array.isArray(contact?.[field]) ? contact[field] : []) {
          const value = record(item);
          add(person, {
            address: text(value?.email),
            type,
            status: text(value?.status) || null,
            provider: "fullenrich",
          });
        }
    });
    for (const person of people)
      person.lookups.push({
        provider: "fullenrich",
        outcome: person.emails.length ? "found" : "not_found",
      });
  } catch (error) {
    if (options.signal.aborted) throw error;
    mark("failed", failure(error));
  }
}

async function contactOut(person: Person, options: ContactLookupOptions, add: Add) {
  const key = options.keys.contactout;
  if (!key) {
    person.lookups.push({ provider: "contactout", outcome: "skipped", detail: "not configured" });
    return;
  }
  try {
    const url = new URL(CONTACTOUT);
    url.searchParams.set("profile", person.linkedin_url);
    url.searchParams.set("include_phone", "false");
    const body = await json(
      await request(options, url.href, { headers: { token: key, authorization: "basic" } }),
      "contactout",
    );
    const profile = record(body?.profile);
    const checks = record(profile?.work_email_status) ?? {};
    for (const address of Array.isArray(profile?.personal_email) ? profile.personal_email : [])
      add(person, {
        address: text(address),
        type: "personal",
        status: null,
        provider: "contactout",
      });
    for (const address of Array.isArray(profile?.work_email) ? profile.work_email : [])
      add(person, {
        address: text(address),
        type: "work",
        status: text(checks[text(address)]) || null,
        provider: "contactout",
      });
    person.lookups.push({
      provider: "contactout",
      outcome: person.emails.length ? "found" : "not_found",
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    person.lookups.push({
      provider: "contactout",
      outcome: "failed",
      detail: failure(error),
    });
  }
}

async function leadMagic(person: Person, options: ContactLookupOptions, add: Add) {
  const key = options.keys.leadmagic;
  if (!key) {
    person.lookups.push({ provider: "leadmagic", outcome: "skipped", detail: "not configured" });
    return;
  }
  try {
    const body = await json(
      await request(options, LEADMAGIC, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ profile_url: person.linkedin_url }),
      }),
      "leadmagic",
    );
    for (const address of Array.isArray(body?.personal_emails) ? body.personal_emails : [])
      add(person, {
        address: text(address),
        type: "personal",
        status: null,
        provider: "leadmagic",
      });
    person.lookups.push({
      provider: "leadmagic",
      outcome: person.emails.length ? "found" : "not_found",
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    person.lookups.push({
      provider: "leadmagic",
      outcome: "failed",
      detail: failure(error),
    });
  }
}
