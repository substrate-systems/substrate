import { cloudBearerChallenge } from "../lib/exomem-hosted/cloud-oauth";
/**
 * Exomem Cloud gateway handler (design D3, `adopt-exomem-cloud-plain-cells`).
 *
 * An authenticated pass-through: it resolves the caller's cell and streams the
 * request straight to it. server.ts mounts it at `EXOMEM_CLOUD_MCP_PATH`.
 */

import { randomUUID, type KeyObject } from "node:crypto";
import {
  CloudArtifactBodyError,
  cloudArtifactGrant,
  cloudArtifactTransportEnabled,
  readCloudArtifactBody,
} from "./cloud-artifacts";
import {
  CLOUD_DOWNLOAD_PATH,
  CLOUD_ORIGIN_HEADER,
  CLOUD_UPLOAD_ROUTE_HEADER,
  CLOUD_UPLOAD_TICKET_HEADER,
  cloudOAuthOrigin,
  cloudUploadEnabled,
  parseCloudUploadAuthorization,
  sameCloudOrigin,
  signCloudOriginProof,
  signCloudUploadRoute,
  verifyCloudUploadRoute,
  type CloudUploadRoute,
} from "./cloud-origin";
import { answerCloudTransferCall, parseCloudTransferCall } from "./cloud-transfer-tools";
import { hasForbiddenGatewayHeaders } from "./forbidden-headers";
import { deriveCloudCellBearer } from "../lib/exomem-hosted/cloud-cell-bearer";
import { loadExomemCloudConfig, type ExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";
import {
  APP_USE_WINDOW_SECONDS,
  findCloudOAuthAccessToken,
  findCloudOAuthLogin,
  recordCloudAppUse,
  type ActiveCloudOAuthAccessToken,
  type ActiveCloudOAuthLogin,
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
// The handoff's own byte cap plus the cell's multipart allowance; the cell enforces the ticket's limit.
const MAX_CLOUD_UPLOAD_BODY_BYTES = 100 * 1024 * 1024 + 1024 * 1024;
// The cell answers an upload with one small JSON object.
const MAX_CELL_UPLOAD_ANSWER_BYTES = 64 * 1024;
// The cell's download answer headers the gateway relays, and no others. The
// gateway sets its own cache-control, so the cell's is never on this list.
const RELAYED_DOWNLOAD_HEADERS = [
  "content-length",
  "content-range",
  "accept-ranges",
  "content-type",
  "content-disposition",
  "x-exomem-sha256",
  "x-exomem-size",
];
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
  findLogin?: typeof findCloudOAuthLogin;
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
  // bridge-cloud-agent-uploads: a selected cell learns which login sent this
  // request, and receives the route capsule that its upload handoff carries.
  if (config.artifactSigningKey && cloudUploadEnabled(config, access.cellId)) {
    try {
      const key = config.artifactSigningKey;
      forwardHeaders.set(
        CLOUD_ORIGIN_HEADER,
        await signCloudOriginProof(access, key, { purpose: "mcp" })
      );
      forwardHeaders.set(CLOUD_UPLOAD_ROUTE_HEADER, await signCloudUploadRoute(access, key));
    } catch {
      // Without both, the cell reports uploads unavailable; the MCP request itself proceeds.
      forwardHeaders.delete(CLOUD_ORIGIN_HEADER);
      forwardHeaders.delete(CLOUD_UPLOAD_ROUTE_HEADER);
      console.warn({ event: "exomem_cloud_gateway_upload_origin_unsigned" });
    }
  }

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

function uploadUnavailable(): Response {
  return errorResponse(401, "UPLOAD_HANDOFF_UNAVAILABLE");
}

/**
 * The login a delegated upload may still act for: its family, grant, client
 * admission, tenant and cell as they are now, identical to the capsule's,
 * on a cell still selected for uploads.
 */
async function currentUploadLogin(
  route: CloudUploadRoute,
  config: ExomemCloudConfig,
  findLogin: typeof findCloudOAuthLogin
): Promise<ActiveCloudOAuthLogin | null> {
  const login = await findLogin(
    { familyId: route.family_id, grantId: route.grant_id },
    config.mcpUrl
  );
  if (!login || !sameCloudOrigin(cloudOAuthOrigin(login), route)) return null;
  return cloudUploadEnabled(config, login.cellId) ? login : null;
}

/**
 * The delegated-upload route (bridge-cloud-agent-uploads). The caller holds
 * only its handoff token: the gateway's signed route capsule around the
 * cell's single-use ticket. Every check below runs before a body byte is read
 * or a cell is contacted; the cell then checks the ticket's own binding.
 */
export async function handleCloudUploadRequest(
  request: Request,
  dependencies: CloudGatewayDependencies = {}
): Promise<Response> {
  const config = dependencies.config ?? loadExomemCloudConfig();
  const findLogin = dependencies.findLogin ?? findCloudOAuthLogin;
  const takeRateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;
  const key = config.artifactSigningKey;

  // 1. With no cell selected the route does not exist.
  if (!key || !config.uploadCells?.size) {
    return new Response(null, { status: 404, headers: CACHE_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "POST" } });
  }
  if (hasForbiddenGatewayHeaders(request.headers)) {
    return errorResponse(400, "HOSTED_SELECTOR_REJECTED");
  }

  // 2. Every upload takes the IP bucket: Home's first-party client never uploads here.
  const ipKey = trustedIngressClientAddress(request);
  if (ipKey === null) {
    recordIpBucketSkip();
  } else if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIp, ipKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }

  // 3. The capsule's signature, audience, issuer, lifetime and endpoint.
  let ticket: string;
  let route: CloudUploadRoute;
  try {
    const handoff = parseCloudUploadAuthorization(request.headers.get("authorization"));
    ticket = handoff.ticket;
    route = await verifyCloudUploadRoute(handoff.capsule, key, config.mcpUrl);
  } catch {
    return uploadUnavailable();
  }

  // 4. Current authority, then write admission: only a running cell takes
  // bytes. The transfer tools' availability for held cells is not write authority.
  const login = await currentUploadLogin(route, config, findLogin);
  if (!login) return uploadUnavailable();
  if (login.cellDesiredState !== "running") return errorResponse(503, "CELL_NOT_READY");
  if (!CELL_ID_FORMAT.test(login.cellId)) {
    console.error({ event: "exomem_cloud_gateway_cell_id_invalid" });
    return errorResponse(500, "CELL_ID_INVALID");
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_CLOUD_UPLOAD_BODY_BYTES)
  ) {
    return errorResponse(413, "TOO_LARGE");
  }

  const identityKey = `${login.tenantId}:${login.clientId}`;
  if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIdentity, identityKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }
  const release = acquireCloudConcurrency(identityKey);
  if (!release) return errorResponse(429, "RATE_LIMITED");
  try {
    return releaseConcurrencyWhenBodyEnds(
      await relayUploadToCell(
        request,
        login,
        ticket,
        key,
        config,
        dependencies.fetchCell ?? fetch,
        () => currentUploadLogin(route, config, findLogin)
      ),
      release
    );
  } catch (error) {
    release();
    throw error;
  }
}

async function relayUploadToCell(
  request: Request,
  login: ActiveCloudOAuthLogin,
  ticket: string,
  key: KeyObject,
  config: ExomemCloudConfig,
  fetchCell: typeof fetch,
  recheck: () => Promise<ActiveCloudOAuthLogin | null>
): Promise<Response> {
  // 5. Fresh origin bound to this ticket, the derived cell bearer, and the
  // cell's fixed receiver. The caller's bearer and headers never reach it.
  const headers = new Headers({
    "accept-encoding": "identity",
    authorization: `Bearer ${deriveCloudCellBearer(config.cellTokenKey, login.cellId)}`,
    "x-request-id": randomUUID(),
    [CLOUD_ORIGIN_HEADER]: await signCloudOriginProof(login, key, { purpose: "upload", ticket }),
    [CLOUD_UPLOAD_TICKET_HEADER]: ticket,
  });
  const contentType = request.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);

  let upstream: Response;
  try {
    upstream = await fetchCell(
      `http://cell.exo-cell-${login.cellId}.svc.cluster.local:${CELL_PORT}/upload`,
      {
        method: "POST",
        headers,
        body: request.body,
        duplex: "half",
        signal: request.signal,
      } as RequestInit
    );
  } catch {
    return errorResponse(503, "CELL_NOT_READY");
  }
  const answer = await readCellUploadAnswer(upstream);
  if (answer === null) return errorResponse(502, "CELL_ANSWER_INVALID");
  // The cell refuses a ticket with this code; any other 401 means its bearer disagreed.
  if (upstream.status === 401 && answer.code !== "UPLOAD_HANDOFF_UNAVAILABLE") {
    return errorResponse(502, "CELL_AUTH_MISMATCH");
  }
  // 6. A login revoked while the bytes streamed gets no handle; the unused hold expires.
  if (upstream.status === 201 && !(await recheck())) return uploadUnavailable();
  return Response.json(answer, { status: upstream.status, headers: CACHE_HEADERS });
}

/** The cell's one small JSON object, or null for anything else. */
async function readCellUploadAnswer(upstream: Response): Promise<Record<string, unknown> | null> {
  if (!upstream.body) return null;
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CELL_UPLOAD_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The exact-original download route (add-cloud-media-store). The caller holds
 * its OAuth access token, as on the MCP route. Every check below runs before
 * the cell is contacted; each GET, range requests included, gets its own proof.
 */
export async function handleCloudDownloadRequest(
  request: Request,
  dependencies: CloudGatewayDependencies = {}
): Promise<Response> {
  const config = dependencies.config ?? loadExomemCloudConfig();
  const findAccessToken = dependencies.findAccessToken ?? findCloudOAuthAccessToken;
  const findLogin = dependencies.findLogin ?? findCloudOAuthLogin;
  const takeRateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;
  const key = config.artifactSigningKey;

  // 1. With no cell selected the route does not exist; the cell serves it only for the same key.
  if (!key || !config.uploadCells?.size) {
    return new Response(null, { status: 404, headers: CACHE_HEADERS });
  }
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "GET" } });
  }
  if (hasForbiddenGatewayHeaders(request.headers)) {
    return errorResponse(400, "HOSTED_SELECTOR_REJECTED");
  }

  // 2. Token lookup and IP bucket, in the MCP route's order.
  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  const access = bearer ? await findAccessToken(digestSecret(bearer), config.mcpUrl) : null;
  if (!access?.firstParty) {
    const ipKey = trustedIngressClientAddress(request);
    if (ipKey === null) {
      recordIpBucketSkip();
    } else if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIp, ipKey))) {
      return errorResponse(429, "RATE_LIMITED");
    }
  }
  if (!access) return unauthorized(config);
  if (!REQUIRED_CLOUD_SCOPES.every((scope) => access.scopes.includes(scope))) {
    return errorResponse(403, "INSUFFICIENT_SCOPE");
  }

  // 3. The one query parameter, decoded once; the proof binds exactly this value.
  const url = new URL(request.url);
  const paths = url.searchParams.getAll("path");
  if (paths.length !== 1 || paths[0] === "") return errorResponse(400, "PATH_REQUIRED");
  const path = paths[0];

  // 4. Only a selected, readable cell; the stored state is read here, not the eventually consistent `ready`.
  if (!cloudUploadEnabled(config, access.cellId)) return errorResponse(404, "NOT_FOUND");
  if (access.cellDesiredState !== "running" && access.cellDesiredState !== "read_only") {
    return errorResponse(503, "CELL_NOT_READY");
  }
  if (!CELL_ID_FORMAT.test(access.cellId)) {
    console.error({ event: "exomem_cloud_gateway_cell_id_invalid" });
    return errorResponse(500, "CELL_ID_INVALID");
  }
  const identityKey = `${access.tenantId}:${access.clientId}`;
  if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIdentity, identityKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }
  const release = acquireCloudConcurrency(identityKey);
  if (!release) return errorResponse(429, "RATE_LIMITED");
  try {
    // 5. Re-check the login as it is now, as the upload relay does.
    const login = await findLogin(
      { familyId: access.familyId, grantId: access.grantId },
      config.mcpUrl
    );
    if (!login || !sameCloudOrigin(cloudOAuthOrigin(login), cloudOAuthOrigin(access))) {
      release();
      return unauthorized(config);
    }
    return releaseConcurrencyWhenBodyEnds(
      await relayDownloadFromCell(
        request,
        login,
        path,
        key,
        config,
        dependencies.fetchCell ?? fetch
      ),
      release
    );
  } catch (error) {
    release();
    throw error;
  }
}

async function relayDownloadFromCell(
  request: Request,
  login: ActiveCloudOAuthLogin,
  path: string,
  key: KeyObject,
  config: ExomemCloudConfig,
  fetchCell: typeof fetch
): Promise<Response> {
  // The caller's token and headers never reach the cell: only the cell bearer,
  // a proof bound to this path, and the caller's Range.
  const headers = new Headers({
    "accept-encoding": "identity",
    authorization: `Bearer ${deriveCloudCellBearer(config.cellTokenKey, login.cellId)}`,
    "x-request-id": randomUUID(),
    [CLOUD_ORIGIN_HEADER]: await signCloudOriginProof(login, key, { purpose: "download", path }),
  });
  const range = request.headers.get("range");
  if (range !== null) headers.set("range", range);

  let upstream: Response;
  try {
    upstream = await fetchCell(
      `http://cell.exo-cell-${login.cellId}.svc.cluster.local:${CELL_PORT}${CLOUD_DOWNLOAD_PATH}?${new URLSearchParams({ path })}`,
      // A redirect is never followed: the cell has no reason to send one.
      { method: "GET", headers, redirect: "manual", signal: request.signal }
    );
  } catch {
    return errorResponse(503, "CELL_NOT_READY");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    return errorResponse(502, "CELL_ANSWER_INVALID");
  }
  // The cell refuses a bad proof or bearer with 401; to the caller that is a gateway fault, not its token.
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    return errorResponse(502, "CELL_AUTH_MISMATCH");
  }
  const relayed = new Headers({ "cache-control": "no-store" });
  for (const name of RELAYED_DOWNLOAD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) relayed.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: relayed });
}
