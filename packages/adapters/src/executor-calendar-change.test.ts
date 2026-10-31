import { describe, expect, it, vi } from "vitest";
import { calendarChangeAlreadyWaiting } from "./executor.js";

const effect = { id: "e2", runId: "r2", kind: "cal:cancel_booking" };
const request = (bookingUid: string) => [
  "__rakazoCatalogTool",
  "direct",
  { route: { toolName: "cancel_booking" }, args: { bookingUid, cancellationReason: "x" } },
];

function prismaWith(rows: Array<{ request: unknown }>) {
  const findMany = vi.fn(async () => rows);
  return { prisma: { externalEffect: { findMany } } as never, findMany };
}

describe("calendarChangeAlreadyWaiting", () => {
  it("finds a paused run's card for the same booking", async () => {
    const { prisma, findMany } = prismaWith([{ request: request("abc") }]);
    await expect(
      calendarChangeAlreadyWaiting(prisma, {
        spaceId: "s",
        threadId: "t",
        effect,
        bookingUid: "abc",
      }),
    ).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "s",
          kind: "cal:cancel_booking",
          status: "intended",
          id: { not: "e2" },
          runId: { not: "r2" },
          run: { threadId: "t", status: "waiting_input" },
        }),
      }),
    );
  });

  it("ignores cards for another booking", async () => {
    const { prisma } = prismaWith([{ request: request("abcd") }, { request: request("zzz") }]);
    await expect(
      calendarChangeAlreadyWaiting(prisma, {
        spaceId: "s",
        threadId: "t",
        effect,
        bookingUid: "abc",
      }),
    ).resolves.toBe(false);
  });
});
