import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@rakazo/contracts";
import { LOCAL_SETTINGS_PAGE, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import { desktopBridge } from "./desktop";

const SPACE_STORAGE_KEY = "rakazo:space-id";

type RpcClientContext = { spaceId?: string | null };

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function subscribeSpaceSelection(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SPACE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function selectSpace(id: string): boolean {
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    return true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      return window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      return false;
    }
  }
}

export function clearSpaceSelection(): void {
  try {
    window.localStorage.removeItem(SPACE_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-rakazo-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  else headers.delete("x-rakazo-space-id");
  return headers;
}

/** Recruiting reads in flight at once; the rest wait so one page load cannot drain the API's DB pool. */
export const RECRUITING_READ_LIMIT = 4;
const WRITE_PREFIX = /^(set|save|approve|confirm|edit|create|update|delete|remove|archive|restore|sync|bind|send|record)/i;
let recruitingReadsInFlight = 0;
const recruitingReadQueue: Array<() => void> = [];

/** Whether a request path is a recruiting read that shares the page's concurrency budget. */
export function isRecruitingRead(pathname: string): boolean {
  const match = /\/rpc\/recruiting\/(.+)$/.exec(pathname);
  const name = match?.[1]?.split("/").pop();
  return Boolean(name && !WRITE_PREFIX.test(name));
}

/** Runs `call` once a recruiting read slot is free; an abort while waiting skips the request. */
export async function withRecruitingReadSlot<T>(
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  if (recruitingReadsInFlight >= RECRUITING_READ_LIMIT) {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = recruitingReadQueue.indexOf(start);
        if (index >= 0) recruitingReadQueue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      recruitingReadQueue.push(start);
    });
  }
  recruitingReadsInFlight += 1;
  try {
    return await call();
  } finally {
    recruitingReadsInFlight -= 1;
    recruitingReadQueue.shift()?.();
  }
}

const link = new RPCLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined"
      ? "http://127.0.0.1:5173/rpc"
      : `${window.location.origin}${window.location.pathname === LOCAL_SETTINGS_PAGE ? LOCAL_SETTINGS_RPC : "/rpc"}`,
  fetch: async (input, init, options) => {
    const request = new Request(input, init);
    if (typeof window !== "undefined" && window.location.pathname === LOCAL_SETTINGS_PAGE) {
      const bridge = desktopBridge()?.localSettings;
      if (!bridge) throw new Error("Local settings require the desktop app");
      const result = await bridge.request(new URL(request.url).pathname, await request.text());
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const headers = withSpaceHeaders(request.headers, spaceId);
    if (!headers.has("x-request-id")) headers.set("x-request-id", crypto.randomUUID());
    const send = () => {
      started = performance.now();
      return fetch(request, { headers, credentials: "include" });
    };
    let started = performance.now();
    const response = isRecruitingRead(new URL(request.url).pathname)
      ? await withRecruitingReadSlot(request.signal, send)
      : await send();
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      const traceparent = response.headers.get("traceparent");
      console.error(
        "RPC request failed",
        JSON.stringify({
          method: request.method,
          pathname: new URL(request.url).pathname,
          status: response.status,
          contentType: response.headers.get("content-type"),
          timestamp: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          "sent-x-request-id": headers.get("x-request-id"),
          ...(requestId ? { "x-request-id": requestId } : {}),
          ...(traceparent ? { traceparent } : {}),
        }),
      );
    }
    return response;
  },
});

export const rpc: ContractRouterClient<AppContract, RpcClientContext> = createORPCClient(link);
