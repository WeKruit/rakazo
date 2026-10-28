import type { ComponentType } from "react";
import { memo, useRef } from "react";

type Props = Record<string, unknown>;

function sameValues(previous: Props, next: Props) {
  const keys = Object.keys(next);
  return (
    keys.length === Object.keys(previous).length &&
    keys.every((key) =>
      typeof next[key] === "function"
        ? typeof previous[key] === "function"
        : Object.is(previous[key], next[key]),
    )
  );
}

/**
 * Memoizes a component whose parent re-renders often and passes fresh inline handlers. It
 * re-renders only when a non-function prop changes; every function prop is a stable stand-in
 * that calls the parent's latest function, so handlers never act on stale state.
 */
export function memoWithLatestHandlers<P extends object>(Component: ComponentType<P>) {
  const Inner = memo(Component as ComponentType<Props>, sameValues);
  function Latest(props: P) {
    const latest = useRef(props as Props);
    latest.current = props as Props;
    const standIns = useRef(new Map<string, (...args: unknown[]) => unknown>());
    const stable: Props = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== "function") {
        stable[key] = value;
        continue;
      }
      let standIn = standIns.current.get(key);
      if (!standIn) {
        standIn = (...args) => (latest.current[key] as (...args: unknown[]) => unknown)(...args);
        standIns.current.set(key, standIn);
      }
      stable[key] = standIn;
    }
    return <Inner {...stable} />;
  }
  Latest.displayName = `Latest(${Component.displayName ?? Component.name})`;
  return Latest;
}
