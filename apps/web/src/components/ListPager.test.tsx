// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ListPager, pagerItems } from "./ListPager";

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Pagination: (props: ComponentProps<"nav">) => <nav {...props} />,
  PaginationContent: (props: ComponentProps<"ul">) => <ul {...props} />,
  PaginationItem: (props: ComponentProps<"li">) => <li {...props} />,
  PaginationEllipsis: () => <span aria-hidden />,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (text, part, index) => text + part + (index < values.length ? values[index] : ""),
        "",
      ),
  }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows first, last and the pages around the current one", () => {
  expect(pagerItems(0, 1)).toEqual([0]);
  expect(pagerItems(0, 5)).toEqual([0, 1, null, 4]);
  expect(pagerItems(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(pagerItems(10, 40)).toEqual([0, null, 9, 10, 11, null, 39]);
  expect(pagerItems(39, 40)).toEqual([0, null, 38, 39]);
});

it("moves back, forward, to a numbered page and to a typed page", () => {
  const onPage = vi.fn();
  act(() => root.render(<ListPager page={10} pageCount={40} onPage={onPage} />));
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(button("Page 11").getAttribute("aria-current")).toBe("page");
  act(() => button("Previous page").click());
  act(() => button("Next page").click());
  act(() => button("Page 40").click());
  expect(onPage.mock.calls).toEqual([[9], [11], [39]]);

  const input = host.querySelector<HTMLInputElement>('input[aria-label="Go to page"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, "25");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.form!.requestSubmit());
  expect(onPage).toHaveBeenLastCalledWith(24);
});

it("stays out of the way for a single page and disables the ends", () => {
  act(() => root.render(<ListPager page={0} pageCount={1} onPage={() => undefined} />));
  expect(host.querySelector("nav")).toBeNull();
  act(() => root.render(<ListPager page={0} pageCount={3} onPage={() => undefined} />));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.disabled).toBe(
    true,
  );
  expect(host.querySelector('input[aria-label="Go to page"]')).toBeNull();
});
