import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@rakazo/contracts";
import { LOCAL_SETTINGS_PAGE, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import {
  collectContactPages,
  collectListPages,
  collectNavigationPages,
  collectOffsetListPages,
  isOffsetListRpc,
} from "@rakazo/core";
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
const WRITE_PREFIX =
  /^(set|save|approve|confirm|edit|create|update|delete|remove|archive|restore|sync|bind|send|record)/i;
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

const rawClient: ContractRouterClient<AppContract, RpcClientContext> = createORPCClient(link);
function withOffsetLists<T extends object>(target: T, path: string[] = []): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof property !== "string") return value;
      const next = [...path, property];
      const key = next.join("/");
      if (isOffsetListRpc(key) && typeof value === "function")
        return (
          input?: Record<string, unknown>,
          options?: { signal?: AbortSignal; context?: RpcClientContext },
        ) => {
          if (input?.offset !== undefined) return value(input, options);
          const context = {
            ...options?.context,
            spaceId: options?.context?.spaceId ?? selectedSpaceId(),
          };
          return collectOffsetListPages(key, (offset) =>
            value({ ...input, offset }, { ...options, context }),
          );
        };
      return value && (typeof value === "object" || typeof value === "function")
        ? withOffsetLists(value, next)
        : value;
    },
  });
}
const client = withOffsetLists(rawClient);
// Keep existing callers' all-items contract while each network response stays bounded.
export const rpc: typeof client = new Proxy(client, {
  get(target, namespace, receiver) {
    if (namespace === "recruiting")
      return new Proxy(target.recruiting, {
        get(procedures, method, procedureReceiver) {
          if (method !== "correspondence")
            return Reflect.get(procedures, method, procedureReceiver);
          return (
            input: Parameters<typeof client.recruiting.correspondence>[0],
            options?: Parameters<typeof client.recruiting.correspondence>[1],
          ) => {
            if (input.view !== "contacts" || input.cursor !== undefined)
              return procedures.correspondence(input, options);
            const context = {
              ...options?.context,
              spaceId: options?.context?.spaceId ?? selectedSpaceId(),
            };
            return collectContactPages((cursor) =>
              procedures.correspondence({ ...input, cursor }, { ...options, context }),
            );
          };
        },
      });
    if (namespace === "bootstrap")
      return (
        input: Parameters<typeof client.bootstrap>[0],
        options?: Parameters<typeof client.bootstrap>[1],
      ) => {
        const context = {
          ...options?.context,
          spaceId: options?.context?.spaceId ?? selectedSpaceId(),
        };
        return collectNavigationPages((offset) =>
          client.bootstrap({ ...input, offset }, { ...options, context }),
        );
      };
    if (namespace === "spaces")
      return new Proxy(target.spaces, {
        get(procedures, method, procedureReceiver) {
          if (method !== "list") return Reflect.get(procedures, method, procedureReceiver);
          return (_input?: unknown, options?: Parameters<typeof client.spaces.list>[1]) => {
            const context = {
              ...options?.context,
              spaceId: options?.context?.spaceId ?? selectedSpaceId(),
            };
            return collectNavigationPages((offset) =>
              client.spaces.list({ offset }, { ...options, context }),
            );
          };
        },
      });
    if (namespace !== "bots" && namespace !== "groups")
      return Reflect.get(target, namespace, receiver);
    return new Proxy(target[namespace], {
      get(procedures, method, procedureReceiver) {
        if (method !== "list" && method !== "listArchived")
          return Reflect.get(procedures, method, procedureReceiver);
        return (
          _input?: unknown,
          options?: { signal?: AbortSignal; context?: RpcClientContext },
        ) => {
          const context = {
            ...options?.context,
            spaceId: options?.context?.spaceId ?? selectedSpaceId(),
          };
          return collectListPages<unknown>(async (offset) =>
            procedures.page(
              { offset, archived: method === "listArchived" },
              { ...options, context },
            ),
          );
        };
      },
    });
  },
});
