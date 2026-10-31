// @vitest-environment jsdom
import { observeWorkSession } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StageTranscript } from "../components/StageTranscript";
import { WorkingIndicator } from "../components/WorkingIndicator";
import type { MobileMessage } from "./api";

const api = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => api);
vi.mock("react-native", () => {
  const Surface = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Surface,
    Text: Surface,
    ScrollView: Surface,
    Modal: Surface,
    Platform: { OS: "ios" },
    ActivityIndicator: () => <span>Loading</span>,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  cancelAnimation: vi.fn(),
  Easing: { inOut: vi.fn(), quad: vi.fn() },
  interpolate: () => 0,
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: () => ({ value: 0 }),
  withRepeat: vi.fn(),
  withTiming: vi.fn(),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens and cancels the selected teammate stage on mobile", async () => {
  const at = "2026-10-30T12:00:00.000Z";
  let session = observeWorkSession(
    null,
    { runs: [{ id: "lead", botId: "main", status: "running", startedAt: at }], messages: [] },
    at,
  );
  session = observeWorkSession(
    session,
    { runs: [{ id: "stage", botId: "teammate", status: "running", startedAt: at }], messages: [] },
    at,
  );
  const onOpenStage = vi.fn();
  const onCancelStage = vi.fn();
  await act(async () =>
    root.render(
      <WorkingIndicator
        session={session}
        stageKind={() => "sourcing"}
        onOpenStage={onOpenStage}
        onCancelStage={onCancelStage}
      />,
    ),
  );
  const buttons = [...container.querySelectorAll("button")];
  act(() => buttons.find((button) => button.textContent === "View")!.click());
  act(() => buttons.find((button) => button.textContent === "Cancel task")!.click());
  expect(onOpenStage).toHaveBeenCalledExactlyOnceWith("teammate");
  expect(onCancelStage).toHaveBeenCalledExactlyOnceWith("teammate");
});

it("loads all pages from the same group and merges new stage messages without reading private threads", async () => {
  const message = (id: string, runId: string, seq: number, text: string): MobileMessage => ({
    id,
    runId,
    seq,
    role: "bot",
    blocks: [{ kind: "text", text }],
  });
  api.rpc
    .mockResolvedValueOnce({ messages: [message("last", "stage", 2, "Result")], olderCursor: 1 })
    .mockResolvedValueOnce({
      messages: [
        message("first", "stage", 1, "Evidence"),
        message("other", "other", 0, "Unrelated"),
      ],
      olderCursor: null,
    });
  const stage = { botId: "teammate", runIds: ["stage"], sourceRunIds: ["lead", "stage"] };
  const renderMessage = (row: MobileMessage) => (
    <div key={row.id}>{row.blocks[0]?.kind === "text" ? row.blocks[0].text : ""}</div>
  );
  await act(async () =>
    root.render(
      <StageTranscript
        target={{ groupId: "test-group" }}
        stage={stage}
        liveMessages={[]}
        renderMessage={renderMessage}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(api.rpc.mock.calls.map(([route, input]) => [route, input])).toEqual([
    ["threads/messages", { groupId: "test-group", before: undefined, includePeerRuns: true }],
    ["threads/messages", { groupId: "test-group", before: 1, includePeerRuns: true }],
  ]);
  expect(container.textContent).toContain("EvidenceResult");
  expect(container.textContent).not.toContain("Unrelated");
  await act(async () =>
    root.render(
      <StageTranscript
        target={{ groupId: "test-group" }}
        stage={stage}
        liveMessages={[message("new", "stage", 3, "Finished")]}
        renderMessage={renderMessage}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("EvidenceResultFinished");
  expect(api.rpc).toHaveBeenCalledTimes(2);
});
