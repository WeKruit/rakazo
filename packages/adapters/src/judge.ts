import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { JudgeProviderConfig } from "@rakazo/contracts";
import { JudgeProviderConfigSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { credentialDigest } from "./credential-digest.js";

/** A yes/no question about some text, answered as the probability of yes. */
export interface TextJudge {
  /** Undefined when the judge could not answer in time; callers keep their own rule then. */
  yes(
    instructions: string,
    state: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
}

const JUDGE_TIMEOUT_MS = 2_000;

/** TypeSafe's System One API, asked one yes/no ("noul") question. */
export function typeSafeJudge(apiKey: string, fetchImpl: typeof fetch = fetch): TextJudge {
  return {
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
      typeSafeJudge(config.apiKey),
  ) {}

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

  async save(config: JudgeProviderConfig, context: AdapterContext): Promise<void> {
    // A key that cannot answer a trivial question is not saved over a working one.
    const probe = await this.create(config).yes("Is this text a greeting?", { text: "Hello!" });
    if (probe === undefined) throw new Error("Could not verify this key");
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
