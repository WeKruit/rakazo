import { describe, expect, it, vi } from "vitest";
import { JudgeSettings, typeSafeJudge } from "./judge.js";
import { criteriaAssessment } from "./recruiting-criteria-check.js";

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

  it("judges one person on every requirement in one request", async () => {
    const fetchImpl = answer({
      answers: {
        q0: { choice: "strong", confidence: 0.9, probabilities: { opposite: 0.01 } },
        q1: { choice: "opposite", confidence: 0.93, probabilities: { opposite: 0.93 } },
      },
    });
    const verdicts = await typeSafeJudge("key", fetchImpl).criteria?.({ profile: "Spark" }, [
      { id: "spark", statement: "hands-on Spark" },
      { id: "city", statement: "lives in Shanghai" },
    ]);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    expect(verdicts?.get("spark")).toEqual({ level: "strong", confidence: 0.9, against: 0.01 });
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

  it("writes the verdicts as the assessment lines Results reads", () => {
    expect(
      criteriaAssessment([
        { statement: "Location: Shanghai", level: "strong" },
        { statement: "years: 5+; Spark", level: "silent" },
        { statement: "too managerial", level: "strong", avoid: true },
        { statement: "no Kafka", level: "opposite", avoid: true },
      ]),
    ).toBe("Met - Location: Shanghai\nUnknown - years: 5+; Spark\nGap - no Kafka");
  });
});
