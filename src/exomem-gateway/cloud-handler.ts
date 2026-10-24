import { cloudBearerChallenge } from "../lib/exomem-hosted/cloud-oauth";
/**
 * Exomem Cloud gateway handler (design D3, `adopt-exomem-cloud-plain-cells`).
 *
 * An authenticated pass-through: it resolves the caller's cell and streams the
 * request straight to it. server.ts mounts it at `EXOMEM_CLOUD_MCP_PATH`.
 */

import { randomUUID } from "node:crypto";
import {
  CloudArtifactBodyError,
  cloudArtifactGrant,
  cloudArtifactTransportEnabled,
  readCloudArtifactBody,
} from "./cloud-artifacts";
import { answerCloudTransferCall, parseCloudTransferCall } from "./cloud-transfer-tools";
import { hasForbiddenGatewayHeaders } from "./forbidden-headers";
import { deriveCloudCellBearer } from "../lib/exomem-hosted/cloud-cell-bearer";
import { loadExomemCloudConfig, type ExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";
import {
  APP_USE_WINDOW_SECONDS,
  findCloudOAuthAccessToken,
  recordCloudAppUse,
  type ActiveCloudOAuthAccessToken,
} from "../lib/exomem-hosted/cloud-oauth";
import { ADVERTISED_SCOPES, parseBearerAuthorization } from "../lib/exomem-hosted/oauth";
import {
  oauthClientContext,
  oauthClientDisplayName,
  type OAuthClientIdentity,
} from "../lib/exomem-hosted/oauth-client-identity";
import { exomemPublicBaseUrlFromEnv } from "../lib/exomem-hosted/public-origin";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "../lib/exomem-hosted/rate-limit";
import { digestSecret } from "../lib/exomem-hosted/security";

const CACHE_HEADERS = { "cache-control": "private, no-store" };
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
];
const MCP_PARAMETER_HEADER_PREFIX = "mcp-param-";
// These headers identify the authenticated app to the cell. A cloud cell
// trusts them because its bearer proves the request came from here, so the
// gateway sets them itself: a caller's `x-exomem-*` header is refused by
// hasForbiddenGatewayHeaders, and neither name is on the forwarding allowlist
// or starts with MCP_PARAMETER_HEADER_PREFIX.
const CELL_CLIENT_NAME_HEADER = "x-exomem-oauth-client";
const CELL_CLIENT_CONTEXT_HEADER = "x-exomem-client-context";
const CELL_APP_ID_HEADER = "x-exomem-app-id";
// RFC 9110 section 5.5: a field value this gateway sends is visible ASCII and spaces.
const HEADER_SAFE_VALUE = /^[\x20-\x7e]+$/;
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
let appUseLosses = 0;
// When this process last asked to record each grant's use. The table's own
// WHERE holds replicas to one change per window; this map spares a busy app a
// database statement on every request.
const appUseAskedAt = new Map<string, number>();

/** Test-only: clears the module-level counters between tests. */
export function resetCloudGatewayConcurrencyForTests(): void {
  activeCloudCalls = 0;
  activeCloudCallsByIdentity.clear();
  ipBucketSkips = 0;
  appUseLosses = 0;
  appUseAskedAt.clear();
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
  if (loggedOccurrence(ipBucketSkips)) {
    console.warn({ event: "exomem_cloud_gateway_ip_bucket_skipped", count: ipBucketSkips });
  }
}

/**
 * Logs an app's use that the gateway could not record, with the database's
 * error code only, on the same schedule as an IP-bucket skip.
 */
function recordAppUseLoss(error: unknown): void {
  appUseLosses += 1;
  if (loggedOccurrence(appUseLosses)) {
    const code = (error as { code?: unknown } | null)?.code;
    console.warn({
      event: "exomem_cloud_gateway_app_use_unrecorded",
      count: appUseLosses,
      code: typeof code === "string" ? code : null,
    });
  }
}

/**
 * Notes that an app reached its Exomem, for Home's app row: at most once per
 * window from this process, never awaited, its failure only logged.
 */
function noteAppUse(grantId: string, record: typeof recordCloudAppUse): void {
  const now = Date.now();
  const windowMs = APP_USE_WINDOW_SECONDS * 1000;
  if (now - (appUseAskedAt.get(grantId) ?? -Infinity) < windowMs) return;
  for (const [id, askedAt] of appUseAskedAt) {
    if (now - askedAt >= windowMs) appUseAskedAt.delete(id);
  }
  appUseAskedAt.set(grantId, now);
  record(grantId).catch(recordAppUseLoss);
}

// The 1st, 2nd, 4th, 8th... occurrence: loud for a lasting fault, never one line per request.
function loggedOccurrence(count: number): boolean {
  return (count & (count - 1)) === 0;
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

/**
 * The client's name as the apps list shows it. A stored name that a header
 * cannot carry falls back to the next step of the same rule (platform, then
 * redirect host), both of which are ASCII.
 */
function cellClientName(client: OAuthClientIdentity): string | null {
  const [fallbackRedirectUri] = client.redirectUris;
  // Admission requires registered redirects, so an admitted client has one.
  if (fallbackRedirectUri === undefined) return null;
  const shown = oauthClientDisplayName(client, fallbackRedirectUri).displayName;
  if (HEADER_SAFE_VALUE.test(shown)) return shown;
  return oauthClientDisplayName({ ...client, clientName: null }, fallbackRedirectUri).displayName;
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: CACHE_HEADERS });
}

function unauthorized(config: Pick<ExomemCloudConfig, "mcpUrl" | "mcpPath">): Response {
  return Response.json(
    { error: "ACCESS_TOKEN_INVALID" },
    { status: 401, headers: { ...CACHE_HEADERS, "www-authenticate": cloudBearerChallenge(config) } }
  );
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
  recordAppUse?: typeof recordCloudAppUse;
  takeRateLimit?: typeof takeExomemRateLimit;
  fetchCell?: typeof fetch;
  /** Reaches the Substrate web API for the transfer tools; a test injects its own. */
  fetchControlPlane?: typeof fetch;
};

type PreparedBody = Awaited<ReturnType<typeof readCloudArtifactBody>>;

/**
 * D3's pass-through. Every branch below is numbered in the order it runs.
 * D3 lists the same steps with the IP limit before the token lookup; the
 * Home channel's first-party exemption (launch-exomem-cloud-web) moved it.
 */
export async function handleCloudMcpRequest(
  request: Request,
  dependencies: CloudGatewayDependencies = {}
): Promise<Response> {
  const config = dependencies.config ?? loadExomemCloudConfig();
  const findAccessToken = dependencies.findAccessToken ?? findCloudOAuthAccessToken;
  const recordAppUse = dependencies.recordAppUse ?? recordCloudAppUse;
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

  // 3. Bearer parse and token lookup (exact Cloud-resource match). The IP
  // decision below needs the lookup's answer, so a refusal waits for it.
  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  const access = bearer ? await findAccessToken(digestSecret(bearer), config.mcpUrl) : null;

  // 4. IP rate limit, keyed on the ingress-recorded client address. Home's
  // server calls for every owner from a few shared addresses, so a token
  // that the lookup resolved to the first-party client, by its stored row,
  // skips it; the identity limit below still applies to it. Every other
  // request, valid or not, takes the IP bucket before it is answered. Skipped
  // entirely when there is no address to key on (security review finding 6)
  // — never collapsed into one shared bucket.
  if (!access?.firstParty) {
    const ipKey = trustedIngressClientAddress(request);
    if (ipKey === null) {
      recordIpBucketSkip();
    } else if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIp, ipKey))) {
      return errorResponse(429, "RATE_LIMITED");
    }
  }
  if (!access) return unauthorized(config);

  // 5. Required scopes (D2), identity rate limit and concurrency guard.
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
    // 5b. The transfer tools are the control plane's, so they are answered
    // here, before the cell's desired-state gate: a held or stopped cell
    // still lets its owner see and control an import or an export.
    let prepared: PreparedBody | undefined;
    if (config.transferToolsEnabled && bearer && request.method === "POST") {
      const served = await serveTransferTool(
        request,
        access,
        bearer,
        config,
        dependencies.fetchControlPlane ?? fetch
      );
      if ("response" in served) {
        return releaseConcurrencyWhenBodyEnds(served.response, release);
      }
      prepared = served.prepared;
    }
    response = await proxyToCell(
      request,
      access,
      config,
      dependencies.fetchCell ?? fetch,
      recordAppUse,
      prepared
    );
  } catch (error) {
    release();
    throw error;
  }
  return releaseConcurrencyWhenBodyEnds(response, release);
}

/**
 * Reads the body once (the artifact reader's 1 MiB and 5 s bounds) and answers
 * a transfer tool call from the control plane. Any other request returns its
 * prepared body, which the cell path replays instead of reading the stream
 * again. Intercepted calls never reach the cell, so they note no app use.
 */
async function serveTransferTool(
  request: Request,
  access: ActiveCloudOAuthAccessToken,
  bearer: string,
  config: ExomemCloudConfig,
  fetchControlPlane: typeof fetch
): Promise<{ response: Response } | { prepared: PreparedBody }> {
  let prepared: PreparedBody;
  try {
    prepared = await readCloudArtifactBody(request);
  } catch (error) {
    if (error instanceof CloudArtifactBodyError) {
      return { response: errorResponse(error.status, "REQUEST_BODY_UNAVAILABLE") };
    }
    throw error;
  }
  const call = prepared.inspected
    ? parseCloudTransferCall(prepared.inspected, request.headers)
    : null;
  if (!call) return { prepared };
  const answer = await answerCloudTransferCall(call, {
    bearer,
    mcpUrl: config.mcpUrl,
    publicBaseUrl: exomemPublicBaseUrlFromEnv,
    clientContext: oauthClientContext(access.client.redirectUris),
    attachmentsEnabled: cloudArtifactTransportEnabled(config, access.cellId),
    fetchControlPlane,
  });
  return { response: Response.json(answer, { headers: CACHE_HEADERS }) };
}

async function proxyToCell(
  request: Request,
  access: ActiveCloudOAuthAccessToken,
  config: ExomemCloudConfig,
  fetchCell: typeof fetch,
  recordAppUse: typeof recordCloudAppUse,
  prepared?: PreparedBody
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "POST" } });
  }

  // 6. Gate on desired state, not the eventually consistent `ready` column.
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

  // The request goes to the cell, so the app reached its Exomem: Home's app row
  // says when. Home's own client is not an app. A lost note only leaves that
  // line older, or absent.
  if (!access.firstParty) noteAppUse(access.grantId, recordAppUse);

  // 7. Derive the per-cell bearer (C4).
  const cellBearer = deriveCloudCellBearer(config.cellTokenKey, access.cellId);

  // 8. Stream to the cell per C3: protocol request metadata is preserved
  // for the cell's header/body validation, never used to select its route.
  // Never forward client Authorization, cookies or forwarding headers.
  // Security review finding 12: accept-encoding is
  // always sent as identity upstream, regardless of what the caller sent —
  // the gateway relays the cell's body byte-for-byte and never decodes a
  // compressed one.
  const forwardHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) forwardHeaders.set(name, value);
  }
  // MCP 2026-07-28 requires intermediaries to preserve annotated parameter
  // headers. Headers validates field names; exclude the empty suffix.
  for (const [name, value] of request.headers) {
    if (
      name.startsWith(MCP_PARAMETER_HEADER_PREFIX) &&
      name.length > MCP_PARAMETER_HEADER_PREFIX.length
    ) {
      forwardHeaders.set(name, value);
    }
  }
  forwardHeaders.set("accept-encoding", "identity");
  forwardHeaders.set("authorization", `Bearer ${cellBearer}`);
  forwardHeaders.set("x-request-id", randomUUID());
  // Set from the token's stored client, never from the request; set() and
  // delete() also clear any copy that reached these headers some other way.
  const clientName = cellClientName(access.client);
  if (clientName === null) forwardHeaders.delete(CELL_CLIENT_NAME_HEADER);
  else forwardHeaders.set(CELL_CLIENT_NAME_HEADER, clientName);
  forwardHeaders.set(CELL_CLIENT_CONTEXT_HEADER, oauthClientContext(access.client.redirectUris));
  forwardHeaders.set(CELL_APP_ID_HEADER, access.grantId);

  let body: BodyInit | null | undefined =
    request.method === "DELETE" ? undefined : prepared ? prepared.body : request.body;
  if (
    config.artifactSigningKey &&
    cloudArtifactTransportEnabled(config, access.cellId) &&
    request.method === "POST"
  ) {
    try {
      const read = prepared ?? (await readCloudArtifactBody(request));
      body = read.body;
      const grant = read.inspected
        ? cloudArtifactGrant(read.inspected, access.cellId, config.artifactSigningKey)
        : null;
      if (grant) forwardHeaders.set("x-exomem-artifact-grant", grant);
    } catch (error) {
      if (error instanceof CloudArtifactBodyError) {
        return errorResponse(error.status, "REQUEST_BODY_UNAVAILABLE");
      }
      throw error;
    }
  }

  const upstreamUrl = `http://cell.exo-cell-${access.cellId}.svc.cluster.local:${CELL_PORT}/mcp`;
  let upstream: Response;
  try {
    upstream = await fetchCell(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body,
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
