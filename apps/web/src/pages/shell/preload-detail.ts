import { withFeatureMessages } from "../../lib/i18n";

let started = false;

/** Fetch the person detail code while the list is idle, so the first click is not a network wait. */
export function preloadCandidateDetail() {
  if (started) return;
  started = true;
  const load = () =>
    void withFeatureMessages(() =>
      Promise.all([import("./ShellPanelContent"), import("../recruiting/DetailPanel")]),
    ).catch(() => {
      started = false;
    });
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 500);
}
