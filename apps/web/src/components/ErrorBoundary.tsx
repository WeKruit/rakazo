import { Trans } from "@lingui/react/macro";
import { Skeleton } from "@rakazo/ui-web";
import type { ComponentType, ReactNode } from "react";
import { Component, lazy, Suspense } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

/** Keeps a render failure (or a lazy chunk that failed to load) inside its subtree. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Inline fallback for a lazily loaded section inside an otherwise working panel. */
export function SectionLoadFailed() {
  return (
    <div className="px-2.5 pb-2 text-[13px] text-destructive">
      <Trans>Could not load</Trans>
    </div>
  );
}

/** A panel keeps its own loading/error boundary so a cold chunk cannot blank the shell. */
export function lazyPanel<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  pending?: (props: Props) => ReactNode,
) {
  const Panel = lazy(() => load().then((component) => ({ default: component })));
  return function LazyPanel(props: Props) {
    return (
      <ErrorBoundary fallback={<SectionLoadFailed />}>
        <Suspense
          fallback={
            pending?.(props) ?? (
              <div aria-busy="true" className="space-y-3 p-4">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-24 w-full" />
              </div>
            )
          }
        >
          <Panel {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
