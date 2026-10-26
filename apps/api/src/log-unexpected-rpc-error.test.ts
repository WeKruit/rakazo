import { ORPCError, ValidationError } from "@orpc/server";
import { IsolationError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { logUnexpectedRpcError, notFoundForIsolation } from "./app.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("stays quiet for an error the router chose to return", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(sink.events).toEqual([]);
  });

  it("names the field paths when a result fails its output schema, without the values", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Output validation failed",
      cause: new ValidationError({
        message: "Output validation failed",
        issues: [{ path: ["messages", 3, { key: "blocks" }, 0, "kind"], message: "Invalid input" }],
        data: { messages: ["private recruiting text"] },
      }),
    });

    logUnexpectedRpcError(error, ["threads", "get"]);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "rpc threads/get failed",
      reason: "Output validation failed",
      issues: ["messages.3.blocks.0.kind: Invalid input"],
    });
    expect(JSON.stringify(sink.events[0])).not.toContain("private recruiting text");
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/screenUrl failed",
      error: {
        message: "fetch failed",
        cause: { message: "connect ECONNREFUSED 127.0.0.1:7091" },
      },
    });
  });
});

describe("notFoundForIsolation", () => {
  it("answers a missing record as not found and passes other errors through", () => {
    const mapped = notFoundForIsolation(new IsolationError());
    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const other = new Error("boom");
    expect(notFoundForIsolation(other)).toBe(other);
  });
});
