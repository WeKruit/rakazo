// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./external-link-alert-loader", () => ({ loadExternalLinkAlert: loader.load }));

import { LinkifiedText } from "./link-presentation.web";

it("blocks navigation synchronously, offers refresh after a failed import and only opens after confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  let reject!: (reason: Error) => void;
  loader.load.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  loader.load.mockImplementationOnce(() => import("./external-link-alert.web"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<LinkifiedText>https://example.test/path</LinkifiedText>);
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      container.querySelector("a")!.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      reject(new Error("synthetic chunk failure"));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Something went wrong",
    );
    expect(open).not.toHaveBeenCalled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Refresh")!
        .click();
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "may discard unsaved messages, attachments, reply context and selections",
      ),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    confirm.mockRestore();
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Refresh"),
    ).toBe(true);
    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    });
    await act(async () => {
      container.querySelector("a")!.click();
      await vi.dynamicImportSettled();
    });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "example.test/path",
    );
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Open")!.click();
    });
    expect(open).toHaveBeenCalledWith("https://example.test/path", "_blank", "noopener,noreferrer");
  } finally {
    act(() => root.unmount());
    container.remove();
    open.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("canceling a cold import prevents its late dialog from appearing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (module: typeof import("./external-link-alert.web")) => void;
  loader.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<LinkifiedText>https://example.test/path</LinkifiedText>);
    });
    act(() => {
      container.querySelector("a")!.click();
    });
    act(() => {
      container.querySelector("button")!.click();
    });
    await act(async () => {
      resolve(await import("./external-link-alert.web"));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
