// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LinkifiedText } from "./lazy.web";

it("keeps the first candidate message visible and renders canonical safe links after loading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const text =
    "Contact user@example.com\nhttps://例子.测试/path(a) javascript:alert(1) example.com";
  try {
    await act(async () => {
      root.render(<LinkifiedText>{text}</LinkifiedText>);
    });
    expect(container.textContent).toContain("Contact");
    expect(container.textContent).toContain("javascript:alert(1)");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(
      [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href")),
    ).toEqual(["mailto:user@example.com", "https://例子.测试/path(a)"]);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
