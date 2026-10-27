import type { Range } from "@tanstack/react-virtual";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { KeyboardEvent } from "react";
import { cloneElement, Fragment, useCallback, useEffect, useRef, useState } from "react";

import type { CandidateWindowProps } from "./CandidateWindow";

/** Virtualizes measured rows, retaining the focused row so scrolling never discards focus. */
export function VirtualCandidateWindow({
  itemKeys,
  mode,
  label,
  header,
  renderRow,
  offsets,
  cardGridClassName = "grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
  className = "",
  tableClassName = "w-full min-w-[960px] table-fixed border-collapse text-left text-sm",
}: CandidateWindowProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const [cardGrid, setCardGrid] = useState({ columns: 1, gap: 12 });
  const [focusedKey, setFocusedKey] = useState<string>();
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || mode !== "cards") return;
    const measureGrid = () => {
      const grid = scroll.querySelector<HTMLElement>("[data-candidate-grid]");
      if (!grid) return;
      const style = getComputedStyle(grid);
      const columns = Math.max(1, style.gridTemplateColumns.split(" ").filter(Boolean).length);
      const gap = Number.parseFloat(style.rowGap) || 0;
      setCardGrid((current) =>
        current.columns === columns && current.gap === gap ? current : { columns, gap },
      );
    };
    measureGrid();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureGrid);
    observer?.observe(scroll);
    window.addEventListener("resize", measureGrid);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureGrid);
    };
  }, [mode, cardGridClassName]);
  const columns = mode === "table" ? 1 : cardGrid.columns;
  const count = Math.ceil(itemKeys.length / columns);
  const focusedIndex = focusedKey ? itemKeys.indexOf(focusedKey) : -1;
  const getItemKey = useCallback(
    (index: number) => itemKeys[index * columns]!,
    [itemKeys, columns],
  );
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => (mode === "table" ? 100 : 320),
    overscan: 4,
    enabled: true,
    initialOffset: () => offsets.current[mode].offset,
    initialMeasurementsCache: offsets.current[mode].measurements,
    onChange: (instance) => {
      offsets.current[mode] = {
        offset: instance.scrollOffset ?? 0,
        measurements: instance.takeSnapshot(),
      };
    },
    scrollPaddingStart: mode === "table" ? 40 : 0,
    rangeExtractor: useCallback(
      (range: Range) => {
        const indexes = defaultRangeExtractor(range);
        if (focusedIndex >= 0) indexes.push(Math.floor(focusedIndex / columns));
        return [...new Set(indexes)].sort((a, b) => a - b);
      },
      [focusedIndex, columns],
    ),
  });
  const firstKey = itemKeys[0];
  const previousFirstKey = useRef(firstKey);
  useEffect(() => {
    if (previousFirstKey.current !== firstKey) {
      previousFirstKey.current = firstKey;
      offsets.current[mode] = { offset: 0, measurements: [] };
      virtualizer.scrollToOffset(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [firstKey, mode, offsets, virtualizer]);
  const focusRow = (index: number) => {
    setFocusedKey(itemKeys[index]);
    virtualizer.scrollToIndex(Math.floor(index / columns), { align: "auto" });
    let attempts = 0;
    const focus = () => {
      const button = scrollRef.current?.querySelector<HTMLButtonElement>(
        `[data-candidate-index="${index}"] [data-candidate-name]`,
      );
      if (button) button.focus({ preventScroll: true });
      else if (++attempts < 5) requestAnimationFrame(focus);
    };
    requestAnimationFrame(focus);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-candidate-name]"))
      return;
    const index = Number(
      event.target.closest("[data-candidate-index]")?.getAttribute("data-candidate-index"),
    );
    const next =
      event.key === "ArrowDown"
        ? Math.min(itemKeys.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? itemKeys.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    focusRow(next);
  };
  const row = (index: number, measured = false) =>
    cloneElement(renderRow(index), {
      key: itemKeys[index],
      "data-candidate-index": index,
      ...(mode === "table"
        ? { "aria-rowindex": index + 2 }
        : { "aria-posinset": index + 1, "aria-setsize": itemKeys.length }),
      ...(measured ? { "data-index": index, ref: virtualizer.measureElement } : {}),
    });
  const spacer = (size: number, key: string) =>
    mode === "table" ? (
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: This inert spacer contains no focusable content.
      <tr key={key} aria-hidden="true">
        <td colSpan={20} style={{ height: size, padding: 0, border: 0 }} />
      </tr>
    ) : (
      <li key={key} aria-hidden="true" style={{ height: size }} />
    );
  const items = virtualizer.getVirtualItems();
  const content = (
    <>
      {items.map((item, position) => {
        const gap = item.start - (items[position - 1]?.end ?? 0);
        return (
          <Fragment key={item.key}>
            {gap > 0 ? spacer(gap, `before-${item.key}`) : null}
            {mode === "table" ? (
              row(item.index, true)
            ) : (
              <li
                role="presentation"
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{ paddingBottom: cardGrid.gap }}
              >
                <ul
                  role="presentation"
                  data-candidate-grid
                  className={cardGridClassName}
                  style={{ paddingBlock: 0 }}
                >
                  {Array.from(
                    { length: Math.min(columns, itemKeys.length - item.index * columns) },
                    (_, lane) => row(item.index * columns + lane),
                  )}
                </ul>
              </li>
            )}
          </Fragment>
        );
      })}
      {spacer(Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)), "after")}
    </>
  );
  const events = {
    onKeyDown: keyboard,
    onScroll: () => {
      if (scrollRef.current) offsets.current[mode].offset = scrollRef.current.scrollTop;
    },
    onFocusCapture: (event: { target: EventTarget }) => {
      if (event.target instanceof HTMLElement) {
        const index = event.target
          .closest("[data-candidate-index]")
          ?.getAttribute("data-candidate-index");
        if (index !== null && index !== undefined) setFocusedKey(itemKeys[Number(index)]);
      }
    },
    onBlurCapture: (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        setFocusedKey(undefined);
    },
  };
  if (mode === "table")
    return (
      <section
        ref={scrollRef}
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must focus the scrollable candidate viewport.
        tabIndex={0}
        {...events}
        className={`max-h-[70vh] max-w-full overflow-auto rounded-xl border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring ${className}`}
      >
        <table aria-rowcount={itemKeys.length + 1} className={tableClassName}>
          {header}
          <tbody>{content}</tbody>
        </table>
      </section>
    );
  return (
    <section
      ref={scrollRef}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must focus the scrollable candidate viewport.
      tabIndex={0}
      {...events}
      className="max-h-[70vh] overflow-auto focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ul aria-label={label} className="min-w-0">
        {content}
      </ul>
    </section>
  );
}
