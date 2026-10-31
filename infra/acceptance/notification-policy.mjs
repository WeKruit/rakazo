import assert from "node:assert/strict";

/** Use a test-copy conversation's bot message; this never sends a real push. */
export async function checkNotificationPolicy(rpc, { threadId, eventId }) {
  assert.ok(threadId && eventId, "notification check needs a test conversation and bot event");
  const input = { threadId, eventId };
  const claims = await Promise.all([
    rpc("notifications/claimBrowser", input),
    rpc("notifications/claimBrowser", input),
  ]);
  assert.ok(
    claims.filter((claim) => claim.allowed).length <= 1,
    "concurrent notifications must not reserve a conversation twice",
  );
  assert.ok(
    claims.every((claim) => claim.reserved),
    "an allowed or suppressed notification needs a durable reservation, including an earlier phone push",
  );
  assert.equal(
    (await rpc("notifications/claimBrowser", input)).allowed,
    false,
    "replaying the event must not bypass the conversation's quiet window",
  );
  assert.equal(
    (await rpc("notifications/desktopActivity")).ok,
    true,
    "the focused desktop activity endpoint must remain available",
  );
}
