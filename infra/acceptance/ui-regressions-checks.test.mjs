import assert from "node:assert/strict";
import test from "node:test";
import { rawIds, SUPPLIER, TOOL_NAME } from "./ui-regressions-checks.mjs";

test("raw IDs are caught and ordinary words are not", () => {
  assert.deepEqual(
    rawIds([
      "YaUqUV",
      "TyELq2",
      "3qtlhN",
      "Google",
      "Atlanta",
      "Sent",
      "Q3",
      "LinkedIn",
      "Inbox",
      "iPhone",
      "GitHub",
    ]),
    ["YaUqUV", "TyELq2", "3qtlhN"],
  );
});

test("supplier and tool names", () => {
  assert.match("found via Exa", SUPPLIER);
  assert.doesNotMatch("Alexa Smith, example", SUPPLIER);
  assert.match("called agent_run", TOOL_NAME);
  assert.doesNotMatch("first name", TOOL_NAME);
});
