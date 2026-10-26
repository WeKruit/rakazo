import { describe, expect, it, vi } from "vitest";
import { withGatewayRetry } from "./mcp-transport.js";

const gatewayPage = () =>
  new Response("<!DOCTYPE html><p>App Platform failed to forward this request</p>", {
    status: 503,
    headers: { "content-type": "text/html" },
  });
const post = (method: string) => ({
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
});

describe("MCP gateway retry", () => {
  it("repeats the handshake and tool listing after a gateway error page", async () => {
    for (const method of ["initialize", "tools/list"]) {
      const inner = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(gatewayPage())
        .mockResolvedValueOnce(new Response("{}", { status: 504 }))
        .mockResolvedValueOnce(Response.json({ ok: true }));
      const response = await withGatewayRetry(inner, [0, 0])(
        "https://mcp.example.test/mcp",
        post(method),
      );
      expect(response.status).toBe(200);
      expect(inner).toHaveBeenCalledTimes(3);
    }
  });

  it("never repeats a tool call", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(gatewayPage());
    const response = await withGatewayRetry(inner, [0, 0])(
      "https://mcp.example.test/mcp",
      post("tools/call"),
    );
    expect(response.status).toBe(503);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts and passes other errors through", async () => {
    const down = vi.fn<typeof fetch>().mockImplementation(async () => gatewayPage());
    expect(
      (await withGatewayRetry(down, [0, 0])("https://mcp.example.test/mcp", post("initialize")))
        .status,
    ).toBe(503);
    expect(down).toHaveBeenCalledTimes(3);

    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    await withGatewayRetry(unauthorized, [0, 0])(
      "https://mcp.example.test/mcp",
      post("initialize"),
    );
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});
