import { COMPUTER_UPDATE_STAGES, type ComputerUpdate } from "@rakazo/contracts";

/** Shared polling and local presentation state; the server owns operation lifetime. */
export function createComputerUpdates(
  client: {
    list: () => Promise<ComputerUpdate[]>;
    start: (botId: string, action: "update" | "recover") => Promise<ComputerUpdate>;
    dismiss: (id: string) => Promise<unknown>;
    releaseInterrupted: (id: string) => Promise<unknown>;
  },
  subscribeActive?: (listener: (active: boolean) => void) => () => void,
) {
  let state: { updates: ComputerUpdate[]; openId: string | null } = { updates: [], openId: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let revision = 0;
  let watching = false;
  let active = true;
  let inFlight: Promise<void> | undefined;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const poll = (epoch: number): Promise<void> => {
    if (epoch !== generation || !watching || !active) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    inFlight = Promise.resolve().then(async () => {
      const stamp = revision;
      try {
        if (epoch !== generation || !watching || !active) return;
        const updates = (await client.list()).filter(
          (update) => update.action !== "checkpoint" || computerUpdateNeedsAttention(update),
        );
        if (epoch !== generation || stamp !== revision) return;
        if (JSON.stringify(state.updates) === JSON.stringify(updates)) return;
        state = {
          updates,
          openId: updates.some((item) => item.id === state.openId) ? state.openId : null,
        };
        emit();
      } catch {
        /* Keep the last known operation through transient connection failures. */
      } finally {
        inFlight = undefined;
        if (watching && active) {
          clearTimeout(timer);
          if (epoch !== generation || stamp !== revision) void poll(generation);
          else timer = setTimeout(() => void poll(epoch), state.updates.length ? 1500 : 15000);
        }
      }
    });
    return inFlight;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch() {
      const epoch = ++generation;
      watching = true;
      active = true;
      clearTimeout(timer);
      const unsubscribe = subscribeActive?.((next) => {
        if (epoch !== generation) return;
        active = next;
        clearTimeout(timer);
        if (active) void poll(epoch);
      });
      void poll(epoch);
      return () => {
        unsubscribe?.();
        if (epoch !== generation) return;
        generation++;
        watching = false;
        clearTimeout(timer);
        state = { updates: [], openId: null };
      };
    },
    open(id: string | null) {
      state = { ...state, openId: id };
      emit();
    },
    async start(botId: string, action: "update" | "recover" = "update") {
      const epoch = generation;
      const update = await client.start(botId, action);
      if (epoch !== generation) return;
      revision++;
      state = {
        updates: [update, ...state.updates.filter((item) => item.id !== update.id)],
        openId: update.id,
      };
      emit();
      clearTimeout(timer);
      if (watching && active && !inFlight) timer = setTimeout(() => void poll(epoch), 1500);
    },
    async releaseInterrupted(id: string) {
      const epoch = generation;
      await client.releaseInterrupted(id);
      if (epoch !== generation) return;
      revision++;
      await inFlight;
      await poll(epoch);
    },
    async dismiss(id: string) {
      const epoch = generation;
      await client.dismiss(id);
      if (epoch !== generation) return;
      revision++;
      state = {
        updates: state.updates.filter((item) => item.id !== id),
        openId: state.openId === id ? null : state.openId,
      };
      emit();
    },
  };
}

export function computerUpdateStages(
  action: ComputerUpdate["action"],
): readonly ComputerUpdate["stage"][] {
  return action === "recover"
    ? COMPUTER_UPDATE_STAGES.filter((stage) => stage !== "saving")
    : COMPUTER_UPDATE_STAGES;
}

export function computerUpdateNeedsAttention(update: ComputerUpdate): boolean {
  return update.status === "failed" || update.status === "interrupted";
}
