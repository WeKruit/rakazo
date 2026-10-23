import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port; a reverse proxy adds forwarding headers, so a request that
 * carries them came through the public edge and gets no details.
 */
export function healthRoutes(
  details: () => Record<string, unknown>,
  checkReady?: () => Promise<unknown>,
) {
  // A timed-out database call may still be pending in the driver. Share it until it
  // settles so repeated probes cannot fill the connection pool during an outage.
  let pending: Promise<boolean> | undefined;
  async function ready() {
    if (!checkReady) return true;
    pending ??= Promise.resolve()
      .then(checkReady)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        pending = undefined;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const app = new Hono();
  app.get("/ready", async (c) => {
    c.header("cache-control", "no-store");
    let degraded = true;
    try {
      const state = details();
      // Public source identity lets release probes reject a healthy but stale revision.
      if (
        typeof state.revision === "string" &&
        state.revision.length === 40 &&
        /^[0-9a-f]{40}$/.test(state.revision)
      )
        c.header("x-rakazo-revision", state.revision);
      degraded = state.degraded === true || !(await ready());
    } catch {
      // Readiness is public: never disclose connection details or driver errors.
    }
    return c.json({ ok: !degraded, degraded }, degraded ? 503 : 200);
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", (c) => {
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    return c.json({ ok: true, ...details() });
  });
  return app;
}
