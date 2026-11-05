// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useSameContent } from "./use-same-content";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => act(() => root?.unmount()));

it("keeps the earlier list while a refresh brings the same content", () => {
  const seen: unknown[] = [];
  function Probe({ value }: { value: { botId: string; name: string }[] }) {
    seen.push(useSameContent(value));
    return null;
  }
  root = createRoot(document.createElement("div"));
  const first = [{ botId: "a", name: "Main" }];
  const renamed = [{ botId: "a", name: "Sourcer" }];
  act(() => root?.render(<Probe value={first} />));
  act(() => root?.render(<Probe value={[{ botId: "a", name: "Main" }]} />));
  act(() => root?.render(<Probe value={renamed} />));
  expect(seen).toEqual([first, first, renamed]);
  expect(seen[1]).toBe(first);
  expect(seen[2]).toBe(renamed);
});
