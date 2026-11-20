import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";

/**
 * Programmatic tool calling, the pattern of Anthropic's code-execution tool calling and
 * Cloudflare's Code Mode: code the agent runs on its computer calls the agent's own tools, so it
 * can page through every role, count, join and save with a loop instead of reading by eye.
 *
 * The computer holds no credential. A call travels as a request file plus a marker line on the
 * command's output; the run that started the command executes the tool through its own tool path
 * (account scope, receipts, tool budget) and writes the answer back as a file. Calls that need
 * the person (a card, a question, a hand-off) are refused, so the agent makes those itself.
 */

/** Where the helper lives on the computer, relative to the bot's folder. */
export const CODE_TOOLS_DIRECTORY = ".rakazo/lib";
export const CODE_TOOLS_MODULE_PATH = `${CODE_TOOLS_DIRECTORY}/rakazo_tools.py`;
const CALLS_DIRECTORY = `${CODE_TOOLS_DIRECTORY}/calls`;

/** Record-separator framing keeps a call marker apart from anything the script prints. */
const SEPARATOR = String.fromCharCode(0x1e);
const MARKER = new RegExp(`${SEPARATOR}rakazo-tool:([0-9a-f]{32})${SEPARATOR}\\n?`, "g");

/** Tools that pause for the person, talk to them or start other agents: the agent calls these. */
const NOT_FROM_CODE = new Set([
  "shell",
  "ask_user",
  "request_takeover",
  "request_secret",
  "create_poll",
  "vote_poll",
  ...DELEGATION_TOOL_NAMES,
]);

export const CODE_CALL_NEEDS_PERSON =
  "This call needs the person's approval or answer, which code cannot give. Make this tool call yourself, outside the script.";

export function codeToolRefusal(name: string, known: boolean): string | undefined {
  if (!known) return `There is no tool named ${name} in this conversation.`;
  if (NOT_FROM_CODE.has(name))
    return `${name} cannot be called from code. Make this tool call yourself, outside the script.`;
  return undefined;
}

export function codeToolRequestPath(id: string): string {
  return `${CALLS_DIRECTORY}/${id}.req.json`;
}

export function codeToolResponsePath(id: string): string {
  return `${CALLS_DIRECTORY}/${id}.out.json`;
}

/** Call ids the output names that were not seen before, in order. */
export function newCodeToolCalls(output: string, seen: Set<string>): string[] {
  const found: string[] = [];
  for (const match of output.matchAll(MARKER)) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

/** The command's output without the call markers, as the model and the activity feed see it. */
export function withoutCodeToolMarkers(output: string): string {
  return output.replace(MARKER, "");
}

/** A relative PYTHONPATH entry from the command's folder to the helper's folder. */
export function codeToolsPythonPath(commandCwd: string | undefined, helperDir: string): string {
  const from = (commandCwd ?? ".").split("/").filter((part) => part && part !== ".");
  const to = helperDir.split("/").filter((part) => part && part !== ".");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/") || ".";
}

export const CODE_TOOLS_MODULE = `"""Call this assistant's own tools from Python code.

    from rakazo_tools import call
    roles = call("recruiting_candidates", operation="roles")

call() returns the tool's complete result (a dict) and raises ToolError when the tool refuses.
Calls that need the person's approval or answer raise ToolError; make those calls yourself.
"""
import json
import os
import sys
import time
import uuid

_CALLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calls")


class ToolError(Exception):
    pass


def call(name, **args):
    os.makedirs(_CALLS, exist_ok=True)
    call_id = uuid.uuid4().hex
    request = os.path.join(_CALLS, call_id + ".req.json")
    answer = os.path.join(_CALLS, call_id + ".out.json")
    with open(request + ".tmp", "w") as handle:
        json.dump({"name": name, "args": args}, handle)
    os.replace(request + ".tmp", request)
    sys.stdout.write("\\x1erakazo-tool:" + call_id + "\\x1e\\n")
    sys.stdout.flush()
    deadline = time.time() + 600
    while not os.path.exists(answer):
        if time.time() > deadline:
            raise ToolError(name + " did not answer within 10 minutes")
        time.sleep(0.1)
    with open(answer) as handle:
        reply = json.load(handle)
    for path in (request, answer):
        try:
            os.remove(path)
        except OSError:
            pass
    if "refused" in reply:
        raise ToolError(reply["refused"])
    result = reply.get("result")
    if isinstance(result, dict) and isinstance(result.get("error"), str) and len(result) == 1:
        raise ToolError(result["error"])
    return result


if __name__ == "__main__":
    print(json.dumps(call(sys.argv[1], **(json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})), indent=1))
`;

/** Answers each new call the command's output names; the run supplies its file and tool access. */
export function serveCodeToolCalls(io: {
  readRequest(path: string): Promise<string>;
  writeAnswer(path: string, text: string): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** False once the shell tool returned to the model: later calls are refused. */
  live(): boolean;
}): { onOutput(output: string): void; settled(): Promise<void> } {
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  const answer = async (id: string) => {
    let reply: { result: unknown } | { refused: string };
    try {
      if (!io.live()) {
        reply = {
          refused:
            "The shell command outlived its turn, so its tool calls are no longer served. Run it again and wait for it.",
        };
      } else {
        const raw = JSON.parse(await io.readRequest(codeToolRequestPath(id))) as {
          name?: unknown;
          args?: unknown;
        };
        const args =
          raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
            ? (raw.args as Record<string, unknown>)
            : {};
        reply =
          typeof raw.name === "string"
            ? { result: await io.callTool(raw.name, args) }
            : { refused: "A call needs a tool name." };
      }
    } catch (error) {
      reply = { refused: error instanceof Error ? error.message : String(error) };
    }
    let text: string;
    try {
      text = JSON.stringify(reply);
    } catch {
      text = JSON.stringify({ refused: "The tool's result could not be written as JSON." });
    }
    await io.writeAnswer(codeToolResponsePath(id), text);
  };
  return {
    onOutput(output) {
      for (const id of newCodeToolCalls(output, seen))
        pending.push(answer(id).catch(() => undefined));
    },
    async settled() {
      await Promise.all(pending);
    },
  };
}

/** The part of a Pi tool a call from code needs. */
type CallableTool = {
  name: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: never,
  ) => Promise<{ content: unknown[]; details?: unknown; terminate?: boolean }>;
};

/**
 * Runs one call from code through the same Pi tool the model would call (its events, budget and
 * executor), marking its id so the executor refuses anything that would wait for the person.
 */
export async function callToolFromCode(
  tools: ReadonlyMap<string, CallableTool>,
  codeCallIds: Set<string>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.get(name);
  const refusal = codeToolRefusal(name, Boolean(tool));
  if (refusal) return { error: refusal };
  const id = `code-${randomUUID()}`;
  codeCallIds.add(id);
  try {
    const prepared = tool!.prepareArguments ? tool!.prepareArguments(args) : args;
    // The same schema check the model's own calls pass; a mistyped argument names itself.
    let params: unknown;
    try {
      params = validateToolArguments(tool as never, {
        type: "toolCall",
        id,
        name,
        arguments: prepared as never,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const result = await tool!.execute(id, params as never);
    if (result.details !== undefined) return result.details;
    return result.content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("\n");
  } finally {
    codeCallIds.delete(id);
  }
}

/**
 * Sets up one shell command for calls from its code: the helper module on the computer, the
 * PYTHONPATH that finds it from the command's folder, and the server for its calls.
 */
export async function prepareCodeToolCalls(io: {
  install(path: string, content: Uint8Array): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** The helper's folder and the command's folder, both as the computer resolves them. */
  helperDir: string;
  cwd: string | undefined;
}): Promise<{
  env: Record<string, string>;
  onOutput(output: string): void;
  used(): boolean;
  settled(): Promise<void>;
}> {
  await io.install(CODE_TOOLS_MODULE_PATH, new TextEncoder().encode(CODE_TOOLS_MODULE));
  let used = false;
  let finished = false;
  const server = serveCodeToolCalls({
    readRequest: io.read,
    writeAnswer: io.write,
    callTool: io.callTool,
    live: () => !finished,
  });
  const env = io.cwd?.startsWith("/")
    ? ({} as Record<string, string>)
    : { PYTHONPATH: codeToolsPythonPath(io.cwd, io.helperDir) };
  return {
    env,
    onOutput(output) {
      if (output.includes(`${SEPARATOR}rakazo-tool:`)) used = true;
      server.onOutput(output);
    },
    used: () => used,
    async settled() {
      await server.settled();
      finished = true;
    },
  };
}
