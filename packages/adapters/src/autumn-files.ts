import type {
  AdapterContext,
  ArtifactStore,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { readActorArtifact } from "./artifact-read.js";
import { readBoundedText } from "./connector-http.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { loadMcpCredentialRecord, requireMcpToolAssignment } from "./mcp-connector.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

const MCP_ENDPOINT = "https://api.autumn.ai/mcp";
const API_ORIGIN = "https://api.autumn.ai";
const Input = z.strictObject({
  task_id: z.string().min(1),
  artifactId: z.string().min(1),
  message: z.string().refine((value) => value.trim().length > 0),
});
const Presigned = z.object({
  upload_url: z.string().url(),
  filename: z.string().min(1),
});
const Validated = z.object({
  filename: z.string().min(1),
  rows: z.number().int().min(0).max(10_000).nullish(),
  fields: z.array(z.string()).nullish(),
  renamed: z.array(z.record(z.string(), z.unknown())).nullish(),
  delimiter: z.string().nullish(),
  extra_columns: z.number().int().nonnegative().nullish(),
});
const Continued = z.object({
  task_id: z.string().min(1),
  status: z.string().nullish(),
  done: z.boolean().optional(),
  queued_count: z.number().int().nonnegative().optional(),
});

export class AutumnFileConnector implements ConnectorProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly artifacts: ArtifactStore,
    private readonly remote: RemoteTransportDependencies = {},
  ) {}

  describe() {
    return {
      id: "autumn-files",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const assignments = await this.prisma.botMcpServer.findMany({
      where: {
        botId: context.botId,
        spaceId: context.spaceId,
        userId: context.userId,
        server: { enabled: true, transport: "streamable_http", endpoint: MCP_ENDPOINT },
      },
      include: { server: true },
    });
    const tools: ConnectorTool[] = [];
    for (const { server } of assignments) {
      const route = {
        connectorId: "autumn-files",
        resourceId: server.id,
        resourceRevision: server.revision,
        toolName: "continue_with_file",
      };
      try {
        await this.authorize(route, context);
        tools.push({
          name: `autumn__${server.slug}__continue_with_file`,
          description:
            "Local Autumn REST file integration. Upload one existing saved artifact in full and continue the same existing task with the validated file. Accepts CSV, text or Markdown up to 10 MB/10,000 rows. Use the exact saved artifactId and original task_id; no computer is needed. Returns the validated filename and real continuation receipt. Accepted or queued is not completed or applied. An uncertain outcome must be checked before retrying; do not create another task. This is a local integration, not an MCP reply parameter.",
          inputSchema: z.toJSONSchema(Input),
          readOnly: false,
          route,
        });
      } catch {
        context.signal.throwIfAborted();
      }
    }
    return tools;
  }

  private async authorize(
    route: ConnectorCall["route"],
    context: AdapterContext,
  ): Promise<{ key: string; secretId: string }> {
    context.signal.throwIfAborted();
    if (route?.connectorId !== "autumn-files" || route.toolName !== "continue_with_file")
      throw new Error("Autumn file route required");
    const { server } = await requireMcpToolAssignment(this.prisma, context, route, "reply");
    if (server.transport !== "streamable_http" || server.endpoint !== MCP_ENDPOINT)
      throw new Error("An assigned official Autumn connection is required");
    const { secret, plaintext } = await loadMcpCredentialRecord(
      this.prisma,
      this.secrets,
      server,
      context,
    );
    context.signal.throwIfAborted();
    if (!secret || !plaintext) throw new Error("An existing API-key credential is required");
    const material = z
      .object({
        secret: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .parse(JSON.parse(plaintext));
    if ("oauth" in material)
      throw new Error("OAuth is not supported for Autumn REST file operations");
    const headers = new Headers(material.headers);
    if (typeof material.secret === "string" && material.secret) {
      headers.set(
        "authorization",
        material.secret.startsWith("Bearer ") ? material.secret : `Bearer ${material.secret}`,
      );
    }
    const authorization = headers.get("authorization");
    const bearer = authorization?.match(/^Bearer (.+)$/i)?.[1];
    const apiKey = headers.get("x-api-key");
    if ((authorization && !bearer) || (bearer && apiKey && bearer !== apiKey))
      throw new Error("An unambiguous API-key credential is required");
    const key = bearer ?? apiKey;
    if (!key) throw new Error("An existing API-key credential is required");
    return { key, secretId: secret.id };
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const parsed = Input.safeParse(call.args);
    if (!parsed.success) {
      yield { type: "error", message: "Invalid Autumn file continuation arguments." };
      return;
    }
    let phase = "authorization";
    let issued = false;
    let rejectedStatus: number | undefined;
    const redactions: string[] = [];
    const safeFetch = createSafeRemoteFetch(this.remote.fetch, this.remote.resolveHostname);
    try {
      const credential = await this.authorize(call.route, context);
      redactions.push(credential.key);
      phase = "saved file verification";
      const { row, bytes } = await readActorArtifact(
        { prisma: this.prisma, artifacts: this.artifacts },
        context,
        { artifactId: parsed.data.artifactId, fromTool: true },
      );
      if (
        bytes.byteLength > 10_000_000 ||
        /[/\\\0]/.test(row.name) ||
        !/\.(csv|txt|md|markdown)$/i.test(row.name)
      )
        throw new Error("A CSV, text or Markdown file up to 10 MB is required");
      const assertAuthorized = async () => {
        const current = await this.authorize(call.route, context);
        if (current.secretId !== credential.secretId || current.key !== credential.key)
          throw new Error("Autumn credentials changed during file continuation");
      };
      const request = async (path: string, body: unknown) => {
        await assertAuthorized();
        issued = true;
        const response = await safeFetch(`${API_ORIGIN}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: context.signal,
        });
        const { text, truncated } = await readBoundedText(response, 1_000_000);
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) rejectedStatus = response.status;
          throw new Error("Autumn file request failed");
        }
        if (truncated) throw new Error("Autumn response exceeded the bounded read");
        return { status: response.status, data: JSON.parse(text) as unknown };
      };
      phase = "upload preparation";
      const presigned = Presigned.parse(
        (await request("/upload-url", { task_id: parsed.data.task_id, filename: row.name })).data,
      );
      redactions.push(presigned.upload_url);
      phase = "file upload";
      await assertAuthorized();
      const uploaded = await safeFetch(presigned.upload_url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(bytes),
        signal: context.signal,
      });
      await readBoundedText(uploaded, 1_000_000);
      if (!uploaded.ok) {
        if (uploaded.status >= 400 && uploaded.status < 500) rejectedStatus = uploaded.status;
        throw new Error("Autumn file upload failed");
      }
      phase = "file validation";
      const validated = Validated.parse(
        (
          await request("/validate-upload", {
            task_id: parsed.data.task_id,
            filename: presigned.filename,
          })
        ).data,
      );
      phase = "task continuation";
      // The existing native effect owns this whole call. An uncertain phase is never replayed here.
      const continued = await request(`/task/${encodeURIComponent(parsed.data.task_id)}/continue`, {
        message: parsed.data.message,
        input_files: [validated.filename],
        wait: false,
      });
      const receipt = Continued.parse(continued.data);
      if (receipt.task_id !== parsed.data.task_id) throw new Error("Autumn task identity changed");
      yield {
        type: "result",
        data: redactConnectorPayload(
          {
            file: { artifactId: row.id, sha256: row.hash, size: bytes.byteLength, ...validated },
            continuation: { httpStatus: continued.status, ...receipt },
          },
          redactions,
        ),
      };
    } catch {
      yield {
        type: "error",
        message: rejectedStatus
          ? `Autumn file continuation was rejected (HTTP ${rejectedStatus}) during ${phase}.`
          : `Autumn file continuation failed during ${phase}.${issued ? " Its outcome may be uncertain; check the existing task before retrying." : " Check the assigned connection and saved file."}`,
        ...(issued && !rejectedStatus ? { outcome: "uncertain" as const } : {}),
      };
    } finally {
      await safeFetch.close().catch(() => undefined);
    }
  }
}
