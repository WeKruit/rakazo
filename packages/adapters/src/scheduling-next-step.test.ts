import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import {
  BOOKING_NEXT_STEP,
  NO_CALENDAR_NEXT_STEP,
  schedulingNextStep,
} from "./scheduling-next-step.js";

const scope = { spaceId: "space", userId: "user", botId: "scheduling" };
const grant = (endpoint: string, allowedTools: string[]) => ({
  allowAllTools: false,
  allowedTools,
  server: { endpoint },
});
const prisma = (grants: unknown[]) =>
  ({ botMcpServer: { findMany: vi.fn(async () => grants) } }) as unknown as PrismaClient;

it("books on either connected calendar through the one plan path", async () => {
  expect(
    await schedulingNextStep(
      prisma([
        grant("https://calendarmcp.googleapis.com/mcp/v1", ["suggest_time", "create_event"]),
      ]),
      scope,
    ),
  ).toBe(BOOKING_NEXT_STEP);
  expect(
    await schedulingNextStep(
      prisma([grant("https://mcp.cal.com/mcp", ["get_availability", "create_booking"])]),
      scope,
    ),
  ).toBe(BOOKING_NEXT_STEP);
  // A calendar it may only read cannot book.
  expect(
    await schedulingNextStep(
      prisma([grant("https://calendarmcp.googleapis.com/mcp/v1", ["list_events"])]),
      scope,
    ),
  ).toBe(NO_CALENDAR_NEXT_STEP);
});
