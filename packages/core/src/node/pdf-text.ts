import { execFile } from "node:child_process";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";

/** Extract selectable text from verified PDF bytes without granting agent host access. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("PDF is empty or exceeds the 10 MiB limit.");
  }

  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Unable to extract readable text from this PDF."));
    try {
      const child = execFile(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", "-nopgbrk", "-", "-"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" },
        (error, stdout, stderr) => {
          if (error || stderr.trim() || !stdout.trim()) {
            fail();
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {
        child.kill("SIGKILL");
        fail();
      });
      child.stdin?.end(bytes);
    } catch {
      fail();
    }
  });
}
