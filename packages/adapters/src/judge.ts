import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { JudgeProviderConfig, SaveJudgeInput } from "@rakazo/contracts";
import { JudgeProviderConfigSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { credentialDigest } from "./credential-digest.js";

/** Whether a person's profile shows a role's required language. */
export type LanguageSignal = "shown" | "unclear" | "no sign";

/** One person's row for the language check. */
export interface LanguageRow {
  requirement: string;
  name?: string;
  profile: string;
}

/** A yes/no question about some text, answered as the probability of yes. */
export interface TextJudge {
  /** Undefined when the judge could not answer in time; callers keep their own rule then. */
  yes(
    instructions: string,
    state: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  /** The deployment's own language check, when it has one; undefined when it did not answer. */
  language?(row: LanguageRow, signal?: AbortSignal): Promise<LanguageSignal | undefined>;
}

const JUDGE_TIMEOUT_MS = 2_000;
/** The language check calls the judge itself, so it gets the judge's time and a little more. */
const LANGUAGE_TIMEOUT_MS = 3_000;
const LANGUAGE_SIGNALS: readonly unknown[] = ["shown", "unclear", "no sign"];

/**
 * POSTs one row to the deployment's language check, which answers { verdict }. The judge key is
 * its Bearer token, so the check can ask the same judge without a secret of its own.
 */
function languageCheck(url: string, apiKey: string, fetchImpl: typeof fetch) {
  return async (row: LanguageRow, signal?: AbortSignal): Promise<LanguageSignal | undefined> => {
    try {
      const timeout = AbortSignal.timeout(LANGUAGE_TIMEOUT_MS);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(row),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return undefined;
      const verdict = ((await response.json()) as { verdict?: unknown }).verdict;
      return LANGUAGE_SIGNALS.includes(verdict) ? (verdict as LanguageSignal) : undefined;
    } catch {
      return undefined;
    }
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
      !(await judge.language({ requirement: "Mandarin", profile: "Languages: Mandarin (native)" }))
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
