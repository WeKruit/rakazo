import type * as DatabaseModule from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { stopConversationWork } from "./stop-work.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

describe("stopConversationWork", () => {});
