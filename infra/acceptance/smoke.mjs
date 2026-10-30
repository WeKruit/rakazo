#!/usr/bin/env node
// Release smoke check against a running deployment, through every public host.
//
//   RAKAZO_URL=<hosting URL> RAKAZO_ORIGIN=<custom domain origin> \
//   [RAKAZO_EXPECT_SHA=<40-hex>] [RAKAZO_EMAIL=… RAKAZO_PASSWORD=…] \
//   node infra/acceptance/smoke.mjs [--wait 60]
//
// Each host must serve the app page, the sign-in page, readiness, health and an RPC answer
// that is not a refusal. With --wait, failing checks are retried until the deadline, so the
// same command gates a fresh revision while it comes up. Exit 0 = pass, 1 = fail, 2 = usage.
// Read-only: no data is written, and secrets are never printed.

const args = process.argv.slice(2);
const waitIndex = args.indexOf("--wait");
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 0;
const bases = [process.env.RAKAZO_URL, process.env.RAKAZO_ORIGIN]
  .map((value) => value?.trim().replace(/\/$/, ""))
  .filter(Boolean);
const origin = (process.env.RAKAZO_ORIGIN ?? process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const expectSha = process.env.RAKAZO_EXPECT_SHA?.trim();
if (!bases.length || !Number.isFinite(waitSeconds) || waitSeconds < 0) {
  console.error(
    "Usage: RAKAZO_URL=… [RAKAZO_ORIGIN=…] node infra/acceptance/smoke.mjs [--wait SECONDS]",
  );
  process.exit(2);
}
if (expectSha && !/^[0-9a-f]{40}$/.test(expectSha)) {
  console.error("RAKAZO_EXPECT_SHA must be a full commit SHA");
  process.exit(2);
}

const timeout = () => AbortSignal.timeout(10_000);
const html = async (response) =>
  response.status === 200 && /<html/i.test(await response.text())
    ? ""
    : `status ${response.status}`;

function checksFor(base) {
  const host = new URL(base).host;
  const list = [
    [
      `${host} /`,
      async () =>
        html(await fetch(`${base}/`, { headers: { accept: "text/html" }, signal: timeout() })),
    ],
    [
      `${host} /sign-in`,
      async () =>
        html(
          await fetch(`${base}/sign-in`, { headers: { accept: "text/html" }, signal: timeout() }),
        ),
    ],
    [
      `${host} /health`,
      async () => {
        const r = await fetch(`${base}/health`, { signal: timeout() });
        return r.status === 200 ? "" : `status ${r.status}`;
      },
    ],
    [
      `${host} /ready`,
      async () => {
        const r = await fetch(`${base}/ready`, { signal: timeout() });
        if (r.status !== 200) return `status ${r.status}`;
        const revision = r.headers.get("x-rakazo-revision");
        return expectSha && revision !== expectSha ? `revision ${revision ?? "missing"}` : "";
      },
    ],
    // Signed out, an RPC answers 401. A 403 or 5xx means the request never reached the app.
    [
      `${host} rpc`,
      async () => {
        const r = await fetch(`${base}/rpc/me`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: "{}",
          signal: timeout(),
        });
        return r.status === 200 || r.status === 401 ? "" : `status ${r.status}`;
      },
    ],
    // A malformed sign-in from the public origin is a 400 from auth, not a cross-site refusal.
    // A 429 is auth's own rate limit after earlier smoke runs: the request still reached auth.
    [
      `${host} sign-in origin`,
      async () => {
        const r = await fetch(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: "nobody@example.com" }),
          signal: timeout(),
        });
        return r.status === 400 || r.status === 429 ? "" : `status ${r.status}`;
      },
    ],
  ];
  if (process.env.RAKAZO_EMAIL && process.env.RAKAZO_PASSWORD)
    list.push([
      `${host} signed-in rpc`,
      async () => {
        const r = await fetch(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: process.env.RAKAZO_EMAIL,
            password: process.env.RAKAZO_PASSWORD,
          }),
          signal: timeout(),
        });
        const cookie = (r.headers.getSetCookie?.() ?? [])
          .map((line) => line.split(";")[0])
          .join("; ");
        if (r.status === 429) return "";
        if (r.status !== 200 || !cookie) return `sign-in status ${r.status}`;
        const me = await fetch(`${base}/rpc/me`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: "{}",
          signal: timeout(),
        });
        return me.status === 200 ? "" : `rpc status ${me.status}`;
      },
    ]);
  return list;
}

const checks = bases.flatMap(checksFor);
const failures = new Map();
const deadline = Date.now() + waitSeconds * 1000;
let pending = checks;
for (;;) {
  const results = await Promise.all(
    pending.map(async ([name, run]) => [
      name,
      await run().catch((error) => String(error?.cause?.code ?? error?.message ?? error)),
    ]),
  );
  failures.clear();
  for (const [name, problem] of results) if (problem) failures.set(name, problem);
  pending = checks.filter(([name]) => failures.has(name));
  if (!pending.length || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
for (const [name] of checks) {
  const problem = failures.get(name);
  console.log(`${problem ? "FAIL" : "PASS"} ${name}${problem ? ` (${problem})` : ""}`);
}
process.exit(failures.size ? 1 : 0);
