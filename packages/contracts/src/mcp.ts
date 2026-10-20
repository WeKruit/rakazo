import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** Configuration for an existing OAuth client; never part of a server DTO. */
export const McpOAuthConfigInput = z
  .object({
    clientId: z.string().trim().min(1).max(2048),
    clientSecret: z.string().min(1).max(16384).optional(),
    scopes: z.array(z.string().trim().min(1).max(2048).regex(/^\S+$/)).min(1).max(64).optional(),
    authorizationParams: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.string().max(2048))
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const params = value.authorizationParams ?? {};
    if (Object.keys(params).length > 16)
      context.addIssue({
        code: "custom",
        message: "At most 16 authorization parameters are allowed",
      });
    for (const key of Object.keys(params)) {
      if (
        /^(state|client_id|redirect_uri|response_type|response_mode|request|request_uri|code.*|resource|scope)$/i.test(
          key,
        ) ||
        /secret|token|password|assertion|credential/i.test(key)
      ) {
        context.addIssue({
          code: "custom",
          message: "Authorization parameters cannot override protocol or credential fields",
        });
      }
    }
    if (
      value.clientSecret &&
      [value.clientId, ...(value.scopes ?? []), ...Object.values(params)].some((item) =>
        item.includes(value.clientSecret!),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Keep the client secret only in its dedicated field",
      });
    }
  });
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigInput>;

export function isLocalMcpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export const McpRemoteEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      if (value.endsWith("#")) return false;
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      // Persist HTTP(S). Runtime SSRF still requires HTTPS for public hosts and
      // blocks private LAN targets unless the deployment-owner escape is on.
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "MCP remote endpoint must be an HTTP(S) URL without credentials or a fragment");

export const McpHeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({ code: "custom", message: "At most 32 headers are allowed" });
    }
  });
