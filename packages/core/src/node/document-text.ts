import { inflateRawSync } from "node:zlib";
import { ATTACHMENT_MAX_BYTES, DOCX_MIME_TYPE } from "@rakazo/contracts";
import { extractPdfText } from "./pdf-text.js";

/** Office documents and PDFs whose text is extracted on the server before an agent reads it. */
export function isExtractedDocumentMimeType(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType === DOCX_MIME_TYPE;
}

export function extractDocumentText(bytes: Uint8Array, mimeType: string): Promise<string> {
  return mimeType === DOCX_MIME_TYPE
    ? Promise.resolve(extractDocxText(bytes))
    : extractPdfText(bytes);
}

const MAX_XML_BYTES = 32 * 1024 * 1024;

/** Paragraph text of a Word .docx, read from word/document.xml without running any host tool. */
export function extractDocxText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_BYTES)
    throw new Error("Document is empty or exceeds the 10 MiB limit.");
  const xml = zipEntry(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    "word/document.xml",
  );
  const text = docxXmlText(xml);
  if (!text.trim()) throw new Error("Unable to extract readable text from this document.");
  return text;
}

function zipEntry(zip: Buffer, name: string): string {
  const fail = () => new Error("Unable to read this document.");
  // End of central directory: the last record, optionally followed by a comment of up to 64 KiB.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw fail();
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw fail();
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const entryName = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw fail();
    const start =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(start, start + compressedSize);
    if (data.length !== compressedSize || size > MAX_XML_BYTES) throw fail();
    try {
      if (method === 0) return data.toString("utf8");
      if (method === 8)
        return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
    } catch {
      throw fail();
    }
    throw fail();
  }
  throw fail();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function docxXmlText(xml: string): string {
  const out: string[] = [];
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<\/w:(p|tc|tr)>/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] !== undefined) out.push(decodeXml(match[1]));
    else if (match[2] === "tab" || match[3] === "tc") out.push("\t");
    else out.push("\n");
  }
  return out
    .join("")
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const point =
      code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}
