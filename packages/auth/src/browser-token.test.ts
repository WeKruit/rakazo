import { describe, expect, it } from "vitest";
import { withoutBrowserToken } from "./browser-token.js";

function signInResponse() {
  return new Response(JSON.stringify({ token: "secret-token", user: { id: "u1" } }), {
    headers: {
      "content-type": "application/json",
      "set-auth-token": "secret-token",
      "access-control-expose-headers": "set-auth-token, x-other",
      "set-cookie": "better-auth.session_token=secret-token; HttpOnly",
    },
  });
}

describe("withoutBrowserToken", () => {
  it("drops the bearer token for a browser and keeps the HttpOnly cookie", async () => {
    const request = new Request("https://app.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: "https://app.test" },
    });
    const response = await withoutBrowserToken(request, signInResponse());
    expect(await response.json()).toEqual({ user: { id: "u1" } });
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe("x-other");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("drops a nested session token and keeps a null token (verification pending)", async () => {
    const request = new Request("https://app.test/x", { headers: { "sec-fetch-mode": "cors" } });
    const nested = await withoutBrowserToken(
      request,
      Response.json({ session: { id: "s1", token: "t" } }),
    );
    expect(await nested.json()).toEqual({ session: { id: "s1" } });
    const pending = await withoutBrowserToken(request, Response.json({ token: null }));
    expect(await pending.json()).toEqual({ token: null });
  });

  it("leaves native app responses untouched", async () => {
    const request = new Request("https://app.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: "rakazo://" },
    });
    const response = await withoutBrowserToken(request, signInResponse());
    expect(await response.json()).toEqual({ token: "secret-token", user: { id: "u1" } });
    expect(response.headers.get("set-auth-token")).toBe("secret-token");
  });
});
