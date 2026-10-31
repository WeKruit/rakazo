import { describe, expect, it } from "vitest";
import { createDeploymentEmbedder } from "./embeddings.js";

describe("createDeploymentEmbedder", () => {
  it("uses the deployment connection's key and orders vectors by input", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const embedder = createDeploymentEmbedder(
      { PI_DEFAULT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" },
      async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return Response.json({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
          usage: { prompt_tokens: 1_000_000 },
        });
      },
    );
    const result = await embedder!.embed(["a", "b"]);
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer test-key");
    expect(result).toEqual({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      tokens: 1_000_000,
      costUsd: 0.02,
    });
  });

  it("is off without a key or for a provider without an embeddings endpoint", async () => {
    expect(createDeploymentEmbedder({ PI_DEFAULT_PROVIDER: "openrouter" })).toBeNull();
    expect(
      createDeploymentEmbedder({ PI_DEFAULT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }),
    ).toBeNull();
  });

  it("throws on an error answer so the caller falls back to words", async () => {
    const embedder = createDeploymentEmbedder(
      { PI_DEFAULT_PROVIDER: "openai", OPENAI_API_KEY: "k" },
      async () => new Response("no", { status: 402 }),
    );
    await expect(embedder!.embed(["a"])).rejects.toThrow("402");
  });
});
