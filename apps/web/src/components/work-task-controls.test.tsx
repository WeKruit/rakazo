// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundTasks } from "./BackgroundTasks";
import { StageTranscript } from "./StageTranscript";

const api = vi.hoisted(() => ({
  messages: vi.fn(),
  backgroundTasks: vi.fn(),
  cancelTask: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { threads: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/chat-ui/web-lazy", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogTitle: Pass,
    DialogClose: Pass,
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: ReactNode;
      onClick: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});

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
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
const message = (id: string, runId: string, text: string) =>
  ({ id, runId, role: "bot", blocks: [{ kind: "text", text }] }) as ThreadMessage;

it("loads every stage page from the original group and excludes other work", async () => {
  const brief = {
    ...message("brief", "main-run", ""),
    blocks: [
      {
        kind: "handoff",
        fromBotId: "main",
        toBotId: "teammate",
        text: "Check the saved evidence",
        hop: 1,
      },
    ],
  } as ThreadMessage;
  api.messages.mockResolvedValueOnce({
    messages: [
      message("last", "stage-run", "Saved findings"),
      message("other", "other-run", "Unrelated work"),
    ],
    olderCursor: 5,
  });
  api.messages.mockResolvedValueOnce({
    messages: [brief, message("first", "stage-run", "Read the evidence")],
    olderCursor: null,
  });
  const renderMessage = vi.fn((row: ThreadMessage) => (
    <div>{row.blocks[0]?.kind === "text" ? row.blocks[0].text : ""}</div>
  ));
  await act(async () =>
    root.render(
      <StageTranscript
        target={{ groupId: "test-group" }}
        botId="teammate"
        runIds={["stage-run"]}
        sourceRunIds={["main-run", "stage-run"]}
        renderMessage={renderMessage}
        showToolActivity
        onClose={vi.fn()}
      />,
    ),
  );
  expect(api.messages).toHaveBeenCalledTimes(2);
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { groupId: "test-group", includePeerRuns: true, before: undefined },
    { groupId: "test-group", includePeerRuns: true, before: 5 },
  ]);
  expect(container.textContent).toContain(
    "Check the saved evidenceRead the evidenceSaved findings",
  );
  expect(container.textContent).not.toContain("Unrelated work");
});

it("shows a retry when the full transcript fails instead of presenting a partial transcript", async () => {
  api.messages
    .mockResolvedValueOnce({ messages: [message("last", "stage-run", "Partial")], olderCursor: 5 })
    .mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(
      <StageTranscript
        target={{ groupId: "test-group" }}
        botId="teammate"
        runIds={["stage-run"]}
        sourceRunIds={[]}
        renderMessage={() => null}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("Could not load this task.");
  expect(container.textContent).not.toContain("Partial");
  api.messages.mockResolvedValueOnce({ messages: [], olderCursor: null });
  await act(async () => button("Retry").click());
  expect(container.textContent).toContain("No messages yet.");
});

it("stops only the chosen research follow-up and preserves pending cloud cancellation", async () => {
  const research = { id: "research", kind: "research", status: "running" };
  const cloud = { id: "cloud", kind: "cloud_agent", status: "running" };
  api.backgroundTasks
    .mockResolvedValueOnce([research, cloud])
    .mockResolvedValueOnce([cloud])
    .mockResolvedValueOnce([{ ...cloud, status: "cancelling" }]);
  api.cancelTask.mockResolvedValue({ ok: true });
  await act(async () =>
    root.render(<BackgroundTasks target={{ groupId: "test-group" }} onClose={vi.fn()} />),
  );
  await act(async () => button("Stop updates").click());
  expect(api.cancelTask).toHaveBeenCalledExactlyOnceWith({
    groupId: "test-group",
    kind: "research",
    id: "research",
  });
  expect(container.textContent).not.toContain("Finding candidates");
  await act(async () => button("Cancel task").click());
  expect(api.cancelTask).toHaveBeenLastCalledWith({
    groupId: "test-group",
    kind: "cloud_agent",
    id: "cloud",
  });
  expect(button("Cancelling…").disabled).toBe(true);
  expect(container.textContent).toContain("Delegated task");
});

it("keeps raw handoff instructions hidden in the ordinary task transcript", async () => {
  api.messages.mockResolvedValueOnce({
    messages: [
      {
        ...message("brief", "main-run", ""),
        blocks: [
          {
            kind: "handoff",
            fromBotId: "main",
            toBotId: "teammate",
            text: "Internal handoff instructions",
            hop: 1,
          },
        ],
      },
      message("reply", "stage-run", "Findings ready"),
    ],
    olderCursor: null,
  });
  await act(async () =>
    root.render(
      <StageTranscript
        target={{ groupId: "test-group" }}
        botId="teammate"
        runIds={["stage-run"]}
        sourceRunIds={["main-run"]}
        renderMessage={(row) => (
          <div>{row.blocks[0]?.kind === "text" ? row.blocks[0].text : ""}</div>
        )}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("Findings ready");
  expect(container.textContent).not.toContain("Internal handoff instructions");
});
