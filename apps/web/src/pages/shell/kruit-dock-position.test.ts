import { expect, it } from "vitest";
import { clampOffset, findFreeOffset, type Rect } from "./kruit-dock-position";

const viewport = { width: 1000, height: 800 };
const box = { width: 48, height: 48 };
const rect = (l: number, t: number, w: number, h: number): Rect => ({
  left: l,
  top: t,
  right: l + w,
  bottom: t + h,
});
const dockRect = (offset: { right: number; bottom: number }): Rect =>
  rect(
    viewport.width - offset.right - box.width,
    viewport.height - offset.bottom - box.height,
    box.width,
    box.height,
  );
const touches = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

it("sits in the bottom right corner when nothing is there", () => {
  expect(findFreeOffset(box, viewport, [])).toEqual({ right: 16, bottom: 16 });
});

it("never lands on a control: rises above a send button in the corner", () => {
  const send = rect(940, 744, 40, 40);
  const offset = findFreeOffset(box, viewport, [send]);
  expect(touches(dockRect(offset), send)).toBe(false);
});

it("keeps clear of the box around a composer, not only its buttons", () => {
  const composer = rect(520, 740, 460, 48);
  const offset = findFreeOffset(box, viewport, [composer]);
  expect(touches(dockRect(offset), composer)).toBe(false);
});

it("moves to the left edge when the whole right edge is taken", () => {
  const offset = findFreeOffset(box, viewport, [rect(900, 0, 100, 800)]);
  expect(offset.right).toBe(viewport.width - box.width - 16);
});

it("when every spot is partly covered, picks the least covered one, not the corner", () => {
  const offset = findFreeOffset(box, viewport, [rect(0, 640, 1000, 160)]);
  expect(offset.bottom).toBeGreaterThan(16);
});

it("handles a page full of controls quickly", () => {
  const many = Array.from({ length: 3000 }, (_, i) =>
    rect((i % 60) * 16, Math.floor(i / 60) * 16, 12, 12),
  );
  const started = performance.now();
  findFreeOffset(box, viewport, many);
  expect(performance.now() - started).toBeLessThan(200);
});

it("keeps a dragged position inside the window", () => {
  expect(clampOffset({ right: -50, bottom: 5000 }, box, viewport)).toEqual({
    right: 8,
    bottom: 744,
  });
});
