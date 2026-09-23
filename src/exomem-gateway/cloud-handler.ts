/**
 * Exomem Cloud gateway handler (design D3, `adopt-exomem-cloud-plain-cells`).
 *
 * An authenticated pass-through: unlike `handleHostedMcpRequest` (mcp.ts),
 * which runs the MCP server in-process, this resolves the caller's cell and
 * streams the request straight to it. Additive and gated — nothing here is
 * imported by the hosted MCP path, and this module is only reachable when
 * `EXOMEM_CLOUD_MCP_PATH` is configured (server.ts).
 */

import { randomUUID } from "node:crypto";
import { deriveCloudCellBearer } from "../lib/exomem-hosted/cloud-cell-bearer";
import { loadExomemCloudConfig, type ExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";
import {
  findCloudOAuthAccessToken,
  type ActiveCloudOAuthAccessToken,
} from "../lib/exomem-hosted/cloud-oauth";
import { hasForbiddenGatewayHeaders } from "../lib/exomem-hosted/gateway";
import { ADVERTISED_SCOPES, parseBearerAuthorization } from "../lib/exomem-hosted/oauth";
import { exomemPublicBaseUrlFromEnv } from "../lib/exomem-hosted/public-origin";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "../lib/exomem-hosted/rate-limit";
import { digestSecret } from "../lib/exomem-hosted/security";

const CACHE_HEADERS = { "cache-control": "private, no-store" };
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
// Security review finding 12: only these three response headers are ever
// relayed back to the caller -- everything else the cell sends (including
// its own cache-control, or anything else it chose to add) is dropped. The
// gateway's own cache-control (CACHE_HEADERS) always wins.
const RELAYED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];
// Security review finding 15: the same cell_id shape migration 0056 enforces
// with its CHECK constraint (`^[a-z2-7]{16}$`) -- validated again here before
// the value is used in a URL or an HMAC, so a data anomaly this join should
// never allow can't be turned into a request against an attacker-shaped
// hostname or a bearer derived from attacker-shaped input.
const CELL_ID_FORMAT = /^[a-z2-7]{16}$/;
const CELL_PORT = 8765;
const MAX_CLOUD_CONCURRENCY = 16;
const MAX_CLOUD_TENANT_CONCURRENCY = 4;
// D2's required scope pair: a cell exposes one fixed non-owner principal and
// cannot itself enforce a read-only grant, so every Cloud-resource token the
// gateway accepts must carry both.
const REQUIRED_CLOUD_SCOPES = ["exomem.read", "exomem.write"] as const;

let activeCloudCalls = 0;
const activeCloudCallsByIdentity = new Map<string, number>();
let ipBucketSkips = 0;

/** Test-only: clears the module-level counters between tests. */
export function resetCloudGatewayConcurrencyForTests(): void {
  activeCloudCalls = 0;
  activeCloudCallsByIdentity.clear();
  ipBucketSkips = 0;
}

/** Requests this process served without an IP bucket (D3 step 3). */
export function cloudGatewayIpBucketSkips(): number {
  return ipBucketSkips;
}

/**
 * Counts an IP-bucket skip and logs it, content-free, so an ingress that
 * blanks `x-real-ip` is visible. Logged on the 1st, 2nd, 4th, 8th... skip,
 * which keeps a sustained misconfiguration loud without one line per request.
 */
function recordIpBucketSkip(): void {
  ipBucketSkips += 1;
  if ((ipBucketSkips & (ipBucketSkips - 1)) === 0) {
    console.warn({ event: "exomem_cloud_gateway_ip_bucket_skipped", count: ipBucketSkips });
  }
}

/**
 * Security review finding 5: acquiring and releasing used to wrap only the
 * promise `proxyToCell` returns -- which resolves as soon as the upstream
 * response's headers arrive, while its body (the actual relayed stream) is
 * still open. That released the slot while a large or slow response was
 * still in flight, undercounting real concurrency. Acquire/release are now
 * split: the caller releases only once the relayed body actually ends,
 * errors or is cancelled (see `releaseConcurrencyWhenBodyEnds` below).
 */
function acquireCloudConcurrency(key: string): (() => void) | null {
  if (activeCloudCalls >= MAX_CLOUD_CONCURRENCY) return null;
  const activeForIdentity = activeCloudCallsByIdentity.get(key) ?? 0;
  if (activeForIdentity >= MAX_CLOUD_TENANT_CONCURRENCY) return null;
  activeCloudCalls += 1;
  activeCloudCallsByIdentity.set(key, activeForIdentity + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCloudCalls -= 1;
    const remaining = (activeCloudCallsByIdentity.get(key) ?? 1) - 1;
    if (remaining <= 0) activeCloudCallsByIdentity.delete(key);
    else activeCloudCallsByIdentity.set(key, remaining);
  };
}

/**
 * Wraps `response`'s body so `release` fires exactly once the relayed
 * stream actually finishes: normal completion, an upstream read error, or
 * the caller cancelling its own read of the response. A response with no
 * body (nothing to stream) releases immediately. The wrapping is a plain
 * pull-through -- it enqueues each chunk as soon as it arrives, so streaming
 * behaviour (task 3.6's "streams the response body rather than buffering
 * it") is unchanged.
 */
function releaseConcurrencyWhenBodyEnds(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseOnce();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        releaseOnce();
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: CACHE_HEADERS });
}

/**
 * D3 step 3: "keyed on X-Real-Ip. Our own Traefik overwrites that header,
 * and a NetworkPolicy admits only Traefik to the gateway... If the request
 * carries no client address, the IP bucket is skipped. It is never
 * collapsed into one shared bucket, because a single sender could then
 * rate-limit every user."
 *
 * Security review finding 6: this used to fall back to the literal string
 * `"aggregate"` whenever the trusted-ingress check failed or no address was
 * present -- every such request then shared one bucket, so one sender could
 * exhaust it for everyone. Returning `null` here means "skip the IP bucket
 * entirely"; the caller never rate-limits on a shared key. `x-real-ip`, not
 * `clientAddressKey`'s `x-forwarded-for`: the design names the header
 * Traefik itself overwrites.
 */
function trustedIngressClientAddress(request: Request): string | null {
  const header = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
  const value = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
  if (!header || !value || request.headers.get(header) !== value) return null;
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp || null;
}

export function buildCloudProtectedResourceMetadata(
  config: Pick<ExomemCloudConfig, "mcpUrl">
): Record<string, unknown> {
  const issuer = `${exomemPublicBaseUrlFromEnv()}/api/exomem/oauth`;
  return {
    resource: config.mcpUrl,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    // Security review finding 2: the Cloud resource document must advertise
    // its scopes too, exactly like the hosted one already does — a client
    // that discovers the resource before the authorization server otherwise
    // never learns it needs both exomem.read and exomem.write.
    scopes_supported: [...ADVERTISED_SCOPES],
  };
}

export type CloudGatewayDependencies = {
  config?: ExomemCloudConfig;
  findAccessToken?: typeof findCloudOAuthAccessToken;
  takeRateLimit?: typeof takeExomemRateLimit;
  fetchCell?: typeof fetch;
};

/**
 * D3's pass-through. Every branch below is numbered to the design's own
 * ordered list.
 */
export async function handleCloudMcpRequest(
  request: Request,
  dependencies: CloudGatewayDependencies = {}
): Promise<Response> {
  const config = dependencies.config ?? loadExomemCloudConfig();
  const findAccessToken = dependencies.findAccessToken ?? findCloudOAuthAccessToken;
  const takeRateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;

  // 1. GET is refused before anything else is even parsed.
  if (request.method === "GET") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "POST" } });
  }

  // 2. Forbidden selector headers — the caller may not name a tenant or
  // cell; routing comes only from the authenticated principal (D3 scenario
  // "Caller attempts to select another cell").
  if (hasForbiddenGatewayHeaders(request.headers)) {
    return errorResponse(400, "HOSTED_SELECTOR_REJECTED");
  }

  // 3. IP rate limit, keyed on the ingress-recorded client address. Skipped
  // entirely when there is none to key on (security review finding 6) —
  // never collapsed into one shared bucket.
  const ipKey = trustedIngressClientAddress(request);
  if (ipKey === null) {
    recordIpBucketSkip();
  } else if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIp, ipKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }

  // 4. Bearer parse, token lookup (exact Cloud-resource match), required
  // scopes (D2), identity rate limit and concurrency guard.
  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  if (!bearer) return errorResponse(401, "ACCESS_TOKEN_INVALID");
  const access = await findAccessToken(digestSecret(bearer), config.mcpUrl);
  if (!access) return errorResponse(401, "ACCESS_TOKEN_INVALID");

  // Security review finding 2: a cell exposes one fixed non-owner principal
  // and cannot itself enforce a read-only grant, so a token missing either
  // exomem.read or exomem.write is refused here, before any cell contact.
  if (!REQUIRED_CLOUD_SCOPES.every((scope) => access.scopes.includes(scope))) {
    return errorResponse(403, "INSUFFICIENT_SCOPE");
  }

  const identityKey = `${access.tenantId}:${access.clientId}`;
  if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIdentity, identityKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }

  const release = acquireCloudConcurrency(identityKey);
  if (!release) return errorResponse(429, "RATE_LIMITED");
  let response: Response;
  try {
    response = await proxyToCell(request, access, config, dependencies.fetchCell ?? fetch);
  } catch (error) {
    release();
    throw error;
  }
  return releaseConcurrencyWhenBodyEnds(response, release);
}

async function proxyToCell(
  request: Request,
  access: ActiveCloudOAuthAccessToken,
  config: ExomemCloudConfig,
  fetchCell: typeof fetch
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "POST" } });
  }

  // 5. Gate on desired state, not the eventually consistent `ready` column.
  if (access.cellDesiredState !== "running" && access.cellDesiredState !== "read_only") {
    return errorResponse(503, "CELL_NOT_READY");
  }

  // Security review finding 15: validated again here, immediately before the
  // cell_id is used to build a URL and to derive the HMAC-based cell bearer
  // below. Migration 0056's CHECK constraint already guarantees this shape
  // for every row that can reach this join, so this never fires against real
  // data — it exists so a bug elsewhere can never turn into a request
  // against an attacker-shaped hostname or an HMAC over attacker-shaped
  // input.
  if (!CELL_ID_FORMAT.test(access.cellId)) {
    console.error({ event: "exomem_cloud_gateway_cell_id_invalid" });
    return errorResponse(500, "CELL_ID_INVALID");
  }

  // 6. Derive the per-cell bearer (C4).
  const cellBearer = deriveCloudCellBearer(config.cellTokenKey, access.cellId);

  // 7. Stream to the cell per C3: only the four listed headers forwarded,
  // plus x-request-id; never the client's Authorization, cookies or
  // forwarding headers. Security review finding 12: accept-encoding is
  // always sent as identity upstream, regardless of what the caller sent —
  // the gateway relays the cell's body byte-for-byte and never decodes a
  // compressed one.
  const forwardHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) forwardHeaders.set(name, value);
  }
  forwardHeaders.set("accept-encoding", "identity");
  forwardHeaders.set("authorization", `Bearer ${cellBearer}`);
  forwardHeaders.set("x-request-id", randomUUID());

  const upstreamUrl = `http://cell.exo-cell-${access.cellId}.svc.cluster.local:${CELL_PORT}/mcp`;
  let upstream: Response;
  try {
    upstream = await fetchCell(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.method === "DELETE" ? undefined : request.body,
      duplex: "half",
      signal: request.signal,
    } as RequestInit);
  } catch {
    return errorResponse(503, "CELL_NOT_READY");
  }

  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    return errorResponse(502, "CELL_AUTH_MISMATCH");
  }

  // Security review finding 12: only the allowlisted response headers are
  // relayed; everything else the cell sent (including its own cache-control)
  // is dropped in favour of the gateway's own.
  const relayedHeaders = new Headers(CACHE_HEADERS);
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) relayedHeaders.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: relayedHeaders,
  });
}
