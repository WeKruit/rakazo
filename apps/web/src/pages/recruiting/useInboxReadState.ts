import type { InboxThreadIdentity, RecruitingInboxReadState } from "@rakazo/contracts";
import { inboxThreadKey, inboxThreadUnread } from "@rakazo/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { authClient } from "../../lib/auth";
import { rpc } from "../../lib/rpc";
import type { EmailConversationItem } from "./EmailConversation";
import { RecruitingReadCacheContext } from "./shared";

export function emailThreadIdentity(email: EmailConversationItem): InboxThreadIdentity | null {
  return email.sourceId && email.threadId && email.eaccount && email.organizationId !== undefined
    ? {
        sourceId: email.sourceId,
        threadId: email.threadId,
        mailbox: email.eaccount,
        organizationId: email.organizationId,
      }
    : null;
}

export function incomingThreadEvidence(items: readonly EmailConversationItem[]) {
  const threads = new Map<string, InboxThreadIdentity & { latestIncomingAt: string | null }>();
  const unknown = new Set<string>();
  for (const item of items) {
    const identity = emailThreadIdentity(item);
    if (!identity) continue;
    const key = inboxThreadKey(identity);
    const thread = threads.get(key) ?? { ...identity, latestIncomingAt: null };
    if (item.direction === "received") {
      const date = Date.parse(item.date ?? "");
      if (!Number.isFinite(date) || date > Date.now()) unknown.add(key);
      else if (!thread.latestIncomingAt || date > Date.parse(thread.latestIncomingAt))
        thread.latestIncomingAt = item.date;
    }
    threads.set(key, thread);
  }
  for (const key of unknown) threads.get(key)!.latestIncomingAt = null;
  return [...threads.values()];
}

export function useInboxReadState(
  spaceId: string | undefined,
  items: readonly EmailConversationItem[],
  authoritativeThreads?: readonly (InboxThreadIdentity & { latestIncomingAt: string | null })[],
) {
  const cache = useContext(RecruitingReadCacheContext);
  const userId = authClient.useSession().data?.user.id;
  const scope = JSON.stringify([userId, spaceId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const byThread = new Map(
    incomingThreadEvidence(items).map((thread) => [inboxThreadKey(thread), thread]),
  );
  for (const thread of authoritativeThreads ?? []) byThread.set(inboxThreadKey(thread), thread);
  const evidence = [...byThread.values()];
  const evidenceKey = JSON.stringify(evidence);
  const [result, setResult] = useState<{
    scope: string;
    evidenceKey: string;
    state: RecruitingInboxReadState;
  }>();
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState({ scope, failed: false, pending: false });
  const failed = status.scope === scope && status.failed;
  const pending = status.scope === scope && status.pending;
  useEffect(() => {
    let active = true;
    if (spaceId && userId)
      void (async () => {
        let merged: RecruitingInboxReadState | undefined;
        for (let offset = 0; offset < Math.max(1, evidence.length); offset += 200) {
          const page = await rpc.recruiting.inboxReadState({
            spaceId,
            threads: evidence.slice(offset, offset + 200),
          });
          if (!active || currentScope.current !== scope) return;
          merged = merged
            ? { initializedAt: merged.initializedAt, items: [...merged.items, ...page.items] }
            : page;
        }
        if (merged) {
          setResult({ scope, evidenceKey, state: merged });
          setStatus({ scope, failed: false, pending: false });
        }
      })().catch(() => {
        if (active && currentScope.current === scope)
          setStatus({ scope, failed: true, pending: false });
      });
    return () => {
      active = false;
    };
  }, [scope, evidenceKey, refresh]);
  const state =
    result && result.scope === scope && result.evidenceKey === evidenceKey
      ? result.state
      : undefined;
  const unread = (email: EmailConversationItem): boolean | null => {
    const identity = emailThreadIdentity(email);
    if (!identity || !state || failed) return null;
    const key = inboxThreadKey(identity);
    const incoming =
      evidence.find((thread) => inboxThreadKey(thread) === key)?.latestIncomingAt ?? null;
    if (!incoming) return null;
    const cursor = state.items.find((row) => row.key === key);
    return cursor?.unread
      ? true
      : inboxThreadUnread(incoming, cursor?.lastReadAt ?? null, state.initializedAt);
  };
  const mark = useCallback(
    async (thread: InboxThreadIdentity, observedIncomingAt: string, unread: boolean) => {
      if (!spaceId || !userId || currentScope.current !== scope) return;
      setStatus({ scope, failed: false, pending: true });
      try {
        await rpc.recruiting.markInboxThread({ spaceId, thread, observedIncomingAt, unread });
        if (currentScope.current === scope) {
          setRefresh((value) => value + 1);
          void cache?.client.invalidateQueries({
            queryKey: ["recruiting", `global-inbox:${scope}`],
          });
        }
      } catch {
        if (currentScope.current === scope) setStatus({ scope, failed: true, pending: false });
      } finally {
        if (currentScope.current === scope) setStatus((value) => ({ ...value, pending: false }));
      }
    },
    [scope, cache],
  );
  return { unread, mark, failed, pending, ready: !!state && !failed };
}
export type InboxReadControls = ReturnType<typeof useInboxReadState>;
