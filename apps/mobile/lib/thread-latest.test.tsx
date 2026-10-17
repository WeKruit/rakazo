// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import {
  answerableAskMessageIds,
  appendNewerThreadPage,
  leaveThreadWindow,
  openThreadWindow,
  reconcileThreadScrollState,
} from "@rakazo/core";
import React, { act, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileMessage, MobileSnapshot } from "./api";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";

// Exercise the screen's actual handler without importing its native dependencies.
// Keep Vitest's jsdom URL transform from replacing the file URL with self.location.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const handler = source.slice(
  source.indexOf("  function showLatest() {"),
  source.indexOf("  async function loadOlderMessages() {"),
);

function page(seqs: number[]) {
  return {
    threadId: "thread-1",
    olderCursor: 1,
    messages: seqs.map((seq) => ({ id: `message-${seq}`, seq })),
  };
}

describe("mobile jump to latest", () => {
  it.each(["no newer gap", "newer pages closed the gap"])(
    "leaves a pinned page with %s",
    (scenario) => {
      const latest = page([4, 5]);
      const opened = openThreadWindow(latest, page([1, 2]));
      const window =
        scenario === "no newer gap"
          ? openThreadWindow(latest, latest)
          : appendNewerThreadPage(opened.snapshot, opened.newerCursor!, page([2, 3, 4, 5]));
      expect(window.newerCursor).toBeNull();
      expect(leaveThreadWindow(window.snapshot, window.newerCursor)).toBe(window.snapshot);

      function Probe() {
        const [snap, setSnap] = useState(window.snapshot);
        const snapRef = useRef(snap);
        const pinnedAroundRef = useRef<{ newerCursor: number | null } | null>(window);
        const jumpScrollTarget = useRef<string | null>("message-4");
        const [scrollState, setThreadScrollState] = useState<ThreadScrollState>({
          detached: false,
          unread: false,
        });
        const scope = {
          pinnedAroundRef,
          joinPinnedAfterLayout: useRef<number | null>(0),
          jumpScrollTarget,
          jumpAnchor: useRef(new ThreadJumpAnchor()),
          expandedHistoryThread: useRef<string | null>("thread-1"),
          scrollBehavior: useRef(new ThreadScrollBehavior()),
          setThreadScrollState,
          publishThreadScrollState: (next: ThreadScrollState) =>
            setThreadScrollState((previous) => reconcileThreadScrollState(previous, next)),
          snapRef,
          commitSnap: setSnap,
          leaveThreadWindow,
        };
        const showLatest = new Function(...Object.keys(scope), `${handler}; return showLatest;`)(
          ...Object.values(scope),
        );
        const pinned = pinnedAroundRef.current != null || jumpScrollTarget.current != null;
        return (
          <>
            <div data-list={pinned ? "pinned" : "live"}>{snap.messages.length}</div>
            {pinned || scrollState.detached ? (
              <button type="button" onClick={showLatest}>
                Jump to latest
              </button>
            ) : null}
          </>
        );
      }

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() => root.render(<Probe />));
        expect(container.querySelector('[data-list="pinned"]')).not.toBeNull();
        act(() => container.querySelector("button")!.click());
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        expect(container.querySelector("button")).toBeNull();
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});

it("keeps each waiting agent's original question enabled in a mobile group", () => {
  const snapshot: MobileSnapshot = {
    threadId: "group-thread",
    cursor: 10,
    olderCursor: null,
    activeRuns: [
      { id: "main", status: "waiting_input" },
      { id: "sourcer", status: "waiting_input" },
      { id: "busy", status: "running" },
    ],
    messages: [
      { id: "main-old", runId: "main" },
      { id: "main-ask", runId: "main" },
      { id: "sourcer-ask", runId: "sourcer" },
      { id: "busy-ask", runId: "busy" },
    ].map((message) => ({
      ...message,
      role: "bot",
      blocks: [{ kind: "ask", text: "Which priority?", status: "pending" }],
    })),
  };
  const selection = source.match(/^ {2}const answerableAsk\w+ = .*;/m)![0];
  const rows = source.slice(
    source.indexOf("  const renderMessageRow = useCallback("),
    source.indexOf("  const renderItem = useCallback("),
  );
  const compiled = ts.transpileModule(`${selection}\n${rows}\nreturn renderMessageRow;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function Probe({ readOnly = false }: { readOnly?: boolean }) {
    const scope = {
      React,
      useCallback,
      answerableAskMessageIds,
      snap: snapshot,
      readOnly,
      messagesById: new Map(),
      memberName: () => undefined,
      mentionBots: [],
      displayName: "Main",
      reactionView: { reactions: new Map() },
      inGroup: true,
      botId: undefined,
      groupId: "group-1",
      currentBot: null,
      currentBotStatus: "idle",
      rowActions: {},
      onCall: false,
      highlightedMessageId: null,
      separatorIds: new Set(),
      windowWidth: 393,
      t: (text: string) => text,
      locale: "en",
      MessageRow: ({ message, canAnswer }: { message: MobileMessage; canAnswer: boolean }) => (
        <button type="button" data-message={message.id} disabled={!canAnswer} />
      ),
    };
    const renderRow = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
    return snapshot.messages.map((message) => renderRow(message));
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<Probe />));
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button:enabled")].map(
        (button) => button.dataset.message,
      ),
    ).toEqual(["main-ask", "sourcer-ask"]);
    act(() => root.render(<Probe readOnly />));
    expect(container.querySelector("button:enabled")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
