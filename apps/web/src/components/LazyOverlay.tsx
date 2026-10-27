import { Trans } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
import type { ComponentType } from "react";
import { lazy } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * Lazy-loads an overlay. If its chunk fails to load (network blip, missing
 * chunk) or it throws while rendering, the shell and the composer draft stay
 * up. Browsers keep a failed module import for the page's lifetime, so loading
 * the chunk again takes a page refresh.
 */
export function lazyOverlay<Props extends { onClose: () => void }>(
  load: () => Promise<ComponentType<Props>>,
) {
  const Overlay = lazy(() => load().then((component) => ({ default: component })));
  return function LazyOverlay(props: Props) {
    return (
      <ErrorBoundary
        fallback={
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open) props.onClose();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Could not load</Trans>
                </AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Close</Trans>
                </AlertDialogCancel>
                <Button onClick={() => window.location.reload()}>
                  <Trans>Refresh</Trans>
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      >
        <Overlay {...props} />
      </ErrorBoundary>
    );
  };
}
