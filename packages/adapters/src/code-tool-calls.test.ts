import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_TOOLS_DIRECTORY,
  callToolFromCode,
  codeToolsPythonPath,
  prepareCodeToolCalls,
  withoutCodeToolMarkers,
} from "./code-tool-calls.js";

/** Runs python3 in `home` and feeds its output to the bridge as the shell handler does. */
async function runWithBridge(
  home: string,
  script: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const bridge = await prepareCodeToolCalls({
    install: async (file, content) => {
      await mkdir(path.dirname(path.join(home, file)), { recursive: true });
      await writeFile(path.join(home, file), content);
    },
    read: (file) => readFile(path.join(home, file), "utf8"),
    write: (file, text) => writeFile(path.join(home, file), text),
    callTool,
    helperDir: CODE_TOOLS_DIRECTORY,
    cwd: undefined,
  });
  const child = spawn("python3", ["-c", script], {
    cwd: home,
    env: { ...process.env, ...bridge.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    bridge.onOutput(stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  await bridge.settled();
  return { code, stdout: withoutCodeToolMarkers(stdout), stderr, used: bridge.used() };
}

const OPEN = { type: "object", properties: {} };

describe("calls to the run's tools from code on the computer", () => {
  it("answers each call with the tool's full result and keeps markers out of the output", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "code-tools-"));
    try {
      const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
        roles: Array.from({ length: Number(args.limit) }, (_, i) => ({ id: `r${i}` })),
      }));
      const result = await runWithBridge(
        home,
        [
          "from rakazo_tools import call",
          "total = sum(len(call('recruiting_candidates', operation='roles', limit=n)['roles']) for n in (2, 3))",
          "print('roles', total)",
        ].join("\n"),
        callTool,
      );
      expect(result).toMatchObject({ code: 0, stdout: "roles 5\n", used: true });
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(callTool).toHaveBeenLastCalledWith("recruiting_candidates", {
        operation: "roles",
        limit: 3,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("raises in code when a tool refuses", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "code-tools-"));
    try {
      const result = await runWithBridge(
        home,
        [
          "from rakazo_tools import call, ToolError",
          "try:\n    call('send_email', to='a@example.com')\nexcept ToolError as e:\n    print('refused:', e)",
        ].join("\n"),
        async () => ({ error: "needs approval" }),
      );
      expect(result.stdout).toBe("refused: needs approval\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses tools that wait for the person or start other agents", async () => {
    const execute = vi.fn();
    const tool = (name: string) => ({ name, description: "", parameters: OPEN, execute });
    const tools = new Map(["ask_user", "delegate_to_role", "shell"].map((n) => [n, tool(n)]));
    for (const name of ["ask_user", "delegate_to_role", "shell", "missing"])
      expect(await callToolFromCode(tools, new Set(), name, {})).toMatchObject({
        error: expect.any(String),
      });
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks a call as from code only while it runs and returns the full details", async () => {
    const ids = new Set<string>();
    let seen = false;
    const tools = new Map([
      [
        "recruiting_candidates",
        {
          name: "recruiting_candidates",
          description: "",
          parameters: OPEN,
          execute: async (id: string) => {
            seen = ids.has(id);
            return { content: [{ type: "text", text: "clipped" }], details: { total: 40 } };
          },
        },
      ],
    ]);
    expect(await callToolFromCode(tools, ids, "recruiting_candidates", {})).toEqual({
      total: 40,
    });
    expect(seen).toBe(true);
    expect(ids.size).toBe(0);
  });

  it("checks arguments against the tool's schema before running it", async () => {
    const execute = vi.fn();
    const tools = new Map([
      [
        "recruiting_candidates",
        {
          name: "recruiting_candidates",
          description: "",
          parameters: {
            type: "object",
            properties: { operation: { type: "string" } },
            required: ["operation"],
          },
          execute,
        },
      ],
    ]);
    expect(await callToolFromCode(tools, new Set(), "recruiting_candidates", {})).toMatchObject({
      error: expect.stringContaining("operation"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("finds the helper from the command's folder", () => {
    expect(codeToolsPythonPath("bots/b1", "bots/b1/.rakazo/lib")).toBe(".rakazo/lib");
    expect(codeToolsPythonPath("bots/b1/data", "bots/b1/.rakazo/lib")).toBe("../.rakazo/lib");
    expect(codeToolsPythonPath(undefined, ".rakazo/lib")).toBe(".rakazo/lib");
  });
});
