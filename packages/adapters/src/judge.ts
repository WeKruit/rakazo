import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { JudgeProviderConfig, SaveJudgeInput } from "@rakazo/contracts";
import { JudgeProviderConfigSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { credentialDigest } from "./credential-digest.js";

/** Whether a person's profile shows a role's required language. */
export type LanguageSignal = "confirmed" | "strong" | "possible" | "unknown" | "no sign";

/** One person's row for the language check: their whole profile text and the search's row. */
export interface LanguageRow {
  id: string;
  name?: string;
  profile: string;
  candidate?: Record<string, unknown>;
}

/** A yes/no question about some text, answered as the probability of yes. */
export interface TextJudge {
  /** Undefined when the judge could not answer in time; callers keep their own rule then. */
  yes(
    instructions: string,
    state: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  /** The deployment's own language check, when it has one: a verdict for each row it answered. */
  language?(
    requirement: string,
    rows: readonly LanguageRow[],
    signal?: AbortSignal,
  ): Promise<Map<string, LanguageSignal>>;
  /** Several yes/no questions about one text in one request: the probability of yes for each. */
  yesAll?(
    questions: Readonly<Record<string, string>>,
    state: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Map<string, number> | undefined>;
  /**
   * One person's text judged against every requirement in one request: how clearly the text
   * shows each. Undefined when the judge could not answer.
   */
  criteria?(
    state: Record<string, unknown>,
    requirements: readonly CriterionQuestion[],
    signal?: AbortSignal,
  ): Promise<Map<string, CriterionVerdict> | undefined>;
}

/** A requirement to look for in a profile, in the words it was saved in. */
export type CriterionQuestion = {
  id: string;
  statement: string;
  /** The requirement states a place: the answer says where the person is relative to it. */
  place?: boolean;
};

/**
 * Where a person is relative to the place a requirement states, whatever place that is, and the
 * level each answer counts as. Asked "does the profile show the place", a past job there passed.
 */
export const PLACE_TAGS = {
  there_now: "The current location is that place",
  nearby:
    "The current location is a neighbouring city in the same region, within about two hours of that place",
  there_before:
    "The current location is far from that place, and the person studied or worked in that place before",
  elsewhere: "The current location is far from that place, with no past job or school there",
  not_stated: "The profile gives no current location",
} as const;
export type PlaceTag = keyof typeof PLACE_TAGS;
const PLACE_LEVEL: Record<PlaceTag, CriterionVerdict["level"]> = {
  there_now: "strong",
  nearby: "medium",
  there_before: "weak",
  elsewhere: "opposite",
  not_stated: "silent",
};

export const CRITERION_LEVELS = ["strong", "medium", "weak", "silent", "opposite"] as const;
/**
 * How clearly a profile shows one requirement, and how likely it shows the person does not meet
 * it. A profile that says nothing about a requirement is silent, which is not the opposite.
 */
export type CriterionVerdict = {
  level: (typeof CRITERION_LEVELS)[number];
  confidence: number;
  against: number;
  place?: PlaceTag;
};

const CRITERION_CHOICES = {
  strong: "The profile states it clearly, with detail or years",
  medium: "The profile shows it but briefly or partly",
  weak: "Only an indirect hint",
  silent: "The profile says nothing either way about it",
  opposite: "The profile shows the person does not meet it",
};
/** Many questions ride one request, so it gets a little longer than a single yes/no. */
const CRITERIA_TIMEOUT_MS = 5_000;

const JUDGE_TIMEOUT_MS = 2_000;
/** A batch is judged in parallel behind the check, so it gets the judge's time and a little more. */
const LANGUAGE_TIMEOUT_MS = 5_000;
/**
 * Rows per call. A Worker keeps at most six outgoing requests open at once and queues the rest,
 * so six rows are judged together and every batch takes one judge call's time.
 */
const LANGUAGE_BATCH = 6;
/**
 * The check's verdicts as the server ranks them. "possible" is weaker evidence and counts as
 * unknown; "shown" and "unclear" are the earlier names of strong and unknown.
 */
const LANGUAGE_VERDICTS: Readonly<Record<string, LanguageSignal>> = {
  confirmed: "confirmed",
  strong: "strong",
  shown: "strong",
  unknown: "unknown",
  possible: "possible",
  unclear: "unknown",
  "no sign": "no sign",
};

/**
 * POSTs the rows to the deployment's language check in batches; it answers
 * { verdicts: { [id]: { verdict } } }. The judge key is its Bearer token, so the check can ask the
 * same judge without a secret of its own. A batch that fails answers for nobody in it.
 */
function languageCheck(url: string, apiKey: string, fetchImpl: typeof fetch) {
  return async (
    requirement: string,
    rows: readonly LanguageRow[],
    signal?: AbortSignal,
  ): Promise<Map<string, LanguageSignal>> => {
    const signals = new Map<string, LanguageSignal>();
    const batches: LanguageRow[][] = [];
    for (let at = 0; at < rows.length; at += LANGUAGE_BATCH)
      batches.push(rows.slice(at, at + LANGUAGE_BATCH));
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const timeout = AbortSignal.timeout(LANGUAGE_TIMEOUT_MS);
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ requirement, rows: batch }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          if (!response.ok) return;
          const { verdicts } = (await response.json()) as {
            verdicts?: Record<string, { verdict?: unknown } | undefined>;
          };
          for (const row of batch) {
            const verdict = verdicts?.[row.id]?.verdict;
            const signal = typeof verdict === "string" ? LANGUAGE_VERDICTS[verdict] : undefined;
            if (signal) signals.set(row.id, signal);
          }
        } catch {}
      }),
    );
    return signals;
  };
}

/** TypeSafe's System One API, asked one yes/no ("noul") question. */
export function typeSafeJudge(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  languageUrl?: string,
): TextJudge {
  return {
    ...(languageUrl ? { language: languageCheck(languageUrl, apiKey, fetchImpl) } : {}),
    async yesAll(questions, state, signal) {
      try {
        const ids = Object.keys(questions);
        const timeout = AbortSignal.timeout(CRITERIA_TIMEOUT_MS);
        const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "jev-latest",
            state,
            questions: Object.fromEntries(
              ids.map((id, index) => [`q${index}`, { type: "noul", instructions: questions[id] }]),
            ),
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as { answers?: Record<string, { noul?: unknown }> };
        const answers = new Map<string, number>();
        for (const [index, id] of ids.entries()) {
          const p = body.answers?.[`q${index}`]?.noul;
          if (typeof p === "number" && p >= 0 && p <= 1) answers.set(id, p);
        }
        return answers.size ? answers : undefined;
      } catch {
        return undefined;
      }
    },
    async criteria(state, requirements, signal) {
      try {
        const timeout = AbortSignal.timeout(CRITERIA_TIMEOUT_MS);
        const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "jev-latest",
            state,
            questions: {
              ...Object.fromEntries(
                requirements.map((requirement, index) => [
                  `q${index}`,
                  requirement.place
                    ? {
                        type: "choice",
                        instructions: `Where is this person now, relative to the place this requirement states: "${requirement.statement}"? Judge the current location first; a past job or school in that place matters only when the person is now somewhere else.`,
                        criteria: PLACE_TAGS,
                      }
                    : {
                        type: "choice",
                        instructions: `Does this person's profile show: ${requirement.statement}?`,
                        criteria: CRITERION_CHOICES,
                      },
                ]),
              ),
            },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as {
          answers?: Record<
            string,
            {
              choice?: unknown;
              confidence?: unknown;
              probabilities?: { opposite?: unknown };
            }
          >;
        };
        const verdicts = new Map<string, CriterionVerdict>();
        for (const [index, requirement] of requirements.entries()) {
          const answer = body.answers?.[`q${index}`];
          if (requirement.place) {
            const tag = answer?.choice as PlaceTag | undefined;
            if (!tag || !(tag in PLACE_TAGS) || typeof answer?.confidence !== "number") continue;
            verdicts.set(requirement.id, {
              level: PLACE_LEVEL[tag],
              confidence: answer.confidence,
              against: tag === "elsewhere" ? answer.confidence : 0,
              place: tag,
            });
            continue;
          }
          const level = CRITERION_LEVELS.find((item) => item === answer?.choice);
          if (!level || typeof answer?.confidence !== "number") continue;
          const against = answer.probabilities?.opposite;
          verdicts.set(requirement.id, {
            level,
            confidence: answer.confidence,
            against: typeof against === "number" ? against : level === "opposite" ? 1 : 0,
          });
        }
        return verdicts.size ? verdicts : undefined;
      } catch {
        return undefined;
      }
    },
    async yes(instructions, state, signal) {
      try {
        const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
        const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "jev-latest",
            state,
            questions: { answer: { type: "noul", instructions } },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as { answers?: { answer?: { noul?: unknown } } };
        const p = body.answers?.answer?.noul;
        return typeof p === "number" && p >= 0 && p <= 1 ? p : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

const ROW_ID = "judge:typesafe";
const RECORD_ID = "judge-provider:typesafe";

/** The deployment's judge, saved by its owner and read on every use so a new key applies at once. */
export class JudgeSettings {
  private cached: { ciphertext: string; digest: string; judge: TextJudge } | undefined;

  constructor(
    private readonly prisma: Pick<PrismaClient, "integrationProviderConfig">,
    private readonly secrets: SecretStore,
    private readonly create: (config: JudgeProviderConfig) => TextJudge = (config) =>
      typeSafeJudge(config.apiKey, fetch, config.languageUrl),
  ) {}

  private async savedConfig(): Promise<JudgeProviderConfig | undefined> {
    const row = await this.prisma.integrationProviderConfig.findUnique({ where: { id: ROW_ID } });
    if (!row) return undefined;
    return JudgeProviderConfigSchema.parse(
      JSON.parse(await this.secrets.load(row.ciphertext, RECORD_ID)),
    );
  }

  async resolve(): Promise<TextJudge | undefined> {
    try {
      const row = await this.prisma.integrationProviderConfig.findUnique({
        where: { id: ROW_ID },
      });
      if (!row) {
        this.cached = undefined;
        return undefined;
      }
      const plaintext = await this.secrets.load(row.ciphertext, RECORD_ID);
      const digest = credentialDigest(plaintext);
      if (this.cached?.ciphertext === row.ciphertext && this.cached.digest === digest)
        return this.cached.judge;
      const judge = this.create(JudgeProviderConfigSchema.parse(JSON.parse(plaintext)));
      this.cached = { ciphertext: row.ciphertext, digest, judge };
      return judge;
    } catch {
      // An optional judge never stops a turn.
      return undefined;
    }
  }

  async save(input: SaveJudgeInput, context: AdapterContext): Promise<void> {
    const apiKey = input.apiKey ?? (await this.savedConfig())?.apiKey;
    if (!apiKey) throw new Error("No key to save");
    const config: JudgeProviderConfig = { ...input, apiKey };
    // A key or language check that cannot answer a trivial question is not saved over a working one.
    const judge = this.create(config);
    const probe = await judge.yes("Is this text a greeting?", { text: "Hello!" });
    if (probe === undefined) throw new Error("Could not verify this key");
    if (
      judge.language &&
      !(
        await judge.language("Mandarin", [{ id: "probe", profile: "Languages: Mandarin (native)" }])
      ).size
    )
      throw new Error("Could not verify this language check");
    const stored = await this.secrets.put(JSON.stringify(config), context, {
      recordId: RECORD_ID,
    });
    await this.prisma.integrationProviderConfig.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, ciphertext: stored.ciphertext },
      update: { ciphertext: stored.ciphertext },
    });
    this.cached = undefined;
  }
}
