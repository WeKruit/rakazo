import { randomUUID } from "node:crypto";
import { getLogContext, runWithLogContext } from "./context.js";
import { generateSpanId, generateTraceId } from "./ids.js";
import { getLogger } from "./logger.js";
import type { JobCorrelation, LogBindings } from "./types.js";
import { JOB_CORRELATION_VERSION } from "./types.js";

const CORRELATION_FIELD = "__rakazoLog";

interface JobCorrelationMeta {
  v: typeof JOB_CORRELATION_VERSION;
  correlation: JobCorrelation;
}

const PAYLOAD_IDS: Record<string, string> = {
  runId: "run.id",
  computerId: "computer.id",
  threadId: "thread.id",
  routineId: "routine.id",
  skillId: "skill.id",
  botId: "bot.id",
  spaceId: "space.id",
  userId: "user.id",
  jobId: "job.id",
};

export function createJobCorrelation(): JobCorrelation {
  const ctx = getLogContext();
  const traceId =
    typeof ctx["trace.id"] === "string" && ctx["trace.id"].length === 32
      ? ctx["trace.id"]
      : generateTraceId();
  const parentSpanId = typeof ctx["span.id"] === "string" ? ctx["span.id"] : undefined;
  return {
    jobId: randomUUID(),
    traceId,
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

export function wrapJobPayload(payload: unknown, correlation = createJobCorrelation()): unknown {
  const meta: JobCorrelationMeta = {
    v: JOB_CORRELATION_VERSION,
    correlation,
  };
  if (isSidecarPayload(payload)) {
    return { ...payload, [CORRELATION_FIELD]: meta };
  }
  return { ...meta, payload };
}

export function unwrapJobPayload(stored: unknown): {
  payload: unknown;
  correlation?: JobCorrelation;
} {
  if (isPlainObject(stored)) {
    const sidecar = asCorrelationMeta(stored[CORRELATION_FIELD]);
    if (sidecar) {
      const payload = { ...stored };
      delete payload[CORRELATION_FIELD];
      return { payload, correlation: sidecar.correlation };
    }
    const nested = asCorrelationMeta(stored);
    if (nested && "payload" in stored) {
      return { payload: stored.payload, correlation: nested.correlation };
    }
  }
  return { payload: stored };
}

export function jobPayloadBindings(payload: unknown): LogBindings {
  if (!isPlainObject(payload)) return {};
  const bindings: LogBindings = {};
  for (const [key, value] of Object.entries(payload)) {
    const field = PAYLOAD_IDS[key];
    if (field && typeof value === "string" && value.length > 0) bindings[field] = value;
  }
  return bindings;
}

interface JobStatements {
  count: number;
  ms: number;
  sites: Map<string, { count: number; ms: number }>;
}
const jobStatements = new Map<string, JobStatements>();
const JOB_STATEMENT_SITES_LOGGED = 8;

/** Adds one database statement to the running job's tally, which job.completed reports. */
export function recordJobStatement(site: string, ms: number): void {
  const jobId = getLogContext()["job.id"];
  const tally = typeof jobId === "string" ? jobStatements.get(jobId) : undefined;
  if (!tally) return;
  tally.count += 1;
  tally.ms += ms;
  const entry = tally.sites.get(site) ?? { count: 0, ms: 0 };
  entry.count += 1;
  entry.ms += ms;
  tally.sites.set(site, entry);
}

function takeJobStatements(jobId: string): LogBindings {
  const tally = jobStatements.get(jobId);
  jobStatements.delete(jobId);
  if (!tally?.count) return {};
  return {
    "db.statements": tally.count,
    "db.ms": Math.round(tally.ms),
    "db.sites": [...tally.sites]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, JOB_STATEMENT_SITES_LOGGED)
      .map(([site, entry]) => `${site} ×${entry.count} ${Math.round(entry.ms)}ms`)
      .join("; "),
  };
}

export async function runCorrelatedJob<T>(options: {
  name: string;
  payload: unknown;
  correlation?: JobCorrelation;
  run: () => Promise<T>;
}): Promise<T> {
  const logger = getLogger();
  const correlation = options.correlation ?? createJobCorrelation();
  const started = performance.now();
  const bindings: LogBindings = {
    "job.id": correlation.jobId,
    "job.type": options.name,
    "trace.id": correlation.traceId,
    "span.id": generateSpanId(),
    ...jobPayloadBindings(options.payload),
  };
  if (correlation.parentSpanId) bindings["parent.span.id"] = correlation.parentSpanId;
  jobStatements.set(correlation.jobId, { count: 0, ms: 0, sites: new Map() });
  return runWithLogContext(bindings, async () => {
    try {
      const result = await options.run();
      logger.info("job.completed", {
        "job.duration_ms": Math.round(performance.now() - started),
        "job.outcome": "ok",
        ...takeJobStatements(correlation.jobId),
      });
      return result;
    } catch (error) {
      logger.error("job.completed", error, {
        "job.duration_ms": Math.round(performance.now() - started),
        "job.outcome": "error",
        ...takeJobStatements(correlation.jobId),
      });
      throw error;
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSidecarPayload(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && !Object.hasOwn(value, CORRELATION_FIELD);
}

function asCorrelationMeta(value: unknown): JobCorrelationMeta | undefined {
  if (!isPlainObject(value) || value.v !== JOB_CORRELATION_VERSION) return undefined;
  const correlation = value.correlation;
  if (!isPlainObject(correlation)) return undefined;
  if (typeof correlation.jobId !== "string" || typeof correlation.traceId !== "string") {
    return undefined;
  }
  return {
    v: JOB_CORRELATION_VERSION,
    correlation: {
      jobId: correlation.jobId,
      traceId: correlation.traceId,
      ...(typeof correlation.parentSpanId === "string"
        ? { parentSpanId: correlation.parentSpanId }
        : {}),
    },
  };
}
