import assert from "node:assert/strict";
import test from "node:test";
import { checkNotificationPolicy } from "./notification-policy.mjs";

const fixture = { threadId: "test-thread", eventId: "bot-event" };
const rpcFor = (responses) => async (route) =>
  route === "notifications/desktopActivity" ? { ok: true } : responses.shift();

test("accepts one reservation and an already reserved phone notification", async () => {
  await checkNotificationPolicy(
    rpcFor([
      { allowed: true, reserved: true },
      { allowed: false, reserved: true },
      { allowed: false, reserved: true },
    ]),
    fixture,
  );
  await checkNotificationPolicy(
    rpcFor([
      { allowed: false, reserved: true },
      { allowed: false, reserved: true },
      { allowed: false, reserved: true },
    ]),
    fixture,
  );
});

test("rejects duplicate dispatch and an always-deny path without ledger evidence", async () => {
  await assert.rejects(
    checkNotificationPolicy(
      rpcFor([
        { allowed: true, reserved: true },
        { allowed: true, reserved: true },
      ]),
      fixture,
    ),
  );
  await assert.rejects(
    checkNotificationPolicy(
      rpcFor([
        { allowed: false, reserved: false },
        { allowed: false, reserved: false },
      ]),
      fixture,
    ),
  );
});
