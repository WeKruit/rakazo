import { describe, expect, it } from "vitest";
import {
  buildMcpCredentialBlob,
  deriveMcpSlug,
  isMcpConfigPath,
  mcpConfigFileServers,
  needsOAuthProbe,
  parseMcpServerToolArgs,
} from "./mcp-server-tool.js";

describe("deriveMcpSlug", () => {
  it("slugifies server names like the settings overlay does", () => {
    expect(deriveMcpSlug("Brex MCP Server!")).toBe("brex-mcp-server");
    expect(deriveMcpSlug("  --  ")).toMatch(/^mcp-\d+$/);
    expect(deriveMcpSlug("x".repeat(100))).toHaveLength(64);
  });
});

describe("parseMcpServerToolArgs", () => {
  it("parses a minimal remote server", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
    });
    expect(parsed).toMatchObject({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
      assignToSelf: true,
    });
    expect(parsed?.slug).toBe("brex");
  });

  it("rejects missing names, bad transports, and non-http endpoints", () => {
    expect(
      parseMcpServerToolArgs({ transport: "streamable_http", endpoint: "https://x.test" }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "carrier-pigeon" })).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "streamable_http" })).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "streamable_http", endpoint: "ftp://x.test" }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "http://10.0.0.8/mcp",
      }),
    ).toMatchObject({ endpoint: "http://10.0.0.8/mcp" });
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "https://user:password@x.test/mcp#fragment",
      }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "stdio" })).toBeUndefined();
  });

  it("normalizes stdio commands and string args", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Local",
      transport: "stdio",
      command: " /opt/mcp ",
      args: "--verbose --port 9",
    });
    expect(parsed).toMatchObject({
      transport: "stdio",
      command: "/opt/mcp",
      args: ["--verbose", "--port", "9"],
    });
  });

  it("keeps only string-valued env/headers entries and caps their size", () => {
    const parsed = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: { Authorization: "Bearer t", Broken: 42 as unknown as string },
      env: { A: "b", BAD: null as unknown as string },
    });
    expect(parsed?.headers).toEqual({ Authorization: "Bearer t" });
    expect(parsed?.env).toEqual({ A: "b" });

    const tooMany = parseMcpServerToolArgs({
      name: "H",
      transport: "stdio",
      command: "c",
      env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])),
    });
    expect(tooMany).toBeUndefined();
  });
});

describe("buildMcpCredentialBlob", () => {
  it("returns null when no credential material exists", () => {
    expect(buildMcpCredentialBlob({})).toBeNull();
    expect(buildMcpCredentialBlob({ headers: {}, env: {} })).toBeNull();
  });

  it("serializes secret, env, and headers into the encrypted blob shape", () => {
    expect(
      buildMcpCredentialBlob({ secret: "tok", headers: { Authorization: "Bearer tok" }, env: {} }),
    ).toEqual(JSON.stringify({ secret: "tok", env: {}, headers: { Authorization: "Bearer tok" } }));
  });
});

describe("needsOAuthProbe", () => {
  it("is true only for remote servers without static credentials", () => {
    expect(needsOAuthProbe({ transport: "streamable_http" })).toBe(true);
    expect(needsOAuthProbe({ transport: "sse" })).toBe(true);
    expect(needsOAuthProbe({ transport: "streamable_http", secret: "tok" })).toBe(false);
    expect(needsOAuthProbe({ transport: "streamable_http", headers: { Authorization: "x" } })).toBe(
      false,
    );
    expect(needsOAuthProbe({ transport: "stdio", command: "c" } as never)).toBe(false);
  });
});

describe("mcpConfigFileServers", () => {
  it("maps a .mcp.json file to add_mcp_server arguments", () => {
    expect(isMcpConfigPath(".mcp.json")).toBe(true);
    expect(isMcpConfigPath("project/mcp.json")).toBe(true);
    expect(isMcpConfigPath("notes.json")).toBe(false);
    const servers = mcpConfigFileServers(
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-files"], env: { ROOT: "/tmp" } },
          docs: { type: "http", url: "https://mcp.example.com/mcp" },
          feed: { type: "sse", url: "https://mcp.example.com/sse" },
        },
      }),
    );
    expect(servers).toEqual([
      {
        name: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server-files"],
        env: { ROOT: "/tmp" },
      },
      {
        name: "docs",
        transport: "streamable_http",
        endpoint: "https://mcp.example.com/mcp",
        headers: undefined,
      },
      {
        name: "feed",
        transport: "sse",
        endpoint: "https://mcp.example.com/sse",
        headers: undefined,
      },
    ]);
    expect(Array.isArray(servers) && parseMcpServerToolArgs(servers[0]!)?.command).toBe("npx");
  });

  it("explains a file that is not an MCP config", () => {
    expect(mcpConfigFileServers("{")).toEqual({ error: "MCP config is not valid JSON." });
    expect(mcpConfigFileServers("{}")).toEqual({
      error: 'MCP config needs an "mcpServers" object.',
    });
  });
});
