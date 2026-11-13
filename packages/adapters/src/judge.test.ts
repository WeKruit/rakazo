import { describe, expect, it, vi } from "vitest";
import { JudgeSettings, typeSafeJudge } from "./judge.js";

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("typeSafeJudge", () => {
  it("asks one yes/no question and returns its probability", async () => {
    const fetchImpl = answer({ answers: { answer: { type: "noul", noul: 0.12 } } });
    await expect(typeSafeJudge("key", fetchImpl).yes("Refuses?", { reply: "Done." })).resolves.toBe(
      0.12,
    );
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      state: { reply: "Done." },
      questions: { answer: { type: "noul", instructions: "Refuses?" } },
    });
  });

  it("answers nothing when the service fails or returns no probability", async () => {
    await expect(typeSafeJudge("key", answer({}, 500)).yes("q", {})).resolves.toBeUndefined();
    await expect(
      typeSafeJudge("key", answer({ answers: {} })).yes("q", {}),
    ).resolves.toBeUndefined();
    const broken = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(typeSafeJudge("key", broken).yes("q", {})).resolves.toBeUndefined();
  });
});

describe("language check", () => {
  it("posts the rows in batches with the judge key and returns each verdict", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { rows } = JSON.parse(String(init?.body)) as { rows: Array<{ id: string }> };
      return new Response(
        JSON.stringify({
          verdicts: Object.fromEntries(
            rows.map((row) => [row.id, { verdict: row.id === "r1" ? "maybe" : "no sign" }]),
          ),
        }),
      );
    }) as unknown as typeof fetch;
    const judge = typeSafeJudge("key", fetchImpl, "https://check.example/");
    const rows = Array.from({ length: 45 }, (_, index) => ({
      id: `r${index}`,
      name: "Pat",
      profile: "Engineer",
    }));
    const verdicts = await judge.language?.("Mandarin", rows);
    expect(
      vi.mocked(fetchImpl).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).rows.length),
    ).toEqual([40, 5]);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://check.example/");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer key");
    const body = JSON.parse(String(init?.body));
    expect(body.requirement).toBe("Mandarin");
    expect(body.rows[0]).toEqual({ id: "r0", name: "Pat", profile: "Engineer" });
    // An unknown verdict is no verdict.
    expect(verdicts?.size).toBe(44);
    expect(verdicts?.get("r1")).toBeUndefined();
    expect(typeSafeJudge("key", fetchImpl).language).toBeUndefined();
    const failed = await typeSafeJudge("key", answer({}, 502), "https://check.example/").language?.(
      "Mandarin",
      rows,
    );
    expect(failed?.size).toBe(0);
  });
});

describe("JudgeSettings", () => {
  const secrets = {
    load: vi.fn(async (ciphertext: string) => ciphertext.replace("sealed:", "")),
    put: vi.fn(async (plaintext: string) => ({ ciphertext: `sealed:${plaintext}` })),
  };
  it("is absent until the owner saves a key that answers, then resolves it", async () => {
    let row: { id: string; ciphertext: string } | null = null;
    const prisma = {
      integrationProviderConfig: {
        findUnique: vi.fn(async () => row),
        upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
          row = create;
          return create;
        }),
      },
    };
    const yes = vi.fn(async () => 0.9 as number | undefined);
    const settings = new JudgeSettings(prisma as never, secrets as never, () => ({ yes }));
    await expect(settings.resolve()).resolves.toBeUndefined();
    yes.mockResolvedValueOnce(undefined);
    await expect(
      settings.save({ provider: "typesafe", apiKey: "bad" }, {} as never),
    ).rejects.toThrow();
    expect(row).toBeNull();
    await settings.save({ provider: "typesafe", apiKey: "good" }, {} as never);
    expect(row).toMatchObject({ id: "judge:typesafe" });
    await expect(settings.resolve()).resolves.toMatchObject({ yes });
  });

  it("keeps the saved key when only the language check changes, and refuses a check that does not answer", async () => {
    let row: { id: string; ciphertext: string } | null = null;
    const prisma = {
      integrationProviderConfig: {
        findUnique: vi.fn(async () => row),
        upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
          row = create;
          return create;
        }),
      },
    };
    const language = vi.fn(async () => new Map([["probe", "shown" as const]]));
    const settings = new JudgeSettings(prisma as never, secrets as never, (config) => ({
      yes: async () => 0.9,
      ...(config.languageUrl ? { language } : {}),
    }));
    await expect(settings.save({ provider: "typesafe" }, {} as never)).rejects.toThrow();
    await settings.save({ provider: "typesafe", apiKey: "good" }, {} as never);
    language.mockResolvedValueOnce(new Map());
    await expect(
      settings.save({ provider: "typesafe", languageUrl: "https://check.example/" }, {} as never),
    ).rejects.toThrow();
    expect(JSON.parse(row!.ciphertext.replace("sealed:", ""))).toEqual({
      provider: "typesafe",
      apiKey: "good",
    });
    await settings.save(
      { provider: "typesafe", languageUrl: "https://check.example/" },
      {} as never,
    );
    expect(JSON.parse(row!.ciphertext.replace("sealed:", ""))).toEqual({
      provider: "typesafe",
      apiKey: "good",
      languageUrl: "https://check.example/",
    });
  });
});
