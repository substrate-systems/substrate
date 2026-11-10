/**
 * How the gateway reaches a cell (design D5, `automate-cloud-releases`): the
 * connect, header and idle timeouts on every call, and the hold that waits
 * while a cell restarts. Every threshold is configuration; the platform chart
 * renders each variable below, and the gateway refuses to start without one.
 */

import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "undici";
import { ExomemCloudConfigurationError } from "../lib/exomem-hosted/cloud-config";

export const CLOUD_UPSTREAM_ENV = [
  "EXOMEM_CLOUD_HOLD_BUDGET_SECONDS",
  "EXOMEM_CLOUD_HOLD_INTERVAL_MS",
  "EXOMEM_CLOUD_HOLD_JITTER_MS",
  "EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS",
  "EXOMEM_CLOUD_HOLD_MAX",
  "EXOMEM_CLOUD_HOLD_MAX_PER_TENANT",
  "EXOMEM_CLOUD_CONNECT_TIMEOUT_MS",
  "EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS",
  "EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS",
] as const;

type UpstreamVariable = (typeof CLOUD_UPSTREAM_ENV)[number];

export type CloudUpstream = Readonly<{
  /** 0 turns the hold off. */
  holdBudgetMs: number;
  holdIntervalMs: number;
  holdJitterMs: number;
  retryAfterSeconds: number;
  holdMax: number;
  holdMaxPerTenant: number;
  connectTimeoutMs: number;
  /** The undici dispatcher that applies the connect, header and idle timeouts. */
  dispatcher: Agent;
}>;

const HOUR_SECONDS = 3600;
const HOUR_MS = HOUR_SECONDS * 1000;

/** The bounds catch a unit mistake (milliseconds in a seconds variable); they set no policy. */
const BOUNDS: Record<UpstreamVariable, [min: number, max: number]> = {
  EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: [0, HOUR_SECONDS],
  EXOMEM_CLOUD_HOLD_INTERVAL_MS: [1, HOUR_MS],
  EXOMEM_CLOUD_HOLD_JITTER_MS: [0, HOUR_MS],
  EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS: [1, HOUR_SECONDS],
  EXOMEM_CLOUD_HOLD_MAX: [1, 100_000],
  EXOMEM_CLOUD_HOLD_MAX_PER_TENANT: [1, 100_000],
  EXOMEM_CLOUD_CONNECT_TIMEOUT_MS: [1, HOUR_MS],
  EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS: [1, HOUR_SECONDS],
  EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS: [1, HOUR_SECONDS],
};

export function loadCloudUpstream(
  env: Record<string, string | undefined> = process.env
): CloudUpstream {
  const invalid: string[] = [];
  const read = (name: UpstreamVariable): number => {
    const raw = env[name]?.trim() ?? "";
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const [min, max] = BOUNDS[name];
    if (!(value >= min && value <= max)) invalid.push(name);
    return value;
  };
  const values = Object.fromEntries(CLOUD_UPSTREAM_ENV.map((name) => [name, read(name)])) as Record<
    UpstreamVariable,
    number
  >;
  if (values.EXOMEM_CLOUD_HOLD_MAX_PER_TENANT > values.EXOMEM_CLOUD_HOLD_MAX) {
    invalid.push("EXOMEM_CLOUD_HOLD_MAX_PER_TENANT");
  }
  if (invalid.length) throw new ExomemCloudConfigurationError(invalid);
  const connectTimeoutMs = values.EXOMEM_CLOUD_CONNECT_TIMEOUT_MS;
  return {
    holdBudgetMs: values.EXOMEM_CLOUD_HOLD_BUDGET_SECONDS * 1000,
    holdIntervalMs: values.EXOMEM_CLOUD_HOLD_INTERVAL_MS,
    holdJitterMs: values.EXOMEM_CLOUD_HOLD_JITTER_MS,
    retryAfterSeconds: values.EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS,
    holdMax: values.EXOMEM_CLOUD_HOLD_MAX,
    holdMaxPerTenant: values.EXOMEM_CLOUD_HOLD_MAX_PER_TENANT,
    connectTimeoutMs,
    // undici restarts the header timer on each request-body write, so a slow
    // upload is bounded by its own progress. bodyTimeout is the gap between
    // response chunks, which bounds a stalled SSE stream after its headers.
    dispatcher: new Agent({
      connect: { timeout: connectTimeoutMs },
      headersTimeout: values.EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS * 1000,
      bodyTimeout: values.EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS * 1000,
    }),
  };
}

let processUpstream: CloudUpstream | undefined;

/** The gateway process's settings, read once; index.ts reads them at start, so a gap stops it there. */
export function gatewayCloudUpstream(): CloudUpstream {
  processUpstream ??= loadCloudUpstream();
  return processUpstream;
}

function failureCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  // Node's address-family fallback reports every attempt; the first carries the code.
  if (cause instanceof AggregateError) {
    const first = (cause.errors[0] as { code?: unknown } | undefined)?.code;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

// D5: Node's and undici's documented codes for a connection that never
// opened, so no request byte reached the cell. A closed set fixed by those
// runtimes. ECONNRESET is not here: fetch reports it alike before and after
// the request was written, and a written tool call must never run twice.
const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isCellConnectFailure(error: unknown): boolean {
  const code = failureCode(error);
  return code !== undefined && CONNECT_FAILURE_CODES.has(code);
}

/** The cell accepted the request and sent no response headers in time. */
export function isCellHeadersTimeout(error: unknown): boolean {
  return failureCode(error) === "UND_ERR_HEADERS_TIMEOUT";
}

let heldTotal = 0;
const heldByTenant = new Map<string, number>();

/** Test-only: clears the hold counters between tests. */
export function resetCloudHoldForTests(): void {
  heldTotal = 0;
  heldByTenant.clear();
}

function takeHoldSlot(tenantId: string, upstream: CloudUpstream): (() => void) | null {
  const forTenant = heldByTenant.get(tenantId) ?? 0;
  if (heldTotal >= upstream.holdMax || forTenant >= upstream.holdMaxPerTenant) return null;
  heldTotal += 1;
  heldByTenant.set(tenantId, forTenant + 1);
  return () => {
    heldTotal -= 1;
    const remaining = (heldByTenant.get(tenantId) ?? 1) - 1;
    if (remaining <= 0) heldByTenant.delete(tenantId);
    else heldByTenant.set(tenantId, remaining);
  };
}

/** Whether the cell accepts a TCP connection now. It sends no byte, so the probe has no effect in the cell. */
function cellAccepts(origin: URL, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: origin.hostname, port: Number(origin.port) });
    const finish = (accepted: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(accepted);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The in-flight slot a held request gives back while it waits, and takes again when the cell accepts. */
export type HeldInflightSlot = { leave(): void; retake(): boolean };

export type HoldOutcome =
  /** The cell accepts connections, and the request holds an in-flight slot again. */
  | "accepted"
  /** The budget ran out. */
  | "expired"
  /** The hold caps are full. */
  | "full"
  /** The cell accepts, and no in-flight slot is free. */
  | "busy"
  /** The client disconnected. */
  | "left";

/**
 * D5's hold. A held request counts against the hold caps, not the in-flight
 * caps, until the same cell accepts a connection. It retries only toward that
 * one cell, so a routing failure never crosses tenants.
 */
export async function holdForCell(input: {
  origin: URL;
  tenantId: string;
  upstream: CloudUpstream;
  deadline: number;
  signal: AbortSignal;
  inflight: HeldInflightSlot;
}): Promise<HoldOutcome> {
  const { origin, upstream, deadline, signal } = input;
  const releaseHold = takeHoldSlot(input.tenantId, upstream);
  if (!releaseHold) return "full";
  input.inflight.leave();
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "expired";
      const wait =
        upstream.holdIntervalMs + Math.floor(Math.random() * (upstream.holdJitterMs + 1));
      try {
        await sleep(Math.min(wait, remaining), undefined, { signal });
      } catch {
        return "left";
      }
      if (await cellAccepts(origin, upstream.connectTimeoutMs, signal)) {
        return input.inflight.retake() ? "accepted" : "busy";
      }
      if (signal.aborted) return "left";
    }
  } finally {
    releaseHold();
  }
}
