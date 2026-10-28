import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Read-only health. Draining is initiated by SIGUSR2 through the container operator. */
export async function startWorkerHealth(
  state: () => "ready" | "draining" | "drained" | "failed",
  port: number,
  host = "0.0.0.0",
  identity?: { instanceId: string; generation: string; service: string },
) {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !["/health", "/ready", "/drain"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    const current = state();
    const ok = current !== "failed" && (request.url !== "/ready" || current === "ready");
    response
      .writeHead(ok ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify({ ok, state: current, ...(identity ? { identity } : {}) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
