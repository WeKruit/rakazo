import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSpaceSelection, selectedSpaceId, selectSpace } from "./rpc.js";

const transport = vi.hoisted(() =>
  vi.fn<
    (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      options: { context: { spaceId?: string | null } },
    ) => Promise<Response>
  >(),
);
vi.mock("@orpc/client/fetch", () => ({
  RPCLink: class {
    constructor(options: { fetch: typeof transport }) {
      transport.mockImplementation(options.fetch);
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([200, 503])(
  "preserves the HTTP response and logs only safe metadata for status %s",
  async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = new Response("private-response-body", {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-example",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        "set-cookie": "private-response-cookie",
        authorization: "private-response-token",
      },
    });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    const request = new Request(
      "https://example.test/rpc/recruiting/listCandidates?secret=private-query",
      {
        method: "POST",
        headers: { authorization: "Bearer private-token", cookie: "private-cookie" },
        body: "private-request-body",
        signal: abort.signal,
      },
    );
    const returned = await transport(request, undefined, { context: { spaceId: "private-space" } });
    expect(returned).toBe(response);
    expect(returned.bodyUsed).toBe(false);
    const [sent, init] = fetch.mock.calls[0]! as unknown as [Request, RequestInit];
    expect(sent.url).toBe(request.url);
    expect(await sent.clone().text()).toBe("private-request-body");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-token");
    expect(new Headers(init.headers).get("cookie")).toBe("private-cookie");
    expect(new Headers(init.headers).get("x-rakazo-space-id")).toBe("private-space");
    abort.abort();
    expect(sent.signal.aborted).toBe(true);
    if (status === 200) expect(log).not.toHaveBeenCalled();
    else {
      expect(log).toHaveBeenCalledExactlyOnceWith("RPC request failed", {
        method: "POST",
        pathname: "/rpc/recruiting/listCandidates",
        status: 503,
        contentType: "application/json",
        "x-request-id": "request-example",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    }
  },
);

describe("space selection storage", () => {
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("rakazo:space-id", "space-support");
  });
});
