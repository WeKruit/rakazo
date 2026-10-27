import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_MODEL_MAX_TOKENS, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { filterModelCatalog } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import { Check, ChevronDown } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../lib/model-auth";

export function ModelPicker({
  options,
  value,
  onChange,
}: {
  options: ModelCatalogEntry[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const filteredOptions = useMemo(() => filterModelCatalog(options, query), [options, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const option of filteredOptions) {
      const key = option.providerName ?? option.provider;
      const list = grouped.get(key);
      if (list) list.push(option);
      else grouped.set(key, [option]);
    }
    return [...grouped].map(([name, entries]) => ({ name, entries }));
  }, [filteredOptions]);
  const groupRanges = useMemo(() => {
    let index = 0;
    return groups.map((group) => {
      const start = index;
      index += group.entries.length;
      return { name: group.name, start, entries: group.entries };
    });
  }, [groups]);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const option = filteredOptions[index];
    if (!option) return;
    onChange(option.id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    const count = filteredOptions.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setHighlightedIndex(next);
    const option = optionRefs.current[next];
    option?.scrollIntoView({ block: "nearest" });
    // Keep typing focus on the search field; only follow highlight when an option
    // already has focus (e.g. after Tab / prior option key nav).
    if (document.activeElement !== searchRef.current) {
      option?.focus();
    }
  }

  function activeOptionIndex() {
    return highlightedIndex >= 0 && highlightedIndex < filteredOptions.length
      ? highlightedIndex
      : 0;
  }

  function optionDomId(index: number) {
    return `${listboxId}-option-${index}`;
  }

  const activeDescendantId =
    filteredOptions.length > 0 ? optionDomId(activeOptionIndex()) : undefined;

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(filteredOptions.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      choose(activeOptionIndex());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(Math.max(0, filteredOptions.length - 1));
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveHighlight(filteredOptions.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={t`Model`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{options[selectedIndex]?.label}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <input
            ref={searchRef}
            type="text"
            value={query}
            role="combobox"
            aria-label={t`Search models`}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendantId}
            placeholder={t`Search`}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            className="w-full border-b border-border bg-transparent px-3 py-2.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          <div
            id={listboxId}
            role="listbox"
            aria-label={t`Model options`}
            className="rk-scroll max-h-64 overflow-y-auto py-1"
          >
            {groupRanges.map((group) => (
              <div key={group.name}>
                {groupRanges.length > 1 ? (
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                    {group.name}
                  </p>
                ) : null}
                {group.entries.map((option, groupIndex) => {
                  const index = group.start + groupIndex;
                  return (
                    <ModelOption
                      key={`${option.provider}:${option.id}`}
                      option={option}
                      optionDomId={optionDomId(index)}
                      index={index}
                      value={value}
                      highlighted={highlightedIndex === index}
                      optionRefs={optionRefs}
                      choose={choose}
                      onOptionKeyDown={onOptionKeyDown}
                    />
                  );
                })}
              </div>
            ))}
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">
                <Trans>No matching models</Trans>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelOption({
  option,
  optionDomId,
  index,
  value,
  highlighted,
  optionRefs,
  choose,
  onOptionKeyDown,
}: {
  option: ModelCatalogEntry;
  optionDomId: string;
  index: number;
  value: string;
  highlighted: boolean;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  choose: (index: number) => void;
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const { t } = useLingui();
  return (
    <button
      id={optionDomId}
      ref={(element) => {
        optionRefs.current[index] = element;
      }}
      type="button"
      role="option"
      aria-selected={option.id === value}
      tabIndex={highlighted ? 0 : -1}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-[13.5px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent ${
        highlighted ? "bg-accent" : ""
      }`}
      onClick={() => choose(index)}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
    >
      <span className="min-w-0 truncate">{option.label}</span>
      <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
        {option.billing.toLowerCase().includes("free") ? t`Free` : null}
        {option.id === value ? (
          <Check size={14} strokeWidth={2} className="text-foreground" aria-hidden="true" />
        ) : null}
      </span>
    </button>
  );
}

export function ModelDisconnectDialog({
  open,
  onOpenChange,
  name,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Disconnect {name}?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>This removes the connection from every space.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            <Trans>Disconnect</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function connectionMaxTokensField(providerId: string, stored: number | undefined): string {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return String(stored ?? DEFAULT_MODEL_MAX_TOKENS);
  }
  return stored !== undefined ? String(stored) : "";
}
