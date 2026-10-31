import type { AppBootstrap } from "@rakazo/contracts";
import { initialBootstrapTarget } from "./bootstrap-target";
import { markOnce } from "./performance";
import { rpc } from "./rpc";

let ticketBoardEnabled = false;
const capabilityListeners = new Set<() => void>();
export function getTicketBoardEnabled() {
  return ticketBoardEnabled;
}
export function subscribeTicketBoardEnabled(listener: () => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

let primedBootstrap: { botId?: string; groupId?: string; promise: Promise<AppBootstrap> } | null =
  null;
let bootstrapGeneration = 0;

export function invalidateInitialBootstrap() {
  primedBootstrap = null;
  bootstrapGeneration += 1;
}

const initialTarget = initialBootstrapTarget(
  window.location.pathname,
  Boolean(window.rakazoDesktop),
);
if (initialTarget) {
  const { botId, groupId } = initialTarget;
  const promise = requestBootstrap(botId, groupId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, groupId, promise };
}

/** The speculative first-load bootstrap, left in place for the shell to take. */
export function peekInitialBootstrap(): Promise<AppBootstrap> | undefined {
  return primedBootstrap?.promise;
}

export function retainInitialBootstrapForIdentity(userId: string, spaceId: string | null) {
  const primed = primedBootstrap;
  if (!primed) return;
  const generation = bootstrapGeneration;
  const matchesIdentity = (bootstrap: AppBootstrap) =>
    bootstrap.me.userId === userId && (spaceId === null || bootstrap.me.spaceId === spaceId);
  const promise = primed.promise
    .catch(() => undefined)
    .then(async (bootstrap) => {
      if (generation === bootstrapGeneration && (!bootstrap || !matchesIdentity(bootstrap))) {
        bootstrap = await requestBootstrap(primed.botId, primed.groupId);
      }
      if (generation !== bootstrapGeneration || !bootstrap || !matchesIdentity(bootstrap)) {
        throw new Error("Bootstrap identity changed");
      }
      return bootstrap;
    });
  void promise.catch(() => undefined);
  primedBootstrap = { botId: primed.botId, groupId: primed.groupId, promise };
}

export function takeInitialBootstrap(botId?: string, groupId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (primed && primed.botId === botId && primed.groupId === groupId) return primed.promise;
  return requestBootstrap(botId, groupId);
}

function requestBootstrap(botId?: string, groupId?: string) {
  const generation = bootstrapGeneration;
  markOnce("rk:renderer:bootstrap-request-start");
  return (
    rpc
      // Archived bots and roles load after first paint (see useShellRoster).
      .bootstrap({ activeOnly: true, ...(botId ? { botId } : {}), ...(groupId ? { groupId } : {}) })
      .then((bootstrap) => {
        markOnce("rk:renderer:bootstrap-response");
        if (generation === bootstrapGeneration) {
          ticketBoardEnabled = bootstrap.me.ticketBoardEnabled;
          for (const listener of capabilityListeners) listener();
        }
        return bootstrap;
      })
  );
}
