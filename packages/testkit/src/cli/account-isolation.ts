// Runs infra/acceptance/account-isolation.mjs against a fresh local API on a throwaway Postgres.
// Account A signs up and creates an assistant, routine, open work, files, a message and a role
// through the RPC; the script then signs up B and checks neither can reach the other's data.
// Offline: scripted runtime, fake sandbox, no provider keys. Needs Docker for Postgres.

import { execSync, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp as CreateApp } from "../../../../apps/api/src/app.ts";

const port = Number(process.env.API_PORT ?? 3191);
const origin = `http://127.0.0.1:${port}`;
const container = await new PostgreSqlContainer("postgres:16-alpine").start();
let exitCode = 1;
try {
  const databaseUrl = container.getConnectionUri();
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    REALTIME_DATABASE_URL: databaseUrl,
    VERIFY_DATABASE: "1",
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
    BETTER_AUTH_URL: origin,
    WEB_ORIGIN: origin,
    API_PORT: String(port),
    API_URL: origin,
    DATA_DIR: await mkdtemp(path.join(os.tmpdir(), "rakazo-isolation-")),
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    CI: "1",
  });
  execSync("pnpm --filter @rakazo/db generate", { stdio: "ignore", env: process.env });
  execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
    stdio: "ignore",
    env: process.env,
    cwd: path.resolve("packages/db"),
  });
  const [{ ComposioEmulator, EmailEmulator }, { createApp }, { serve }] = await Promise.all([
    import("@rakazo/adapters"),
    import("../../../../apps/api/src/app.ts") as Promise<{ createApp: typeof CreateApp }>,
    import("@hono/node-server"),
  ]);
  const handles = await createApp({
    databaseUrl,
    prisma: undefined,
    composio: new ComposioEmulator(),
    email: new EmailEmulator(),
    integrationsCatalogUrl: "https://catalog.example.test/",
  });
  const server = serve({
    fetch: (request) => handles.app.fetch(request),
    port,
    hostname: "127.0.0.1",
  });
  try {
    const password = "local-isolation-password-a";
    await seedAccount("a@isolation.test", password);
    // The script must run in its own process: the API serves its requests from this one.
    exitCode = await new Promise<number>((resolve) => {
      spawn(
        process.execPath,
        ["infra/acceptance/account-isolation.mjs", ...process.argv.slice(2)],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            RAKAZO_URL: origin,
            RAKAZO_EMAIL: "a@isolation.test",
            RAKAZO_PASSWORD: password,
            RAKAZO_B_EMAIL: "b@isolation.test",
          },
        },
      ).on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handles.stop().catch(() => undefined);
  }
} finally {
  await container.stop().catch(() => undefined);
}
process.exit(exitCode);

async function seedAccount(email: string, password: string) {
  let cookie = "";
  async function post(route: string, body: unknown) {
    const response = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = response.headers.getSetCookie();
    if (set.length) cookie = set.map((line) => line.split(";")[0]).join("; ");
    const json = (await response.json().catch(() => null)) as { json?: unknown } | null;
    if (!response.ok) throw new Error(`${route} ${response.status}`);
    return (json && "json" in json ? json.json : json) as Record<string, never>;
  }
  const rpc = (procedure: string, input: unknown = {}) =>
    post(`/rpc/${procedure}`, { json: input }) as Promise<Record<string, unknown>>;
  await post("/api/auth/sign-up/email", { email, password, name: "Isolation A" });
  const crew = (await rpc("onboarding/ensureRecruiting")) as { groupId: string };
  const bot = (await rpc("bots/create", {
    name: "A helper",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  })) as { id: string };
  await rpc("routines/create", {
    botId: bot.id,
    name: "A routine",
    prompt: "A only",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  });
  await rpc("scratchpad/create", { botId: bot.id, title: "A open work" });
  const file = (name: string) => ({
    name,
    mimeType: "text/plain",
    contentBase64: Buffer.from(`${name} belongs to A`).toString("base64"),
  });
  await rpc("artifacts/create", { botId: bot.id, ...file("a-notes.txt") });
  await rpc("artifacts/create", { groupId: crew.groupId, ...file("a-jd.txt") });
  await rpc("threads/send", { groupId: crew.groupId, text: "新岗位：仓库运营经理（亚特兰大）" });
  const head = (await rpc("threads/head", { groupId: crew.groupId })) as { threadId: string };
  const page = (await rpc("threads/messages", { groupId: crew.groupId })) as {
    messages: Array<{ id: string; role: string }>;
  };
  const message = page.messages.find((item) => item.role === "user");
  if (!message) throw new Error("A's message was not saved");
  await rpc("recruiting/createRole", {
    title: "A role",
    sourceRefs: [
      {
        id: "source",
        kind: "original_material",
        anchor: { kind: "message", messageId: message.id, locator: "body" },
        readState: "unread",
        readAt: null,
      },
    ],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
    sourceThreadId: head.threadId,
    expectedRevision: 0,
  });
}
