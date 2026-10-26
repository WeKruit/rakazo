import { describe, expect, it, vi } from "vitest";
import { fillRecruitingMaterialReceipts } from "./recruiting.js";

const actor = { spaceId: "space-1", userId: "user-1", email: "", isDeploymentOwner: false };
const artifact = { artifactId: "artifact-1", sha256: "a".repeat(64) };
const receipt = {
  reader: "web_fetch",
  artifact,
  url: "https://jobs.example.com/role/1",
  readAt: "2026-10-26T03:38:20.000Z",
};

function prisma(events: unknown[]) {
  return {
    event: { findMany: vi.fn(async () => events.map((payload) => ({ payload }))) },
  } as never;
}

describe("fillRecruitingMaterialReceipts", () => {
  const source = {
    id: "jd",
    kind: "original_material",
    readState: "read",
    url: "https://jobs.example.com/role/1/",
    readAt: "2026-10-26T03:38:20Z",
    quote: "Build simulation",
    anchor: { kind: "artifact", artifact, locator: "text" },
  };

  it("copies the read receipt's url and time onto a sent link's source", async () => {
    const args = { operation: "create", sourceRefs: [source] };
    expect(await fillRecruitingMaterialReceipts(prisma([receipt]), actor, args)).toEqual({
      operation: "create",
      sourceRefs: [{ ...source, url: receipt.url, readAt: receipt.readAt }],
    });
  });

  it("leaves sources without a receipt and message sources as they are", async () => {
    const message = {
      id: "m",
      kind: "user_instruction",
      anchor: { kind: "message", messageId: "x" },
    };
    const args = { operation: "create", sourceRefs: [source, message] };
    expect(await fillRecruitingMaterialReceipts(prisma([]), actor, args)).toEqual(args);
  });
});
