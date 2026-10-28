import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
/** Original IDs are references; artifact_read supplies authorized metadata and content. */
export function messageFileReferences(blocks: unknown) {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block, blockIndex) => {
    if (!block || typeof block !== "object" || !["file", "image"].includes(block.kind)) return [];
    const parsed = MessageBlockSchema.safeParse(block);
    if (!parsed.success || (parsed.data.kind !== "file" && parsed.data.kind !== "image")) return [];
    return [{ blockIndex, artifactId: parsed.data.artifactId }];
  });
}
