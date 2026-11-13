// Local-only capture of the exact model requests a fresh recruiting account sends. Not committed.
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { describe, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const origin = "http://127.0.0.1:5173";
const OUT = process.env.CAPTURE_OUT ?? "/tmp/capture";

describe.skipIf(process.env.VERIFY_DATABASE !== "1")("capture", () => {
  it("captures", async () => {
    await mkdir(OUT, { recursive: true });
    let n = 0;
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        n += 1;
        const sys = String(body.messages?.find((m: { role: string }) => m.role === "system" || m.role === "developer")?.content ?? "");
        const toolNames: string[] = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
        const lastUser = [...(body.messages ?? [])].reverse().find((m: { role: string }) => m.role === "user");
        const lastText = JSON.stringify(lastUser?.content ?? "");
        const label = `${String(n).padStart(2, "0")}`;
        await writeFile(path.join(OUT, `${label}.json`), JSON.stringify(body, null, 2));
        console.log("REQ", label, "sysChars", sys.length, "tools", toolNames.length, "last", lastText.slice(0, 80));
        let reply: { tool?: { name: string; args: unknown }; text?: string } = { text: "好的。" };
        if (toolNames.includes("start_role") && lastText.includes("JD") && !globalThis.__started) {
          (globalThis as Record<string, unknown>).__started = true;
          reply = { tool: { name: "start_role", args: { title: "Automation Equipment Maintenance Engineer" } } };
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (delta: unknown, fin: string | null = null) =>
          res.write(`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`);
        emit({ role: "assistant" });
        if (reply.tool) {
          emit({ tool_calls: [{ index: 0, id: `call${n}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] });
          emit({}, "tool_calls");
        } else {
          emit({ content: reply.text });
          emit({}, "stop");
        }
        res.end("data: [DONE]\n\n");
      })().catch((e) => {
        console.error(e);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-capture-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-model-fixture-encryption-key",
    });
    const app = handles.app;
    const signup = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: `cap-${randomUUID()}@rakazo.test`, password: "password12", name: "Recruiter" }),
    });
    const cookie = sessionCookieHeader(signup);
    await rpc(app, cookie, "models/connect", { provider: "openai-compatible", modelId: "capture", baseUrl, apiKey: "k", contextWindow: 400_000, maxTokens: 4096 });
    const ws = await rpc<{ botId: string; groupId: string }>(app, cookie, "onboarding/ensureRecruiting", {});
    const bots = await handles.prisma.bot.findMany({ select: { id: true, name: true } });
    for (const b of bots) await rpc(app, cookie, "bots/update", { botId: b.id, modelProvider: "openai-compatible", modelId: "capture" });
    const groups = await handles.prisma.chatGroup.findMany({ select: { id: true, name: true } });
    console.log("GROUPS", JSON.stringify(groups), "WS", JSON.stringify(ws), "BOTS", JSON.stringify(bots));
    const global = groups.find((g) => g.id.startsWith("recruiting-global-")) ?? groups.find((g) => g.name === "Kruit");
    const wait = async (ms: number) => new Promise((r) => setTimeout(r, ms));
    const settle = async () => {
      for (let i = 0; i < 120; i++) {
        const active = await handles.prisma.run.count({ where: { status: { in: ["queued", "running", "pending"] } } }).catch(() => 0);
        if (!active) return;
        await wait(500);
      }
    };
    await settle();
    // 1) Kruit global: a status question
    await rpc(app, cookie, "threads/send", { groupId: global!.id, text: "现在几个岗位一共发送了多少人呢" });
    await settle();
    // 2) Kruit global: a new role with a JD -> start_role -> the role team's first run
    await rpc(app, cookie, "threads/send", {
      groupId: global!.id,
      text: "新岗位 JD：Automation Equipment Maintenance Engineer, Fremont CA, onsite. 5+ years maintaining automated production equipment (PLC, robotics). Mandarin required. $120-150k.",
    });
    await settle();
    await wait(3000);
    await settle();
    const after = await handles.prisma.chatGroup.findMany({ select: { id: true, name: true } });
    const role = after.find((g) => !groups.some((o) => o.id === g.id));
    console.log("ROLE GROUP", JSON.stringify(role));
    if (role) {
      await rpc(app, cookie, "threads/send", { groupId: role.id, text: "现在发送了多少人呢" });
      await settle();
    }
    const runs = await handles.prisma.run.findMany({ select: { id: true, botId: true, status: true, trigger: true, error: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    await writeFile(path.join(OUT, "runs.json"), JSON.stringify({ runs, bots, groups: after }, null, 2));
    await handles.stop();
    server.close();
  }, 600_000);
});

async function rpc<T>(app: App, cookie: string, procedure: string, input: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error) throw new Error(`${procedure}: ${body.error?.message ?? response.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.json as T;
}

declare global {
  // eslint-disable-next-line no-var
  var __started: boolean | undefined;
}
