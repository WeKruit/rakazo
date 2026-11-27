import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  type AttachmentMimeType,
} from "@rakazo/contracts";

export type PickedAttachment = {
  id: string;
  name: string;
  mimeType: AttachmentMimeType;
  contentBase64: string;
  previewUri?: string;
};

export type PickSkip =
  | { name: string; reason: "permission denied" | "over 10 MiB" | "unsupported type" }
  | { name: string; reason: "max attachments"; max: number };

export function filterPickedAttachments(
  existingCount: number,
  candidates: Array<{
    name: string;
    mimeType: string | null;
    size: number;
    contentBase64: string;
    previewUri?: string;
  }>,
): { attachments: PickedAttachment[]; skipped: PickSkip[] } {
  const attachments: PickedAttachment[] = [];
  const skipped: PickSkip[] = [];
  for (const candidate of candidates) {
    if (existingCount + attachments.length >= ATTACHMENT_MAX_COUNT) {
      skipped.push({ name: candidate.name, reason: "max attachments", max: ATTACHMENT_MAX_COUNT });
      continue;
    }
    if (candidate.size > ATTACHMENT_MAX_BYTES) {
      skipped.push({ name: candidate.name, reason: "over 10 MiB" });
      continue;
    }
    if (!candidate.mimeType) {
      skipped.push({ name: candidate.name, reason: "unsupported type" });
      continue;
    }
    attachments.push({
      id: `${candidate.name}-${candidate.size}-${existingCount + attachments.length}`,
      name: candidate.name,
      mimeType: candidate.mimeType as AttachmentMimeType,
      contentBase64: candidate.contentBase64,
      previewUri: candidate.previewUri,
    });
  }
  return { attachments, skipped };
}
