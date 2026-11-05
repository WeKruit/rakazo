import { useRef } from "react";

/** Returns the previous value while the new one has the same JSON content. Meant for small lists. */
export function useSameContent<T>(value: T): T {
  const kept = useRef<{ key: string; value: T } | null>(null);
  const key = JSON.stringify(value) ?? "";
  if (kept.current?.key !== key) kept.current = { key, value };
  return kept.current.value;
}
