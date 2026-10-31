import type { VirtualItem } from "@tanstack/react-virtual";
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from "react";
import { cloneElement, useEffect, useRef } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";

export type CandidateWindowProps = {
  itemKeys: readonly string[];
  mode: "table" | "cards";
  label: string;
  header?: ReactNode;
  cardGridClassName?: string;
  tableClassName?: string;
  className?: string;
  renderRow: (index: number) => ReactElement<Record<string, unknown>>;
  offsets: RefObject<Record<"table" | "cards", { offset: number; measurements: VirtualItem[] }>>;
};

/** True when the new list is the old one with a few people (at most ten, under half) added or moved to the top. */
export function keepsReadingPlace(previous: readonly string[], next: readonly string[]) {
  const top = next.indexOf(previous[0] ?? "");
  if (top < 1 || top > 10 || top * 2 >= next.length) return false;
  const moved = new Set(next.slice(0, top));
  const nextKeys = new Set(next);
  const previousKeys = new Set(previous);
  const expected = previous.filter((key) => !moved.has(key) && nextKeys.has(key));
  const actual = next.slice(top).filter((key) => previousKeys.has(key));
  return expected.length === actual.length && expected.every((key, i) => key === actual[i]);
}

const VirtualCandidateWindow = lazyPanel(() =>
  import("./VirtualCandidateWindow").then((module) => module.VirtualCandidateWindow),
);

/** Small lists keep their full DOM; only the existing >80-row threshold loads windowing. */
export function CandidateWindow(props: CandidateWindowProps) {
  return props.itemKeys.length > 80 ? (
    <VirtualCandidateWindow {...props} />
  ) : (
    <SmallCandidateWindow {...props} />
  );
}

function SmallCandidateWindow({
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
  const firstKey = itemKeys[0];
  const previousKeys = useRef(itemKeys);
  useEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = itemKeys;
    if (previous[0] !== firstKey) {
      // A few people added or updated above keep the reader's place; a new sort or filter resets it.
      if (keepsReadingPlace(previous, itemKeys)) return;
      offsets.current[mode] = { offset: 0, measurements: [] };
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [firstKey, itemKeys, mode, offsets]);
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
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLButtonElement>(`[data-candidate-index="${next}"] [data-candidate-name]`)
        ?.focus({ preventScroll: true });
    });
  };
  const content = itemKeys.map((key, index) =>
    cloneElement(renderRow(index), {
      key,
      "data-candidate-index": index,
      ...(mode === "table"
        ? { "aria-rowindex": index + 2 }
        : { "aria-posinset": index + 1, "aria-setsize": itemKeys.length }),
    }),
  );
  const events = {
    onKeyDown: keyboard,
    onScroll: () => {
      if (scrollRef.current) offsets.current[mode].offset = scrollRef.current.scrollTop;
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
        className={`candidate-viewport max-h-[70vh] max-w-full overflow-auto rounded-xl border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring ${className}`}
      >
        <table aria-rowcount={itemKeys.length + 1} className={tableClassName}>
          {header}
          <tbody>{content}</tbody>
        </table>
      </section>
    );
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must focus the candidate viewport.
    <section ref={scrollRef} aria-label={label} tabIndex={0} {...events} className="min-w-0">
      <ul aria-label={label} data-candidate-grid className={cardGridClassName}>
        {content}
      </ul>
    </section>
  );
}
