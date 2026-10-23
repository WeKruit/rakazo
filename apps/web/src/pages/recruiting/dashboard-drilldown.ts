import type { RecruitingCandidate } from "@rakazo/contracts";

export type ShortlistWeekFilter = {
  kind: "shortlisted-week";
  roleId: string;
  from: string;
  before: string;
  observedThrough: string;
};
const keys = ["shortlistRole", "shortlistFrom", "shortlistBefore", "shortlistThrough"];

export function readShortlistWeekFilter(params: URLSearchParams): ShortlistWeekFilter | undefined {
  const [roleId, from, before, observedThrough] = keys.map((key) => params.get(key));
  if (!roleId || !from || !before || !observedThrough) return undefined;
  const times = [from, before, observedThrough].map(Date.parse);
  if (times.some((time) => !Number.isFinite(time)) || times[0]! >= times[1]!) return undefined;
  return { kind: "shortlisted-week", roleId, from, before, observedThrough };
}

export function writeShortlistWeekFilter(params: URLSearchParams, filter?: ShortlistWeekFilter) {
  const next = new URLSearchParams(params);
  for (const key of keys) next.delete(key);
  if (filter)
    [filter.roleId, filter.from, filter.before, filter.observedThrough].forEach((value, index) => {
      next.set(keys[index]!, value);
    });
  return next;
}

export function isInShortlistWeek(
  candidate: Pick<RecruitingCandidate, "shortlisted" | "shortlistedAt">,
  filter: ShortlistWeekFilter,
) {
  const at = candidate.shortlistedAt ? Date.parse(candidate.shortlistedAt) : NaN;
  return (
    candidate.shortlisted &&
    Number.isFinite(at) &&
    at >= Date.parse(filter.from) &&
    at < Date.parse(filter.before) &&
    at <= Date.parse(filter.observedThrough)
  );
}
