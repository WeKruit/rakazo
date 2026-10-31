import type { CanvasBlock, CanvasJson, MessageBlock } from "@rakazo/contracts";
import { CANVAS_STATE_MAX_BYTES } from "@rakazo/contracts";
import { lockedCardMessage, rewriteCardMessage } from "./card-blocks.js";
import type { PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

function isCanvas(block: MessageBlock, canvasId: string): block is CanvasBlock {
  return block.kind === "canvas" && block.canvasId === canvasId;
}

export function canvasOf(blocks: MessageBlock[], canvasId: string): CanvasBlock | undefined {
  return blocks.find((block): block is CanvasBlock => isCanvas(block, canvasId));
}

export type CanvasChange =
  | { ok: true; block: CanvasBlock; threadId: string; eventSeq: number }
  | { ok: false; error: string };

/** Rewrites one canvas of this conversation in place: new HTML from its agent, or app data. */
export async function changeCanvas(
  prisma: PrismaClient,
  input: {
    threadId: string;
    canvasId: string;
    change: { html: string; title: string } | { state: CanvasJson };
  },
): Promise<CanvasChange> {
  if ("state" in input.change) {
    const bytes = new TextEncoder().encode(JSON.stringify(input.change.state ?? null)).length;
    if (bytes > CANVAS_STATE_MAX_BYTES)
      return { ok: false, error: `Saved data is limited to ${CANVAS_STATE_MAX_BYTES} bytes.` };
  }
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const message = await lockedCardMessage(tx, {
        threadId: input.threadId,
        match: { kind: "canvas", canvasId: input.canvasId },
      });
      const canvas = message && canvasOf(message.blocks, input.canvasId);
      if (!message || !canvas) return { ok: false as const, error: "No such canvas here." };
      const block: CanvasBlock =
        "state" in input.change
          ? { ...canvas, state: input.change.state }
          : {
              ...canvas,
              html: input.change.html,
              title: input.change.title,
              revision: canvas.revision + 1,
            };
      const eventSeq = await rewriteCardMessage(
        tx,
        message,
        message.blocks.map((existing) => (isCanvas(existing, input.canvasId) ? block : existing)),
      );
      return { ok: true as const, block, threadId: message.threadId, eventSeq };
    }),
  );
}
