// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePaneWidth } from "../lib/pane-width";
import { ResizableSidePanel } from "../pages/ResizableSidePanel";
import { PaneResizeHandle } from "./PaneResizeHandle";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.dir = "";
});
function key(value: string) {
  act(() =>
    host
      .querySelector("hr")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })),
  );
}
it("uses logical growth for arrows, clamps bounds and resets", () => {
  const resize = vi.fn();
  const reset = vi.fn();
  act(() =>
    root.render(
      <PaneResizeHandle
        label="Resize"
        width={350}
        min={320}
        max={360}
        edge="end"
        onResize={resize}
        onReset={reset}
      />,
    ),
  );
  key("ArrowRight");
  expect(resize).toHaveBeenLastCalledWith(360);
  document.documentElement.dir = "rtl";
  key("ArrowRight");
  expect(resize).toHaveBeenLastCalledWith(334);
  key("Home");
  expect(resize).toHaveBeenLastCalledWith(320);
  key("End");
  expect(resize).toHaveBeenLastCalledWith(360);
  act(() => host.querySelector("hr")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(reset).toHaveBeenCalledOnce();
});
it("clears dragging state when a pane is unmounted", () => {
  act(() =>
    root.render(
      <PaneResizeHandle
        label="Resize"
        width={350}
        min={320}
        max={500}
        edge="start"
        onResize={vi.fn()}
        onReset={vi.fn()}
      />,
    ),
  );
  const handle = host.querySelector("hr")!;
  handle.setPointerCapture = vi.fn();
  act(() =>
    handle.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 400, bubbles: true })),
  );
  expect(document.documentElement.hasAttribute("data-pane-resizing")).toBe(true);
  act(() => root.render(null));
  expect(document.documentElement.hasAttribute("data-pane-resizing")).toBe(false);
});
it("reserves the actual sidebar width and responds to viewport changes", () => {
  window.innerWidth = 1500;
  act(() =>
    root.render(
      <ResizableSidePanel open panel="detail" botsSidebarWidth={480}>
        Details
      </ResizableSidePanel>,
    ),
  );
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("700");
  window.innerWidth = 1200;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("400");
  act(() =>
    root.render(
      <ResizableSidePanel open panel="detail" botsSidebarWidth={0}>
        Details
      </ResizableSidePanel>,
    ),
  );
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("880");
});
it("loads a saved preference on first render and ignores non-finite storage", () => {
  function Preference() {
    const [width, setWidth] = usePaneWidth("width", 320);
    return (
      <button type="button" onClick={() => setWidth(400)}>
        {width}
      </button>
    );
  }
  localStorage.setItem("width", "Infinity");
  act(() => root.render(<Preference />));
  expect(host.textContent).toBe("320");
  act(() => host.querySelector("button")!.click());
  expect(localStorage.getItem("width")).toBe("400");
  act(() => root.render(null));
  act(() => root.render(<Preference />));
  expect(host.textContent).toBe("400");
});

it("retains the default side-panel bounds and responds to a newly loaded view preference", () => {
  window.innerWidth = 1000;
  act(() =>
    root.render(
      <ResizableSidePanel open panel="detail">
        Details
      </ResizableSidePanel>,
    ),
  );
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("364");
  window.innerWidth = 1500;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("864");
  function Preference({ initial }: { initial: number }) {
    const [width] = usePaneWidth("navigation", initial);
    return <span>{width}</span>;
  }
  act(() => root.render(<Preference initial={260} />));
  act(() => root.render(<Preference initial={316} />));
  expect(host.textContent).toBe("316");
});

it("opens recruiting detail at 600px within reactive bounds and preserves user resizing", () => {
  window.innerWidth = 1500;
  const render = () =>
    root.render(
      <ResizableSidePanel open panel="recruiting-detail" botsSidebarWidth={480}>
        Details
      </ResizableSidePanel>,
    );
  act(render);
  const panel = () => host.querySelector<HTMLElement>("aside")!;
  expect(panel().style.getPropertyValue("--panel-width")).toBe("600px");
  expect(panel().classList.contains("max-w-none")).toBe(true);
  expect(panel().classList.contains("max-w-[384px]")).toBe(false);
  key("ArrowLeft");
  expect(panel().style.getPropertyValue("--panel-width")).toBe("616px");
  window.innerWidth = 1100;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(panel().style.getPropertyValue("--panel-width")).toBe("320px");
  window.innerWidth = 1600;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(panel().style.getPropertyValue("--panel-width")).toBe("616px");
  act(() => root.render(null));
  act(render);
  expect(panel().style.getPropertyValue("--panel-width")).toBe("616px");
  act(() => host.querySelector("hr")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(panel().style.getPropertyValue("--panel-width")).toBe("600px");
});

it("keeps ordinary panels at their existing default and respects an existing width preference", () => {
  window.innerWidth = 1500;
  act(() =>
    root.render(
      <ResizableSidePanel open panel="settings">
        Settings
      </ResizableSidePanel>,
    ),
  );
  expect(host.querySelector<HTMLElement>("aside")!.style.getPropertyValue("--panel-width")).toBe(
    "384px",
  );
  act(() => root.render(null));
  localStorage.setItem("rakazo:right-panel-width", "450");
  act(() =>
    root.render(
      <ResizableSidePanel open panel="recruiting-detail">
        Details
      </ResizableSidePanel>,
    ),
  );
  expect(host.querySelector<HTMLElement>("aside")!.style.getPropertyValue("--panel-width")).toBe(
    "450px",
  );
});
