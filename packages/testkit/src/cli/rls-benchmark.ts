// Compare the same synthetic artifact RPC with the first-batch actor database off/on.
// Requires the local account-isolation fixture and the explicit RLS policy/role setup.
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const databaseUrl = process.env.RLS_BENCH_DATABASE_URL;
const actorUrl = process.env.RLS_BENCH_ACTOR_DATABASE_URL;
for (const value of [databaseUrl, actorUrl]) {
  const target = new URL(value ?? "invalid:");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/rakazo_a2_api_rls"
  ) {
    throw new Error("Benchmark requires the dedicated local synthetic RLS database");
  }
}
const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-rls-bench-"));
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  REALTIME_DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WAKEUP_DRIVER: "memory",
  SANDBOX_PROVIDER: "fake",
  AGENT_RUNTIME: "scripted",
  CLOUD_AGENT_PROVIDER: "emulator",
  COMPOSIO_API_KEY: "",
  OPENROUTER_API_KEY: "",
  MODEL_API_KEY: "",
  BETTER_AUTH_SECRET: "test-secret-test-secret-32chars!",
  ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
  SANDBOX_SUPERVISOR_TOKEN: "test-supervisor-token-test-32chars",
  SCREEN_PROXY_SECRET: "test-screen-proxy-secret-test-32chars",
  DATA_DIR: dataDir,
  SIGNUPS_ENABLED: "false",
  SIGNUP_ALLOWLIST: "",
  CI: "1",
});
const [{ createApp }, { ComposioEmulator, EmailEmulator }, { serve }] = await Promise.all([
  import("../../../../apps/api/src/app.js"),
  import("@rakazo/adapters"),
  import("@hono/node-server"),
]);
const results = [];
try {
  for (const [sample, mode] of (
    ["baseline", "rls", "rls", "baseline", "baseline", "rls"] as const
  ).entries()) {
    // A fixed local port keeps Better Auth's configured origin equal to the served one.
    const origin = "http://127.0.0.1:3194";
    Object.assign(process.env, {
      ACTOR_DATABASE_URL: mode === "rls" ? actorUrl : "",
      BETTER_AUTH_URL: origin,
      WEB_ORIGIN: origin,
      API_URL: origin,
    });
    const handles = await createApp({
      composio: new ComposioEmulator(),
      email: new EmailEmulator(),
      integrationsCatalogUrl: "https://catalog.example.test/",
    });
    const users = await handles.prisma.user.findMany({ select: { email: true } });
    if (
      users.length !== 2 ||
      users.some((user) => !["a@isolation.test", "b@isolation.test"].includes(user.email))
    ) {
      await handles.stop();
      throw new Error("Benchmark requires exactly the two synthetic isolation fixture users");
    }
    const server = serve({ fetch: handles.app.fetch, port: 3194, hostname: "127.0.0.1" });
    try {
      if (!(server.address() as AddressInfo | null))
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "a@isolation.test", password: "local-isolation-password-a" }),
      });
      if (!signIn.ok) throw new Error(`Synthetic sign-in failed: ${signIn.status}`);
      const cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
      const read = async () => {
        const start = performance.now();
        const response = await fetch(`${origin}/rpc/artifacts/listSpace`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ json: { limit: 60 } }),
        });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`Synthetic RPC failed: ${response.status}`);
        return performance.now() - start;
      };
      for (let index = 0; index < 20; index++) await read();
      const timings: number[] = [];
      for (let index = 0; index < 200; index += 5)
        timings.push(...(await Promise.all(Array.from({ length: 5 }, read))));
      timings.sort((a, b) => a - b);
      results.push({
        sample: sample + 1,
        mode,
        warmup: 20,
        requests: 200,
        concurrency: 5,
        p50Ms: +timings[99]!.toFixed(2),
        p95Ms: +timings[189]!.toFixed(2),
        maxMs: +timings[199]!.toFixed(2),
        errors: 0,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handles.stop();
    }
  }
  console.log(`RLS_BENCH ${JSON.stringify(results)}`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
