import assert from "node:assert/strict";
import test from "node:test";
import { assertRecoveryRetryIntent } from "./workloop-browser.mjs";

const retry = {
  groupId: "test-copy",
  text: "Try again",
  queueMode: "steer",
  clientNonce: "retry-nonce",
};

test("accepts only the retry instruction in the same native conversation", () => {
  assert.doesNotThrow(() => assertRecoveryRetryIntent(retry, "test-copy"));
});

test("rejects draft attachments, reply context, contact context and deferred retry intent", () => {
  for (const change of [
    { artifactIds: ["draft-file"] },
    { replyToMessageId: "another-message" },
    { replyQuote: "unsent quote" },
    { correspondenceReference: {} },
    { recruitingContext: {} },
    { queueMode: "follow_up" },
    { groupId: "another-copy" },
    { text: "Unsent draft" },
  ])
    assert.throws(() => assertRecoveryRetryIntent({ ...retry, ...change }, "test-copy"));
});
