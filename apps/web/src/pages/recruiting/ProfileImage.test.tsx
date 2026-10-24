// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileImage } from "./ProfileImage";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("falls back on image error and tries a different person's supplied image", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const render = (src: string | null, fallback: string) =>
    act(async () => root.render(<ProfileImage src={src} fallback={fallback} className="" photo />));
  await render("https://assets.example.test/first.png", "AA");
  expect(node.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  await act(async () => node.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(node.textContent).toBe("AA");
  expect(node.querySelector("img")).toBeNull();
  await render("https://assets.example.test/second.png", "BB");
  expect(node.querySelector("img")?.src).toBe("https://assets.example.test/second.png");
  await render(null, "CC");
  expect(node.textContent).toBe("CC");
  expect(node.querySelector("img")).toBeNull();
  await act(async () => root.unmount());
});
