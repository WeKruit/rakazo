/**
 * Browsers (web and the Electron renderer) authenticate with the HttpOnly
 * session cookie, so script there never needs the bearer token. Native apps
 * send a custom-scheme origin and keep reading the token from the body.
 */
export function isBrowserRequest(request: Request): boolean {
  if (request.headers.has("sec-fetch-mode")) return true;
  const origin = request.headers.get("origin") ?? "";
  return origin.startsWith("http://") || origin.startsWith("https://");
}

/**
 * Drop the bearer token a sign-in, sign-up or password change hands back,
 * from both the JSON body and the bearer plugin's response header, when the
 * caller is a browser. The session cookie is untouched.
 */
export async function withoutBrowserToken(request: Request, response: Response): Promise<Response> {
  if (!isBrowserRequest(request)) return response;
  const headers = new Headers(response.headers);
  let changed = headers.has("set-auth-token");
  headers.delete("set-auth-token");
  const exposed = headers.get("access-control-expose-headers");
  if (exposed) {
    const kept = exposed
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name && name.toLowerCase() !== "set-auth-token");
    if (kept.length) headers.set("access-control-expose-headers", kept.join(", "));
    else headers.delete("access-control-expose-headers");
  }
  let body: ReadableStream<Uint8Array> | string | null = response.body;
  if ((headers.get("content-type") ?? "").includes("application/json")) {
    const text = await response.text();
    body = text;
    try {
      const parsed: unknown = JSON.parse(text);
      const stripped = stripToken(parsed);
      if (stripped !== parsed) {
        body = JSON.stringify(stripped);
        headers.delete("content-length");
        changed = true;
      }
    } catch {
      // Not JSON after all: pass the text through unchanged.
    }
  }
  if (!changed) return new Response(body, response);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function stripToken(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let result: Record<string, unknown> = value;
  if (typeof value.token === "string") {
    const { token: _token, ...rest } = value;
    result = rest;
  }
  if (isRecord(result.session) && typeof result.session.token === "string") {
    const { token: _token, ...session } = result.session;
    result = { ...result, session };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
