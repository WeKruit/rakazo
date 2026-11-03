import type { ArtifactStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { saveEmailAttachments } from "./email-attachments.js";
import type { InstantlyEmail } from "./instantly-reply.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMAIL = "22222222-2222-4222-8222-222222222222";
const base = `https://attachments.unibox.instantly.ai/v1/${ORG}/${EMAIL}`;
const pdf = new TextEncoder().encode("%PDF-1.4\nresume\n%%EOF");

function email(files: NonNullable<InstantlyEmail["attachment_json"]>["files"]): InstantlyEmail {
  return {
    id: EMAIL,
    organization_id: ORG,
    from_address_email: "candidate@example.test",
    attachment_json: { files },
  } as unknown as InstantlyEmail;
}

function harness(body: Uint8Array = pdf) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    artifact: {
      findMany: vi.fn(async ({ where }: { where: { OR: Array<{ clientNonce: string }> } }) =>
        rows.filter((row) => where.OR.some((key) => key.clientNonce === row.clientNonce)),
      ),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `artifact-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
    },
  };
  const artifacts = {
    put: vi.fn(async () => ({ id: "stored", hash: "hash" })),
    remove: vi.fn(async () => undefined),
  } as unknown as ArtifactStore;
  const fetch = vi.fn(async () => new Response(body as BodyInit, { status: 200 }));
  const deps = {
    prisma: prisma as never,
    artifacts,
    fetch: fetch as unknown as typeof globalThis.fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  };
  const owner = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    groupId: "group",
    sourceId: "src",
  };
  return { rows, prisma, fetch, deps, owner };
}

describe("saveEmailAttachments", () => {
  it("saves a résumé once and reuses it on the next read", async () => {
    const { deps, owner, fetch, rows } = harness();
    const mail = email([
      {
        filename: "Resume.pdf",
        type: "application/pdf",
        size: pdf.byteLength,
        url: `${base}/Resume.pdf`,
      },
    ]);
    const first = await saveEmailAttachments(deps, owner, mail, { download: true });
    expect(first).toEqual([
      { id: "artifact-1", name: "Resume.pdf", mimeType: "application/pdf", size: pdf.byteLength },
    ]);
    expect(rows[0]).toMatchObject({
      groupId: "group",
      botId: "bot",
      clientNonce: expect.stringContaining(EMAIL),
    });
    expect(rows[0]).not.toHaveProperty("rootArtifactId");
    const again = await saveEmailAttachments(deps, owner, mail, { download: true });
    expect(again).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only reads files Instantly serves for this exact email", async () => {
    const { deps, owner, fetch } = harness();
    const saved = await saveEmailAttachments(
      deps,
      owner,
      email([
        { filename: "a.pdf", url: "https://evil.example/v1/a.pdf" },
        { filename: "b.pdf", url: `https://attachments.unibox.instantly.ai/v1/${ORG}/other/b.pdf` },
        {
          filename: "c.pdf",
          url: `http://attachments.unibox.instantly.ai/v1/${ORG}/${EMAIL}/c.pdf`,
        },
        { filename: "page.html", type: "text/html", url: `${base}/page.html` },
        { filename: "tool.exe", url: `${base}/tool.exe` },
        { filename: "big.pdf", size: 11 * 1024 * 1024, url: `${base}/big.pdf` },
        { filename: "failed.pdf", error: "virus", url: `${base}/failed.pdf` },
      ]),
      { download: true },
    );
    expect(saved).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not the claimed type", async () => {
    const { deps, owner, rows } = harness(new TextEncoder().encode("MZ executable"));
    const saved = await saveEmailAttachments(
      deps,
      owner,
      email([{ filename: "Resume.pdf", url: `${base}/Resume.pdf` }]),
      { download: true },
    );
    expect(saved).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("never downloads when asked only for saved files", async () => {
    const { deps, owner, fetch } = harness();
    const saved = await saveEmailAttachments(
      deps,
      owner,
      email([{ filename: "Resume.pdf", url: `${base}/Resume.pdf` }]),
      { download: false },
    );
    expect(saved).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
