import assert from "node:assert/strict";
import { test } from "node:test";
import { routeTestToken } from "./workloop-browser.mjs";

test("browser bearer routing is same-origin and cannot follow an authenticated redirect", async () => {
  let matcher;
  let handler;
  await routeTestToken(
    {
      route: async (match, handle) => {
        matcher = match;
        handler = handle;
      },
    },
    "https://app.example",
    "test-token",
  );
  assert.equal(matcher(new URL("https://app.example/rpc/threads/get")), true);
  assert.equal(matcher(new URL("https://third.example/rpc/threads/get")), false);
  assert.equal(matcher(new URL("https://app.example/assets/test.js")), false);
  let options;
  const response = { status: () => 302 };
  await handler({
    request: () => ({ headers: () => ({ accept: "application/json" }) }),
    fetch: async (input) => {
      options = input;
      return response;
    },
    fulfill: async (input) => assert.equal(input.response, response),
  });
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.headers.authorization, "Bearer test-token");
});
