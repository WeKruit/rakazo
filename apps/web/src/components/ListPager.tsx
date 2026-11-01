import { useLingui } from "@lingui/react/macro";
import {
  Button,
  Input,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

/** Page numbers to show (0-based), with `null` for a gap: first, last, and two around the current. */
export function pagerItems(page: number, pageCount: number): (number | null)[] {
  const shown = new Set([0, pageCount - 1, page - 1, page, page + 1]);
  // Fill a one-page gap instead of hiding a single number behind an ellipsis.
  if (page - 2 === 1) shown.add(1);
  if (page + 2 === pageCount - 2) shown.add(pageCount - 2);
  const items: (number | null)[] = [];
  for (const value of [...shown].filter((n) => n >= 0 && n < pageCount).sort((a, b) => a - b)) {
    const previous = items.at(-1);
    if (typeof previous === "number" && value > previous + 1) items.push(null);
    items.push(value);
  }
  return items;
}

/** Page navigation for a server-paged list: previous, numbered pages, next, and jump to a page. */
export function ListPager({
  page,
  pageCount,
  onPage,
  disabled = false,
}: {
  /** 0-based. */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const [jump, setJump] = useState("");
  if (pageCount <= 1) return null;
  const go = (next: number) => {
    const target = Math.min(pageCount - 1, Math.max(0, next));
    if (target !== page) onPage(target);
  };
  return (
    <Pagination aria-label={t`Pages`} className="mx-0 w-auto justify-start">
      <PaginationContent>
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Previous page`}
            disabled={disabled || page === 0}
            onClick={() => go(page - 1)}
          >
            <ChevronLeft />
          </Button>
        </PaginationItem>
        {pagerItems(page, pageCount).map((item, index) =>
          item === null ? (
            <PaginationItem key={`gap-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <Button
                variant={item === page ? "outline" : "ghost"}
                size="sm"
                className="min-w-8 tabular-nums"
                aria-label={t`Page ${item + 1}`}
                aria-current={item === page ? "page" : undefined}
                disabled={disabled}
                onClick={() => go(item)}
              >
                {item + 1}
              </Button>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Next page`}
            disabled={disabled || page >= pageCount - 1}
            onClick={() => go(page + 1)}
          >
            <ChevronRight />
          </Button>
        </PaginationItem>
        {pageCount > 7 ? (
          <PaginationItem>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(jump);
                if (Number.isSafeInteger(value) && value >= 1) go(value - 1);
                setJump("");
              }}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={pageCount}
                value={jump}
                placeholder={String(page + 1)}
                aria-label={t`Go to page`}
                disabled={disabled}
                onChange={(event) => setJump(event.target.value)}
                className="h-8 w-16 tabular-nums"
              />
            </form>
          </PaginationItem>
        ) : null}
      </PaginationContent>
    </Pagination>
  );
}
