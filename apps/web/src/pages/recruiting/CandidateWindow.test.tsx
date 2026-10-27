// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CandidateWindowProps } from "./CandidateWindow";
import { CandidateWindow } from "./CandidateWindow";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const runtime = vi.hoisted(() => ({ loaded: 0 }));
vi.mock("./VirtualCandidateWindow", () => {
  runtime.loaded++;
  return { VirtualCandidateWindow: () => <div data-virtual-window /> };
});

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

it.each(["table", "cards"] as const)(
  "keeps all 80 %s rows and keyboard navigation without loading the virtual runtime",
  async (mode) => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const offsets: CandidateWindowProps["offsets"] = {
      current: { table: { offset: 0, measurements: [] }, cards: { offset: 0, measurements: [] } },
    };
    const opened = vi.fn();
    const keys = Array.from({ length: 80 }, (_, index) => `candidate-${index}`);
    const renderRow = (index: number) => {
      const button = (
        <button type="button" data-candidate-name onClick={() => opened(index)}>
          {keys[index]}
        </button>
      );
      return mode === "table" ? (
        <tr>
          <td>{button}</td>
        </tr>
      ) : (
        <li>{button}</li>
      );
    };
    const render = (itemKeys = keys) =>
      act(async () =>
        root?.render(
          <CandidateWindow
            itemKeys={itemKeys}
            mode={mode}
            label="Candidates"
            renderRow={renderRow}
            offsets={offsets}
            cardGridClassName="custom-grid"
          />,
        ),
      );
    await render();
    expect(runtime.loaded).toBe(0);
    expect(container.querySelectorAll("[data-candidate-index]")).toHaveLength(80);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-candidate-name]")];
    buttons[0]!.focus();
    for (const [key, index] of [
      ["ArrowDown", 1],
      ["End", 79],
      ["ArrowUp", 78],
      ["Home", 0],
    ] as const) {
      await act(async () =>
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
      expect(document.activeElement).toBe(buttons[index]);
    }
    await act(async () => buttons[0]!.click());
    expect(opened).toHaveBeenCalledWith(0);
    if (mode === "cards") {
      expect(container.querySelector("ul")?.className).toBe("custom-grid");
      expect(
        container.querySelector('[data-candidate-index="79"]')?.getAttribute("aria-posinset"),
      ).toBe("80");
    } else expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe("81");
    const viewport = container.querySelector("section")!;
    viewport.scrollTop = 170;
    await act(async () => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(offsets.current[mode].offset).toBe(170);
    await render([...keys].reverse());
    expect(viewport.scrollTop).toBe(0);
    expect(offsets.current[mode]).toEqual({ offset: 0, measurements: [] });
  },
);

it("loads the virtual runtime only above the existing 80-row threshold", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CandidateWindow
        itemKeys={Array.from({ length: 81 }, (_, index) => String(index))}
        mode="cards"
        label="Candidates"
        renderRow={() => <li />}
        offsets={{
          current: {
            table: { offset: 0, measurements: [] },
            cards: { offset: 0, measurements: [] },
          },
        }}
      />,
    );
    await vi.dynamicImportSettled();
  });
  expect(runtime.loaded).toBe(1);
  expect(container.querySelector("[data-virtual-window]")).not.toBeNull();
});
