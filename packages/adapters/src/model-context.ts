import type { Context, ImageContent } from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  estimateTextAndImageContentTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ContextBudget } from "./context-selection.js";
import { imageBlocks } from "./context-selection.js";

/**
 * Native Pi usage plus trailing estimates, including initial system/tool declarations.
 * Only images after that usage need the adapter's dimension estimate or byte bound.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  const transcript = normalizeContext(context);
  const estimate = estimateContextTokens(transcript);
  let tokens = estimate.tokens;
  for (const image of imageBlocks(transcript.messages.slice((estimate.lastUsageIndex ?? -1) + 1))) {
    const planned = typeof imageTokens === "number" ? imageTokens : imageTokens?.(image);
    tokens +=
      (planned !== undefined && Number.isFinite(planned) && planned > 0
        ? planned
        : Buffer.byteLength(JSON.stringify(image), "utf8")) -
      estimateTextAndImageContentTokens([image as ImageContent]);
  }
  return tokens + 240;
}
