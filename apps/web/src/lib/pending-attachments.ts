export type PendingAttachmentPreview = {
  previewUrl?: string;
};

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types" | "items"> | null): boolean {
  if (!dataTransfer) return false;
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

export function isFilePaste(
  clipboardData: Pick<DataTransfer, "files" | "items"> | null | undefined,
): boolean {
  if (!clipboardData) return false;
  // Require a non-empty FileList. Some browsers advertise file-kind items with
  // an empty files list; those must not intercept native text paste.
  return (clipboardData.files?.length ?? 0) > 0;
}

export function revokePendingAttachmentPreviews(
  attachments: readonly PendingAttachmentPreview[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? (result.split(",")[1] ?? "") : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

type UploadTarget = { botId: string } | { groupId: string };
type UploadOptions = { clientNonce?: string };

/**
 * Attachments are read the moment they are picked, and Send uploads them all in parallel.
 * Nothing is stored on the server before Send, so a removed or redirected attachment
 * (new role, feedback) never leaves a file behind.
 */
export function createAttachmentUploads(
  upload: (
    file: File,
    contentBase64: string,
    target: UploadTarget,
    options?: UploadOptions,
  ) => Promise<string>,
  read: (file: File) => Promise<string> = readFileAsBase64,
) {
  const reads = new Map<string, Promise<string>>();
  const begin = (id: string, file: File) => {
    const content = read(file);
    // Send awaits it and reports the failure; until then it must not be unhandled.
    content.catch(() => undefined);
    reads.set(id, content);
    return content;
  };
  const resolveOne = async (
    { id, file }: { id: string; file: File },
    target: UploadTarget,
    options?: UploadOptions,
  ) => {
    const early = reads.get(id);
    const content = await (early ?? begin(id, file)).catch(() => begin(id, file));
    return upload(file, content, target, options);
  };
  return {
    start: begin,
    discard(id: string) {
      reads.delete(id);
    },
    resolveOne,
    /** Artifact ids in pick order. A failed early read is retried once. */
    async resolve(
      attachments: ReadonlyArray<{ id: string; file: File }>,
      target: UploadTarget,
    ): Promise<string[]> {
      const ids = await Promise.all(
        attachments.map((attachment) => resolveOne(attachment, target)),
      );
      for (const { id } of attachments) reads.delete(id);
      return ids;
    },
  };
}
