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
    const response = await fetch(request, {
      headers: withSpaceHeaders(request.headers, spaceId),
      credentials: "include",
    });
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      const traceparent = response.headers.get("traceparent");
      console.error("RPC request failed", {
        method: request.method,
        pathname: new URL(request.url).pathname,
        status: response.status,
        contentType: response.headers.get("content-type"),
        ...(requestId ? { "x-request-id": requestId } : {}),
        ...(traceparent ? { traceparent } : {}),
      });
    }
    return response;
  },
});

export const rpc: ContractRouterClient<AppContract, RpcClientContext> = createORPCClient(link);
