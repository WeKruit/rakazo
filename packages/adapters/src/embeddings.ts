import type { TextEmbedder } from "@rakazo/db";
import { resolveDeploymentModel } from "./deployment-model.js";

/**
 * Embedding endpoints for the deployment's own model connection, by provider. A provider without
 * a row gets no embedder, and history search keeps matching words only.
 */
const ENDPOINTS: Record<string, { url: string; model: string; usdPerMTok: number }> = {
  openai: {
    url: "https://api.openai.com/v1/embeddings",
    model: "text-embedding-3-small",
    usdPerMTok: 0.02,
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/embeddings",
    model: "openai/text-embedding-3-small",
    usdPerMTok: 0.02,
  },
};

/** An OpenAI-compatible embedder over the deployment model key; null when there is none. */
export function createDeploymentEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): TextEmbedder | null {
  const { provider, key } = resolveDeploymentModel(env);
  const endpoint = ENDPOINTS[provider];
  if (!endpoint || !key) return null;
  return {
    provider,
    model: endpoint.model,
    async embed(texts, signal) {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: endpoint.model, input: texts }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Embedding request answered ${response.status}`);
      const body = (await response.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const vectors = [...(body.data ?? [])]
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);
      const tokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0;
      return { vectors, tokens, costUsd: (tokens * endpoint.usdPerMTok) / 1_000_000 };
    },
  };
}
