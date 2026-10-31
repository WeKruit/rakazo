// @vitest-environment jsdom
import type { PollBlock } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { PollCard, ViewBlockView } from "./message-cards";

vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { votePoll: vi.fn(async () => ({ ok: true })) } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const poll: PollBlock = {
  kind: "poll",
  pollId: "p1",
  question: "Which title first?",
  options: [
    { id: "1", label: "Staff engineer" },
    { id: "2", label: "Tech lead" },
  ],
  multiple: false,
  includeTeam: false,
  closesAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  status: "open",
  votes: [{ voter: "bot", voterId: "b2", name: "Sourcer", optionIds: ["2"] }],
};

it("shows live counts and a countdown, and votes with one tap", async () => {
  act(() => root.render(<PollCard target={{ groupId: "g1" }} block={poll} />));
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Staff engineer0", "Tech lead1"]);
  expect(container.querySelector("time")?.textContent).toMatch(/^Closes in (4m 5\d|5m 0)s$/);
  await act(async () => buttons[0]!.click());
  expect(rpc.threads.votePoll).toHaveBeenCalledWith({
    groupId: "g1",
    pollId: "p1",
    optionIds: ["1"],
  });
});

it("stops taking votes once closed", () => {
  act(() =>
    root.render(<PollCard target={{ botId: "b1" }} block={{ ...poll, status: "closed" }} />),
  );
  expect(container.querySelector("time")?.textContent).toBe("Closed");
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

it("lays records out as a board with one lane per value", () => {
  act(() =>
    root.render(
      <ViewBlockView
        block={{
          kind: "view",
          layout: "board",
          groupBy: "stage",
          columns: [
            { key: "name", label: "Name" },
            { key: "stage", label: "Stage" },
          ],
          rows: [
            { name: "Ada", stage: "Contacted" },
            { name: "Lin", stage: "Interview" },
            { name: "Sam", stage: "Contacted" },
          ],
          metrics: [],
        }}
      />,
    ),
  );
  const lanes = [...container.querySelectorAll("section")].map((lane) => lane.textContent);
  expect(lanes).toEqual(["Contacted2AdaSam", "Interview1Lin"]);
});
