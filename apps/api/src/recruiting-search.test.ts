import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { queryRecruitingSearchTargets } from "./search.js";

const actor: Actor = { userId: "owner", spaceId: "space" };
it("searches literal saved names within actor, active-role and current-source fences", async () => {
  const $queryRaw = vi.fn().mockResolvedValue([]);
  await queryRecruitingSearchTargets({ $queryRaw }, actor, "  50%_\\  ");
  const query = $queryRaw.mock.calls[0]![0];
  expect(query.values).toContain("%50\\%\\_\\\\%");
  expect(
    query.values.filter((value: unknown) => value === actor.userId).length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    query.values.filter((value: unknown) => value === actor.spaceId).length,
  ).toBeGreaterThanOrEqual(4);
  expect(query.sql).toContain('t."activeRecruitingRoleId"=r.id');
  expect(query.sql).toContain("e.kind='instantly_role_campaign'");
  expect(query.sql).toContain("e.status='completed'");
  expect(query.sql.match(/LIMIT 8/g)).toHaveLength(2);
});
it("does not read the database for an empty search", async () => {
  const $queryRaw = vi.fn();
  expect(await queryRecruitingSearchTargets({ $queryRaw }, actor, " ")).toEqual([]);
  expect($queryRaw).not.toHaveBeenCalled();
});
