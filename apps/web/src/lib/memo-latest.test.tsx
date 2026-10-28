// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { memoWithLatestHandlers } from "./memo-latest";

describe("memoWithLatestHandlers", () => {
  it("skips renders for new handlers and still calls the latest one", () => {
    const renders = vi.fn();
    const Label = memoWithLatestHandlers(function Label(props: {
      text: string;
      onPick: () => string;
    }) {
      renders();
      return (
        <button type="button" onClick={() => props.onPick()}>
          {props.text}
        </button>
      );
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    const picked: string[] = [];
    act(() => root.render(<Label text="a" onPick={() => picked.push("first").toString()} />));
    act(() => root.render(<Label text="a" onPick={() => picked.push("second").toString()} />));
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => host.querySelector("button")!.click());
    expect(picked).toEqual(["second"]);
    act(() => root.render(<Label text="b" onPick={() => ""} />));
    expect(renders).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("b");
    act(() => root.unmount());
  });
});
