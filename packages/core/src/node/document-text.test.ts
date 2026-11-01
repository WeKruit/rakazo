import { deflateRawSync } from "node:zlib";
import { DOCX_MIME_TYPE } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  extractDocumentText,
  extractDocxText,
  isExtractedDocumentMimeType,
} from "./document-text.js";

// A minimal zip with deflated entries; enough of a .docx for text extraction.
function zip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const documentXml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Senior Engineer</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Salary </w:t></w:r><w:r><w:t>&lt;$200k &amp; equity</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Go</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>上海</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

describe("docx text", () => {
  it("reads paragraphs, runs, entities and table cells", async () => {
    const bytes = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": documentXml });
    const text = extractDocxText(bytes);
    expect(text).toContain("Senior Engineer\nSalary <$200k & equity");
    expect(text).toContain("Go");
    expect(text).toContain("上海");
    expect(await extractDocumentText(bytes, DOCX_MIME_TYPE)).toBe(text);
    expect(isExtractedDocumentMimeType(DOCX_MIME_TYPE)).toBe(true);
  });

  it("rejects files that are not Word documents", () => {
    expect(() => extractDocxText(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => extractDocxText(zip({ "other.xml": "<a/>" }))).toThrow();
    expect(() =>
      extractDocxText(zip({ "word/document.xml": "<w:document><w:body/></w:document>" })),
    ).toThrow();
  });
});
