import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./pdf-text.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

// A complete, two-page PDF with valid byte offsets; no external fixture or PDF writer.
function pdfWithPages(pages: string[]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, i) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PDF text extraction with installed Poppler", () => {
  it("extracts both complete pages in order", async () => {
    const text = await extractPdfText(
      pdfWithPages(["FIRST PAGE evidence", "SECOND PAGE evidence"]),
    );
    expect(text).toContain("FIRST PAGE evidence");
    expect(text).toContain("SECOND PAGE evidence");
    expect(text.indexOf("FIRST PAGE")).toBeLessThan(text.indexOf("SECOND PAGE"));
  });

  it("rejects invalid and textless PDFs with safe PDF-specific errors", async () => {
    await expect(extractPdfText(Buffer.from("not a PDF"))).rejects.toThrow(
      "Unable to extract readable text from this PDF.",
    );
    await expect(extractPdfText(pdfWithPages([""]))).rejects.toThrow(
      "Unable to extract readable text from this PDF.",
    );
  });
});

describe("PDF extraction process boundary (mocked converter)", () => {
  it("rejects empty and oversized input before starting a converter", async () => {
    await expect(extractPdfText(new Uint8Array())).rejects.toThrow(/PDF/);
    await expect(extractPdfText(new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).rejects.toThrow(/PDF/);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});

type ConverterCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockConverter(result: {
  error?: Error;
  stdout?: string;
  stderr?: string;
  stdinError?: Error;
}) {
  const stdin = new PassThrough();
  const child = { stdin, kill: vi.fn() };
  vi.mocked(childProcess.execFile).mockImplementationOnce(((
    _command: unknown,
    _args: unknown,
    _options: unknown,
    callback: ConverterCallback,
  ) => {
    queueMicrotask(() => {
      if (result.stdinError) stdin.emit("error", result.stdinError);
      callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    });
    return child;
  }) as unknown as typeof childProcess.execFile);
  return child;
}

describe("PDF extraction process isolation (mocked converter)", () => {
  it("uses fixed arguments and budgets while preserving source text", async () => {
    const child = mockConverter({ stdout: "  source evidence\n\n" });
    const bytes = pdfWithPages(["evidence"]);
    await expect(extractPdfText(bytes)).resolves.toBe("  source evidence\n\n");
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-nopgbrk", "-", "-"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" },
      expect.any(Function),
    );
    expect(child.stdin.read()).toEqual(Buffer.from(bytes));
  });

  it.each([
    { error: Object.assign(new Error("missing /private/converter"), { code: "ENOENT" }) },
    { error: Object.assign(new Error("secret timeout details"), { killed: true }) },
    {
      error: Object.assign(new Error("secret oversized output"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    },
    { error: new Error("password-required PDF"), stderr: "secret password or path" },
    { stdout: "partial evidence", stderr: "corrupt document repaired" },
  ])("normalizes process failure or warning without leaking details: %o", async (result) => {
    mockConverter(result);
    await expect(extractPdfText(pdfWithPages(["evidence"]))).rejects.toEqual(
      new Error("Unable to extract readable text from this PDF."),
    );
  });

  it("handles a converter closing stdin early without an unhandled EPIPE", async () => {
    mockConverter({
      stdinError: Object.assign(new Error("secret pipe details"), { code: "EPIPE" }),
    });
    await expect(extractPdfText(pdfWithPages(["evidence"]))).rejects.toEqual(
      new Error("Unable to extract readable text from this PDF."),
    );
  });

  it("normalizes synchronous process creation errors", async () => {
    vi.mocked(childProcess.execFile).mockImplementationOnce(() => {
      throw new Error("private process detail");
    });
    await expect(extractPdfText(pdfWithPages(["evidence"]))).rejects.toEqual(
      new Error("Unable to extract readable text from this PDF."),
    );
  });
});
