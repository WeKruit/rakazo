// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => new Map<string, number>());
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../ShellMessage", async () => {
  const { memo } = await import("react");
  return {
    MessageView: memo(function MessageView(props: { message: { id: string } }) {
      rendered.set(props.message.id, (rendered.get(props.message.id) ?? 0) + 1);
      return <p>{props.message.id}</p>;
    }),
    MessageHoverActions: () => null,
  };
});

import { Transcript } from "./Transcript";

let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  rendered.clear();
});

const message = (id: string, text: string) => ({
  id,
  role: "bot" as const,
  seq: 1,
  createdAt: "2026-11-05T02:00:00.000Z",
  blocks: [{ kind: "text" as const, text }],
});

it("re-renders only the streaming message, not the whole transcript", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  const handlers = {
    onScrollRequestHandled: () => {},
    onLoadOlder: () => {},
    onOpenBot: () => {},
    onAnswer: async () => {},
    onReply: () => {},
    onQuote: () => {},
    onReact: async () => {},
    onJumpToMessage: () => {},
    onOpenPeerMessages: () => {},
    peerBot: () => undefined,
    onRefresh: async () => {},
    onBotChanged: async () => {},
    onAddRoutine: () => {},
    onSpeak: () => {},
    onOpenComputer: () => {},
  };
  Element.prototype.scrollTo ??= function scrollTo() {};
  const scrollRef = createRef<HTMLDivElement>();
  const artifactTarget = {} as never;
  const older = Array.from({ length: 20 }, (_, i) => message(`m${i}`, `old ${i}`));
  const view = (live: string) => (
    <Transcript
      narrow={false}
      visible
      scrollRef={scrollRef}
      scrollRequest={null}
      artifactTarget={artifactTarget}
      messages={[...older, message("live", live)] as never}
      showToolActivity={false}
      olderCursor={null}
      loadingOlder={false}
      answerableAskMessageIds={[]}
      waitingRuns={[]}
      running
      tailPhase={null}
      workingBots={[]}
      workRuns={[]}
      voiceReady={false}
      speakingMessageId={null}
      {...handlers}
    />
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(view("Lis")));
  await vi.waitFor(() => expect(rendered.get("live")).toBeGreaterThan(0));
  const before = new Map(rendered);
  for (const text of ["Lisbon", "Lisbon is", "Lisbon is the capital"])
    await act(async () => root!.render(view(text)));
  expect(rendered.get("live")).toBe((before.get("live") ?? 0) + 3);
  for (const old of older) expect(rendered.get(old.id)).toBe(before.get(old.id));
});
