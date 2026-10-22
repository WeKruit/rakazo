import { AsyncLocalStorage } from "node:async_hooks";
import type { SecretChangeListener } from "@rakazo/adapter-kit";

const deferredChanges = new AsyncLocalStorage<Array<() => void | Promise<void>>>();

/** Defer native invalidation/NOTIFY until the owning database transaction has committed. */
export async function deferSecretChanges<T>(operation: () => Promise<T>): Promise<T> {
  if (deferredChanges.getStore()) return operation();
  const changes: Array<() => void | Promise<void>> = [];
  const value = await deferredChanges.run(changes, operation);
  for (const change of changes) await change();
  return value;
}

export function afterSecretCommit(change: () => void | Promise<void>): Promise<void> {
  const changes = deferredChanges.getStore();
  if (changes) {
    changes.push(change);
    return Promise.resolve();
  }
  return Promise.resolve(change());
}

/** Store-owned invalidation; listeners never need provider revisions. */
export class SecretChanges {
  private readonly listeners = new Set<SecretChangeListener>();
  onChange(listener: SecretChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected changed(ref: string): void {
    void afterSecretCommit(() => this.emitChange(ref));
  }
  private emitChange(ref: string): void {
    for (const listener of this.listeners) {
      try {
        listener(ref);
      } catch {
        /* A consumer cannot fail a persisted write. */
      }
    }
  }
  protected clearListeners(): void {
    this.listeners.clear();
  }
}
