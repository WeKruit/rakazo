import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyFixture } from "./evals/history-fixtures.js";
import { runTrial } from "./evals/runner.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("short original product history", () => {
  it.each(["snapshots", "cache-aware"] as const)(
    "reuses 100 short originals over three turns with %s without lookup or compaction",
    async (strategy) => {
      const fixture = historyFixture(100, "exact");
      const questions = [
        fixture.ask,
        "Repeat the Aurora calibration label.",
        "Repeat the label and pending approval constraint.",
      ];
      const fixtureKey = "synthetic-short-history-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        // 100 originals plus a turn correctly queue background history compaction. The
        // summary copies the compacted constraints verbatim, as the summary template requires.
        compactionSummary: [
          "The calibration label for the Aurora export project is ORBIT-731.",
          "Aurora exports use the batch size 37; never change it without explicit approval.",
          "Batching is proposed; approval remains pending. No changes deployed.",
        ].join("\n"),
        steps: questions.map((question) => ({
          expect(request) {
            const wire = JSON.stringify(request.messages);
            expect(wire).toContain("ORBIT-731");
            expect(wire).toContain("never change it without explicit approval");
            expect(wire).toContain("approval remains pending");
            expect(wire).toContain(question);
            expect(wire).not.toContain("Historical navigation snapshots");
          },
          response: { type: "text" as const, text: "ORBIT-731. Batch size 37; approval pending." },
        })),
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-short-history-"));
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const result = await runTrial(
          {
            id: `synthetic-short-history-${strategy}`,
            purpose: "Reuse already-short originals without inference preparation.",
            history: fixture,
            connections: [],
            steps: questions.map((ask) => ({ ask })),
            grade: (evidence) => [
              { id: "original-label", pass: evidence.text.includes("ORBIT-731") },
            ],
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: fixtureKey,
              contextWindow: 1_000_000,
              maxTokens: 4096,
            },
            timeoutMs: 30_000,
            maxToolCalls: 0,
            createApp: (composio) =>
              createApp({
                databaseUrl: process.env.DATABASE_URL!,
                realtimeDatabaseUrl: process.env.DATABASE_URL!,
                authUrl: "http://127.0.0.1:5173",
                webOrigin: "http://127.0.0.1:5173",
                dataDir,
                sandboxProvider: "fake",
                agentRuntime: "pi",
                contextStrategy: strategy,
                wakeupDriver: "memory",
                signupsEnabled: "true",
                composio,
                encryptionKey: "synthetic-short-history-encryption-key",
              }),
          },
        );
        model.assertComplete();
        expect(result).toMatchObject({
          status: "passed",
          toolCalls: 0,
          // Usage accounting includes background compaction calls.
          modelCalls: 3 + model.compactions.length,
          cleanupFailed: false,
        });
        expect(model.requests.length - model.compactions.length).toBe(3);
        for (const compaction of model.compactions) {
          const transcript = JSON.stringify(compaction.messages);
          expect(transcript).toContain("ORBIT-731");
          expect(transcript).toContain("never change it without explicit approval");
        }
        expect(result.historyPreparationState?.generation).toBe(0);
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
