// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const loading = vi.hoisted(() => {
  let finish!: () => void;
  return {
    ready: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    finish: () => finish(),
  };
});
vi.mock("./markdown.web", async () => {
  await loading.ready;
  return { ChatMarkdown: ({ children }: { children: string }) => <strong>{children}</strong> };
});

import { ChatMarkdown } from "./lazy.web";

it("keeps the message visible while the first markdown renderer is loading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ChatMarkdown>{"<script>plain text</script>"}</ChatMarkdown>);
    });
    expect(container.textContent).toBe("<script>plain text</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      loading.finish();
      await vi.dynamicImportSettled();
    });
    expect(container.querySelector("strong")?.textContent).toBe("<script>plain text</script>");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
