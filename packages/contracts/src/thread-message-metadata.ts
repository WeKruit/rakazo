import * as z from "zod";
import type { ThreadMessage } from "./events.js";
import { Id } from "./ids.js";
export const MessageRole = z.enum(["user", "bot", "system"]);
export const ReplyPreviewSchema = z.object({
  role: MessageRole,
  botId: Id.optional(),
  text: z.string(),
  attachment: z
    .object({
      kind: z.enum(["image", "file"]),
      artifactId: Id,
      mimeType: z.string(),
      name: z.string(),
    })
    .optional(),
});
export type ReplyPreview = z.infer<typeof ReplyPreviewSchema>;

export function canReactToThreadMessage(message: Pick<ThreadMessage, "id" | "blocks">): boolean {
  return (
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !message.blocks.some((block) => block.kind === "channel_message")
  );
}
