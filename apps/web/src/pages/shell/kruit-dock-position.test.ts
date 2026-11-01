import { expect, it } from "vitest";
import { clampOffset, findFreeOffset } from "./kruit-dock-position";

const viewport = { width: 1000, height: 800 };
const box = { width: 48, height: 48 };
const inRect = (x: number, y: number, r: { l: number; t: number; w: number; h: number }) =>
  x >= r.l && x <= r.l + r.w && y >= r.t && y <= r.t + r.h;

it("sits in the bottom right corner when nothing is there", () => {
  expect(findFreeOffset(box, viewport, () => false)).toEqual({ right: 16, bottom: 16 });
});

it("never lands on a control: rises above a send button in the corner", () => {
  const send = { l: 940, t: 744, w: 40, h: 40 };
  const offset = findFreeOffset(box, viewport, (x, y) => inRect(x, y, send));
  const left = viewport.width - offset.right - box.width;
  const top = viewport.height - offset.bottom - box.height;
  for (let x = left; x <= left + box.width; x += 4)
    for (let y = top; y <= top + box.height; y += 4) expect(inRect(x, y, send)).toBe(false);
});

it("keeps clear of the box around a composer, not only its buttons", () => {
  const composer = { l: 520, t: 740, w: 460, h: 48 };
  const offset = findFreeOffset(box, viewport, (x, y) => inRect(x, y, composer));
  const left = viewport.width - offset.right - box.width;
  const top = viewport.height - offset.bottom - box.height;
  const apart =
    left + box.width < composer.l ||
    left > composer.l + composer.w ||
    top + box.height < composer.t ||
    top > composer.t + composer.h;
  expect(apart).toBe(true);
});

it("moves to the left edge when the whole right edge is taken", () => {
  const rightColumn = { l: 900, t: 0, w: 100, h: 800 };
  const offset = findFreeOffset(box, viewport, (x, y) => inRect(x, y, rightColumn));
  expect(offset.right).toBe(viewport.width - box.width - 16);
});

it("keeps a dragged position inside the window", () => {
  expect(clampOffset({ right: -50, bottom: 5000 }, box, viewport)).toEqual({
    right: 8,
    bottom: 744,
  });
});

it("when every spot is partly covered, picks the least covered one, not the corner", () => {
  // Controls fill the bottom 200px across the width except a 60px gap at the very top of it.
  const strip = { l: 0, t: 600, w: 1000, h: 200 };
  const offset = findFreeOffset(box, viewport, (x, y) => inRect(x, y, strip) && y > 640);
  expect(offset.bottom).toBeGreaterThan(16);
});
