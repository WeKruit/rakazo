import { describe, expect, it } from "vitest";
import { routinesMatchingEvent } from "./webhook-inbound.js";

describe("routinesMatchingEvent", () => {
  it("keeps routines without a condition, with a true one, or with an invalid one", () => {
    const routines = [
      { id: "plain", condition: null },
      { id: "opened", condition: 'event.action == "opened"' },
      { id: "closed", condition: 'event.action == "closed"' },
      { id: "broken", condition: "event.action ==" },
    ];
    expect(
      routinesMatchingEvent(routines, { source: "webhook", event: { action: "opened" } }).map(
        (routine) => routine.id,
      ),
    ).toEqual(["plain", "opened", "broken"]);
  });
});
