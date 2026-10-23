import { describe, expect, it, vi } from "vitest";
import { isFileDrag, isFilePaste, revokePendingAttachmentPreviews } from "./pending-attachments.js";

function fileList(length: number) {
  return { length } as unknown as FileList;
}

function pasteData(files: number, itemKinds: string[] = []) {
  return {
    files: fileList(files),
    items: itemKinds.map((kind) => ({ kind })),
  } as unknown as DataTransfer;
}

function dragData(types: string[], itemKinds: string[] = []) {
  return {
    types,
    items: itemKinds.map((kind) => ({ kind })),
  } as unknown as DataTransfer;
}

describe("isFileDrag", () => {
  it("recognizes files advertised by the drag data", () => {
    expect(isFileDrag(dragData(["Files"]))).toBe(true);
  });

  it("recognizes file items when the Files type is not exposed", () => {
    expect(isFileDrag(dragData([], ["file"]))).toBe(true);
  });

  it("ignores text and other drags", () => {
    expect(isFileDrag(dragData(["text/plain"], ["string"]))).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("isFilePaste", () => {
  it("recognizes pasted files", () => {
    expect(isFilePaste(pasteData(1))).toBe(true);
  });

  it("ignores file-kind items when the file list is empty", () => {
    expect(isFilePaste(pasteData(0, ["file"]))).toBe(false);
  });

  it("ignores text-only pastes", () => {
    expect(isFilePaste(pasteData(0, ["string"]))).toBe(false);
    expect(isFilePaste(null)).toBe(false);
    expect(isFilePaste(undefined)).toBe(false);
  });
});

describe("revokePendingAttachmentPreviews", () => {
  it("revokes each preview URL and skips entries without one", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revokePendingAttachmentPreviews([{ previewUrl: "blob:a" }, {}, { previewUrl: "blob:b" }]);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:b");
    revoke.mockRestore();
  });
});

describe("attachment uploads", () => {
  it("reads on pick and uploads every file at once on send", async () => {
    const { createAttachmentUploads } = await import("./pending-attachments.js");
    const started: string[] = [];
    const finish: Array<() => void> = [];
    const uploads = createAttachmentUploads(
      (file, content) =>
        new Promise<string>((resolve) => {
          started.push(`${file.name}:${content}`);
          finish.push(() => resolve(`artifact-${file.name}`));
        }),
      async (file) => `read-${file.name}`,
    );
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    uploads.start("a", a);
    uploads.start("b", b);
    const ids = uploads.resolve(
      [
        { id: "a", file: a },
        { id: "b", file: b },
      ],
      { botId: "bot" },
    );
    await vi.waitFor(() => expect(started).toEqual(["a.txt:read-a.txt", "b.txt:read-b.txt"]));
    for (const done of finish) done();
    expect(await ids).toEqual(["artifact-a.txt", "artifact-b.txt"]);
  });

  it("retries a failed early read once at send", async () => {
    const { createAttachmentUploads } = await import("./pending-attachments.js");
    const read = vi
      .fn<(file: File) => Promise<string>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue("content");
    const uploads = createAttachmentUploads(async (_file, content) => content, read);
    const file = new File(["x"], "x.txt");
    uploads.start("x", file);
    expect(await uploads.resolve([{ id: "x", file }], { botId: "bot" })).toEqual(["content"]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
