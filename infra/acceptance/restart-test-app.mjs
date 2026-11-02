// Stops the test environment's one container the way a crash or a recreate deploy does, then waits
// until a fresh container serves /ready. Only the test app can be named here, so a run pointed at
// production can never restart it. Needs the modal CLI and MODAL_TOKEN_ID/MODAL_TOKEN_SECRET.
import { execFileSync } from "node:child_process";

const APP = "wekruit-recruiting-test";
const env = { ...process.env, MODAL_ENVIRONMENT: "test" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const containers = () =>
  JSON.parse(execFileSync("modal", ["container", "list", "--json"], { env, encoding: "utf8" }))
    .filter((container) => container.app_name === APP)
    .map((container) => container.container_id);

async function ready(url) {
  try {
    const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Resolves with the restart's length once a new container answers /ready; throws after the limit. */
export async function restartTestApp(url, { limitMs = 4 * 60_000 } = {}) {
  const before = containers();
  if (before.length !== 1) throw new Error(`expected one test container, found ${before.length}`);
  const stoppedAt = Date.now();
  execFileSync("modal", ["container", "stop", "-y", before[0]], { env, stdio: "ignore" });
  while (Date.now() - stoppedAt < limitMs) {
    await sleep(3_000);
    const now = containers();
    if (now.length && !now.includes(before[0]) && (await ready(url)))
      return { seconds: Math.round((Date.now() - stoppedAt) / 1000) };
  }
  throw new Error(`no new test container served /ready within ${limitMs / 1000} s`);
}
