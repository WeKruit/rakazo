// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: {} }));

import { useNewPeopleDuringRun } from "./run-people-progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));

let seen: number | null | undefined;
function Probe(props: { running: boolean; refreshSignal: number; read: () => Promise<number> }) {
  seen = useNewPeopleDuringRun({ groupId: "g", threadId: "t", ...props });
  return null;
}

it("counts people added to Results since the work started, and clears when it ends", async () => {
  let total = 10;
  const read = vi.fn(async () => total);
  const render = async (running: boolean, refreshSignal: number) => {
    await act(async () =>
      root.render(<Probe running={running} refreshSignal={refreshSignal} read={read} />),
    );
  };

  await render(true, 0);
  expect(seen).toBeNull();

  total = 22;
  await render(true, 1);
  expect(seen).toBe(12);

  total = 22;
  await render(true, 2);
  expect(seen).toBe(12);

  await render(false, 2);
  expect(seen).toBeNull();

  // The next turn starts from the new total.
  total = 25;
  await render(true, 3);
  expect(seen).toBeNull();
});
