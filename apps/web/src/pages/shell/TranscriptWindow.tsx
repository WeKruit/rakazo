import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, RefObject } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Measured transcript rows share the existing scroll viewport and tail-follow policy. */
export function TranscriptWindow<T>({
  items,
  itemKey,
  containsMessage,
  renderItem,
  scrollRef,
  following,
  jumpMessageId,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  containsMessage: (item: T, id: string) => boolean;
  renderItem: (item: T) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  following: RefObject<boolean>;
  jumpMessageId?: string;
}) {
  const [focusedKey, setFocusedKey] = useState<string>();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    const retainSelection = () => {
      const selection = window.getSelection();
      const keys = new Set<string>();
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        for (const row of scrollRef.current?.querySelectorAll<HTMLElement>(
          "[data-transcript-key]",
        ) ?? []) {
          if (range.intersectsNode(row)) keys.add(row.dataset.transcriptKey!);
        }
      }
      setSelectedKeys((previous) =>
        previous.size === keys.size && [...keys].every((key) => previous.has(key))
          ? previous
          : keys,
      );
    };
    document.addEventListener("selectionchange", retainSelection);
    return () => document.removeEventListener("selectionchange", retainSelection);
  }, [scrollRef]);
  const selectedIndexes = items.flatMap((item, index) =>
    selectedKeys.has(itemKey(item)) ? [index] : [],
  );
  const enabled = items.length > 80;
  const focusedIndex = items.findIndex((item) => itemKey(item) === focusedKey);
  const jumpIndex = jumpMessageId
    ? items.findIndex((item) => containsMessage(item, jumpMessageId))
    : -1;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => itemKey(items[index]!),
    estimateSize: () => 160,
    overscan: 5,
    enabled: enabled && mounted,
    rangeExtractor: useCallback(
      (range) => {
        const indexes = [...defaultRangeExtractor(range), ...selectedIndexes];
        if (focusedIndex >= 0) indexes.push(focusedIndex);
        if (jumpIndex >= 0) indexes.push(jumpIndex);
        return [...new Set(indexes)].sort((a, b) => a - b);
      },
      [focusedIndex, jumpIndex, selectedIndexes],
    ),
    onChange: (instance) => {
      // Streaming images, markdown and lazy renderers can grow after the parent commit.
      if (following.current && !jumpMessageId && scrollRef.current) {
        scrollRef.current.scrollTop = instance.getTotalSize();
      }
    },
  });
  const previousJump = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (enabled && jumpIndex >= 0 && previousJump.current !== jumpMessageId) {
      following.current = false;
      virtualizer.scrollToIndex(jumpIndex, { align: "center" });
    }
    previousJump.current = jumpMessageId;
  }, [enabled, following, jumpIndex, jumpMessageId, virtualizer]);
  if (!enabled)
    return items.map((item) => <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>);
  return (
    <div
      data-testid="virtual-transcript"
      style={{ height: virtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}
      onFocusCapture={(event) =>
        setFocusedKey(
          (event.target as HTMLElement).closest<HTMLElement>("[data-transcript-key]")?.dataset
            .transcriptKey,
        )
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusedKey(undefined);
      }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-transcript-key={item.key}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${item.start}px)`,
            paddingBottom: 8,
          }}
        >
          {renderItem(items[item.index]!)}
        </div>
      ))}
    </div>
  );
}
