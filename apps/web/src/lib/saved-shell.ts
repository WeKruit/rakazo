import type { AppBootstrap } from "@rakazo/contracts";
import type { SavedStore } from "./saved-threads";
import { indexedDbStore, SAVED_THREAD_IDLE_MS } from "./saved-threads";

/** The sidebar and account a reload paints before the first server read answers. Display only. */
export type SavedShell = Pick<AppBootstrap, "me" | "bots" | "botSections" | "groups" | "spaces">;
type SavedShellRow = { key: string; savedAt: number; shell: SavedShell };
/** A saved sidebar larger than this is not kept. */
export const SAVED_SHELL_MAX_BYTES = 2 * 1024 * 1024;

export function createSavedShell(
  store: SavedStore<SavedShellRow> | null,
  now: () => number = Date.now,
) {
  return {
    /** The last sidebar of this account, in the Space this browser has selected. */
    async read(userId: string, spaceId: string | null): Promise<SavedShell | undefined> {
      const row = await store?.get(userId).catch(() => undefined);
      if (!row || now() - row.savedAt > SAVED_THREAD_IDLE_MS) return undefined;
      const { me } = row.shell;
      if (me.userId !== userId || (spaceId !== null && me.spaceId !== spaceId)) return undefined;
      return row.shell;
    },
    save(bootstrap: AppBootstrap): Promise<void> {
      if (!store) return Promise.resolve();
      const { me, bots, botSections, groups, spaces } = bootstrap;
      const row = {
        key: me.userId,
        savedAt: now(),
        shell: { me, bots, botSections, groups, spaces },
      };
      const fits = new TextEncoder().encode(JSON.stringify(row)).length <= SAVED_SHELL_MAX_BYTES;
      return (fits ? store.put(row) : store.delete(me.userId)).catch(() => undefined);
    },
    clear(): Promise<void> {
      return store?.clear().catch(() => undefined) ?? Promise.resolve();
    },
  };
}

/** Cleared at sign-out with saved conversations. */
export const savedShell = createSavedShell(
  indexedDbStore<SavedShellRow>("rakazo-saved-shell", "shell"),
);
