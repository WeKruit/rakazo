import { expect, it, vi } from "vitest";
import { roleLinkBlocks } from "./role-links.js";

it("shows only this user's named roles, in the order named", async () => {
  const findMany = vi.fn().mockResolvedValue([
    { id: "r2", title: "Data Engineer", sourceThread: { groupId: "g2" } },
    { id: "r1", title: "ML Lead", sourceThread: { groupId: "g1" } },
  ]);
  const blocks = await roleLinkBlocks(
    { recruitingRole: { findMany } } as never,
    { spaceId: "s", userId: "u" },
    ["r1", "r2", "other"],
  );
  expect(findMany.mock.calls[0]![0].where).toEqual({
    id: { in: ["r1", "r2", "other"] },
    spaceId: "s",
    userId: "u",
  });
  expect(blocks).toEqual([
    { kind: "role_link", groupId: "g1", title: "ML Lead" },
    { kind: "role_link", groupId: "g2", title: "Data Engineer" },
  ]);
});
