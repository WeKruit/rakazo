import type {
  AppBootstrap,
  RecruitingCorrespondence,
  Space,
  SpaceNavigation,
} from "@rakazo/contracts";
/** Drain bounded RPC pages, preserving sparse pages and rejecting a non-advancing server cursor. */
export async function collectListPages<T>(
  read: (offset: number) => Promise<{ items: T[]; nextOffset: number | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await read(offset);
    items.push(...page.items);
    if (page.nextOffset === null) return items;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error("Invalid list page cursor");
    offset = page.nextOffset;
  }
}

function combineById<T extends { id: string }>(before: T[], after: T[]): T[] {
  const rows = new Map(before.map((row) => [row.id, row]));
  for (const row of after) rows.set(row.id, row);
  return [...rows.values()];
}
function combineSpaces(before: Space[], after: Space[]): Space[] {
  const rows = new Map(before.map((row) => [row.id, row]));
  for (const row of after) {
    const prior = rows.get(row.id);
    rows.set(
      row.id,
      prior
        ? {
            ...row,
            bots: combineById(prior.bots, row.bots),
            groups: combineById(prior.groups, row.groups),
            botSections: combineById(prior.botSections, row.botSections),
            externalConversations: combineById(
              prior.externalConversations,
              row.externalConversations,
            ),
          }
        : row,
    );
  }
  return [...rows.values()];
}
/** Preserve the caller's complete navigation view while all RPC pages stay bounded. */
export async function collectNavigationPages<T extends SpaceNavigation | AppBootstrap>(
  read: (offset: number) => Promise<T>,
): Promise<T> {
  let result = await read(0);
  let offset = 0;
  while (result.nextOffset != null) {
    const nextOffset = result.nextOffset;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)
      throw new Error("Invalid navigation cursor");
    const page = await read(nextOffset);
    if ("current" in result && "current" in page) {
      if (result.current.id !== page.current.id) throw new Error("Navigation context changed");
      result = {
        ...result,
        nextOffset: page.nextOffset,
        spaces: combineSpaces(result.spaces, page.spaces),
        current: {
          ...result.current,
          bots: combineById(result.current.bots, page.current.bots),
          groups: combineById(result.current.groups, page.current.groups),
          botSections: combineById(result.current.botSections, page.current.botSections),
          externalConversations: combineById(
            result.current.externalConversations,
            page.current.externalConversations,
          ),
        },
      } as T;
    } else if ("me" in result && "me" in page) {
      if (result.me.userId !== page.me.userId || result.me.spaceId !== page.me.spaceId)
        throw new Error("Bootstrap context changed");
      result = {
        ...result,
        nextOffset: page.nextOffset,
        spaces: combineSpaces(result.spaces, page.spaces),
        bots: combineById(result.bots, page.bots),
        groups: combineById(result.groups, page.groups),
        botSections: combineById(result.botSections, page.botSections),
        archivedBots: combineById(result.archivedBots, page.archivedBots),
        archivedGroups: combineById(result.archivedGroups, page.archivedGroups),
        routines: combineById(result.routines, page.routines),
      } as T;
    } else throw new Error("Navigation response changed");
    offset = nextOffset;
  }
  return result;
}

/** Contact views retain their existing complete-list client contract over bounded RPC pages. */
export async function collectContactPages(
  read: (cursor: string) => Promise<RecruitingCorrespondence>,
): Promise<RecruitingCorrespondence> {
  const first = await read("0");
  let result = first;
  let offset = 0;
  while (result.nextCursor !== null) {
    const next = Number(result.nextCursor);
    if (!Number.isSafeInteger(next) || next <= offset) throw new Error("Invalid contact cursor");
    const page = await read(result.nextCursor);
    result = { ...page, contacts: [...result.contacts, ...page.contacts] };
    offset = next;
  }
  return result;
}
