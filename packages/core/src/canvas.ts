import type { CanvasJson } from "@rakazo/contracts";
import { CanvasJsonSchema } from "@rakazo/contracts";

/** The message a canvas app posts to save its data. */
export const CANVAS_SAVE_MESSAGE = "rakazo.canvas.save";

/**
 * Prefixes an agent-written canvas with its saved data and a save function:
 * `window.rakazo.state` holds the data, `window.rakazo.save(next)` keeps it. The frame relays
 * the save to the app (web) or the native view (mobile); nothing else leaves the sandbox.
 */
export function canvasDocument(html: string, state: unknown): string {
  const saved = JSON.stringify(state ?? null).replace(/</g, "\\u003c");
  const bridge = `<script>(function(){var state=${saved};window.rakazo={get state(){return state},save:function(next){state=next;var message={type:"${CANVAS_SAVE_MESSAGE}",state:next};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));else parent.postMessage(message,"*");}};})();</script>`;
  return `${bridge}${html}`;
}

/** The saved data from a canvas message, or undefined when it is something else. */
export function canvasSaveState(data: unknown): { state: CanvasJson } | undefined {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const message = value as { type?: unknown; state?: unknown };
  if (message.type !== CANVAS_SAVE_MESSAGE) return undefined;
  const state = CanvasJsonSchema.safeParse(message.state ?? null);
  return state.success ? { state: state.data } : undefined;
}
