import { cloudBearerChallenge } from "../lib/exomem-hosted/cloud-oauth";
/**
 * Exomem Cloud gateway handler (design D3, `adopt-exomem-cloud-plain-cells`).
 *
 * An authenticated pass-through: it resolves the caller's cell and streams the
 * request straight to it. server.ts mounts it at `EXOMEM_CLOUD_MCP_PATH`.
 */

import { randomUUID, type KeyObject } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import {
  CloudArtifactBodyError,
  cloudArtifactGrant,
  cloudArtifactTransportEnabled,
  readCloudArtifactBody,
} from "./cloud-artifacts";
import {
  CLOUD_DISCOVERY_PATH,
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
import {
  gatewayCloudUpstream,
  holdForCell,
  isCellConnectFailure,
  isCellHeadersTimeout,
  resetCloudHoldForTests,
  type CloudUpstream,
} from "./cloud-upstream";
import { hasForbiddenGatewayHeaders } from "./forbidden-headers";
import { deriveCloudCellBearer } from "../lib/exomem-hosted/cloud-cell-bearer";
import { loadExomemCloudConfig, type ExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";
import { loggedOccurrence } from "../lib/exomem-hosted/logged-occurrence";
import {
  APP_USE_WINDOW_SECONDS,
  findCloudOAuthAccessToken,
  findCloudOAuthLogin,
  recordCloudAppUse,
  REQUIRED_CLOUD_SCOPES,
  type ActiveCloudOAuthAccessToken,
  type ActiveCloudOAuthLogin,
} from "../lib/exomem-hosted/cloud-oauth";
import {
  findCloudServiceCredential,
  type ActiveCloudServiceCredential,
} from "../lib/exomem-hosted/cloud-service-credentials";
import { SERVICE_CREDENTIAL_PREFIX } from "../lib/exomem-hosted/service-credential-format";
import { ADVERTISED_SCOPES, parseBearerAuthorization } from "../lib/exomem-hosted/oauth";
import {
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
// Design D6's authenticated discovery body cap (add-cloud-service-credentials).
const MAX_CLOUD_DISCOVERY_BYTES = 64 * 1024;
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
  resetCloudHoldForTests();
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
 * The gateway server's own per-process cap (server.ts), which counts every
 * request it serves. A held request gives it back while it waits (D5).
 */
export type GatewayServerSlot = { release(): void; take(): boolean };

/**
 * One request's in-flight slot. `leave` and `retake` serve the hold: a held
 * request counts against the hold caps, not the in-flight caps, until its cell
 * accepts a connection.
 */
function takeInflightSlot(key: string, server?: GatewayServerSlot) {
  let releaseCall = acquireCloudConcurrency(key);
  if (!releaseCall) return null;
  const release = () => {
    releaseCall?.();
    releaseCall = null;
  };
  return {
    release,
    leave() {
      release();
      server?.release();
    },
    retake(): boolean {
      if (server && !server.take()) return false;
      releaseCall = acquireCloudConcurrency(key);
      if (releaseCall) return true;
      server?.release();
      return false;
    },
  };
}

type InflightSlot = NonNullable<ReturnType<typeof takeInflightSlot>>;

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

/**
 * Design D4's mark: access the service-credential lookup resolved rather than
 * the OAuth one (add-cloud-service-credentials D2). A resolved service
 * credential skips the IP bucket — its `tenant:principal` identity limit is
 * the bound — and notes no OAuth app use.
 */
function isServiceCredentialAccess(
  access: ActiveCloudOAuthAccessToken | null
): access is ActiveCloudServiceCredential {
  return (
    access !== null && (access as ActiveCloudServiceCredential).serviceCredential === true
  );
}

/** D5: a request the hold could not serve tells the client when to try again. */
function cellNotReadyRetryLater(upstream: CloudUpstream): Response {
  return Response.json(
    { error: "CELL_NOT_READY" },
    {
      status: 503,
      headers: { ...CACHE_HEADERS, "retry-after": String(upstream.retryAfterSeconds) },
    }
  );
}

function defaultCellOrigin(cellId: string): string {
  return `http://cell.exo-cell-${cellId}.svc.cluster.local:${CELL_PORT}`;
}

// undici's own fetch, so the dispatcher that carries the D5 timeouts is the
// same library version that reads it.
const defaultFetchCell = undiciFetch as unknown as typeof fetch;

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
  findServiceCredential?: typeof findCloudServiceCredential;
  findLogin?: typeof findCloudOAuthLogin;
  recordAppUse?: typeof recordCloudAppUse;
  takeRateLimit?: typeof takeExomemRateLimit;
  fetchCell?: typeof fetch;
  /** Reaches the Substrate web API for the transfer tools; a test injects its own. */
  fetchControlPlane?: typeof fetch;
  /** The D5 hold and timeouts; the gateway reads them from its environment at start. */
  upstream?: CloudUpstream;
  /** The cell's base URL; a test points it at a stand-in cell. */
  cellOrigin?: (cellId: string) => string;
  /** Set by server.ts, so a held request also gives back the server's slot. */
  serverSlot?: GatewayServerSlot;
};

type PreparedBody = Awaited<ReturnType<typeof readCloudArtifactBody>>;

/**
 * Review B4: the one place a Cloud route turns the Authorization header into
 * access — bearer parse, D2's prefix dispatch, the IP bucket, the refusal and
 * the required-scope check — shared by the MCP, discovery and download routes
 * so the dispatch can never drift between them again.
 *
 * `serviceCredentials` is the route's contract: the MCP and discovery routes
 * admit both credential kinds; the download route keeps its OAuth-only
 * contract, where an `exs_` bearer is refused without touching either lookup.
 * A resolved first-party or service credential skips the IP bucket — its
 * identity limit is the bound — while a bearer the lookup refused, including
 * an unresolved `exs_`, pays it before the 401 (D4).
 */
async function authenticateCloudBearer(
  request: Request,
  dependencies: CloudGatewayDependencies,
  config: ExomemCloudConfig,
  admission: { serviceCredentials: boolean }
): Promise<{ access: ActiveCloudOAuthAccessToken; bearer: string } | { response: Response }> {
  const findAccessToken = dependencies.findAccessToken ?? findCloudOAuthAccessToken;
  const findServiceCredential = dependencies.findServiceCredential ?? findCloudServiceCredential;
  const takeRateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;

  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  const access = bearer
    ? bearer.startsWith(SERVICE_CREDENTIAL_PREFIX)
      ? admission.serviceCredentials
        ? await findServiceCredential(digestSecret(bearer), config.mcpUrl)
        : null
      : await findAccessToken(digestSecret(bearer), config.mcpUrl)
    : null;

  if (!access?.firstParty && !isServiceCredentialAccess(access)) {
    const ipKey = trustedIngressClientAddress(request);
    if (ipKey === null) {
      recordIpBucketSkip();
    } else if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIp, ipKey))) {
      return { response: errorResponse(429, "RATE_LIMITED") };
    }
  }
  if (!access) return { response: unauthorized(config) };
  // Security review finding 2: a cell exposes one fixed non-owner principal
  // and cannot itself enforce a read-only grant, so a credential missing
  // either required scope is refused here, before any cell contact.
  if (!REQUIRED_CLOUD_SCOPES.every((scope) => access.scopes.includes(scope))) {
    return { response: errorResponse(403, "INSUFFICIENT_SCOPE") };
  }
  return { access, bearer: bearer as string };
}

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

  // 3–4. Bearer admission — parse, D2's prefix dispatch, the IP bucket, the
  // refusal and the scope check — is the shared helper every Cloud route
  // uses (review B4). This route admits both credential kinds.
  const admitted = await authenticateCloudBearer(request, dependencies, config, {
    serviceCredentials: true,
  });
  if ("response" in admitted) return admitted.response;
  const { access, bearer } = admitted;

  // 5. Identity rate limit and concurrency guard.
  const identityKey = `${access.tenantId}:${access.clientId}`;
  if (!(await takeRateLimit(EXOMEM_RATE_LIMITS.mcpIdentity, identityKey))) {
    return errorResponse(429, "RATE_LIMITED");
  }

  const slot = takeInflightSlot(identityKey, dependencies.serverSlot);
  if (!slot) return errorResponse(429, "RATE_LIMITED");
  const release = slot.release;
  let response: Response;
  try {
    // 5b. The transfer tools are the control plane's, so they are answered
    // here, before the cell's desired-state gate: a held or stopped cell
    // still lets its owner see and control an import or an export. They are
    // OAuth authority — a service credential is never sent to the control
    // plane as one (D2), so it only ever proxies.
    let prepared: PreparedBody | undefined;
    if (
      config.transferToolsEnabled &&
      !isServiceCredentialAccess(access) &&
      request.method === "POST"
    ) {
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
    response = await proxyToCell(request, access, config, dependencies, slot, prepared);
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
    clientContext: access.client.clientContext,
    attachmentsEnabled: cloudArtifactTransportEnabled(config, access.cellId),
    fetchControlPlane,
  });
  return { response: Response.json(answer, { headers: CACHE_HEADERS }) };
}

async function proxyToCell(
  request: Request,
  access: ActiveCloudOAuthAccessToken,
  config: ExomemCloudConfig,
  dependencies: CloudGatewayDependencies,
  slot: InflightSlot,
  prepared?: PreparedBody
): Promise<Response> {
  const fetchCell = dependencies.fetchCell ?? defaultFetchCell;
  const recordAppUse = dependencies.recordAppUse ?? recordCloudAppUse;
  const upstreamSettings = dependencies.upstream ?? gatewayCloudUpstream();
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
  // line older, or absent. A service credential has no grant row for the app
  // table to name, so it notes nothing (add-cloud-service-credentials D3).
  if (!access.firstParty && !isServiceCredentialAccess(access)) {
    noteAppUse(access.grantId, recordAppUse);
  }

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
  // Review R4: a service credential is named by its stored principal — the
  // same value the origin proof carries as client — never a request value.
  const clientName = isServiceCredentialAccess(access)
    ? access.clientId
    : cellClientName(access.client);
  if (clientName === null) forwardHeaders.delete(CELL_CLIENT_NAME_HEADER);
  else forwardHeaders.set(CELL_CLIENT_NAME_HEADER, clientName);
  forwardHeaders.set(CELL_CLIENT_CONTEXT_HEADER, access.client.clientContext);
  forwardHeaders.set(CELL_APP_ID_HEADER, access.grantId);
  // D5: with the hold on, every body is prepared through the one capped
  // reader, so a held request can be sent again. A body over the cap streams
  // as before and is never held.
  const holdOn = upstreamSettings.holdBudgetMs > 0;
  const inspectArtifacts = Boolean(
    config.artifactSigningKey && cloudArtifactTransportEnabled(config, access.cellId)
  );
  let read = prepared;
  if (request.method === "POST" && !read && (inspectArtifacts || holdOn)) {
    try {
      read = await readCloudArtifactBody(request);
    } catch (error) {
      if (error instanceof CloudArtifactBodyError) {
        return errorResponse(error.status, "REQUEST_BODY_UNAVAILABLE");
      }
      throw error;
    }
  }
  const body: BodyInit | null | undefined =
    request.method === "DELETE" ? undefined : read ? read.body : request.body;
  // contain-cloud-controller-compromise D1: with the signing key set, every cell learns which
  // login sent this request. Only a cell selected for uploads also gets the route capsule that
  // its upload handoff carries (bridge-cloud-agent-uploads). The proofs and the artifact grant
  // live 60 s, so they are signed before each connect attempt: a hold can outlast them, and a
  // retry with expired proofs reads as bearer-only.
  const signProofs = async () => {
    const key = config.artifactSigningKey;
    if (!key) return;
    try {
      forwardHeaders.set(
        CLOUD_ORIGIN_HEADER,
        await signCloudOriginProof(access, key, { purpose: "mcp" })
      );
      // Review B2: a service credential cannot redeem the upload handoff at
      // the control plane, so it is never signed the route capsule — its call
      // carries the origin proof alone, like a cell not selected for uploads.
      if (cloudUploadEnabled(config, access.cellId) && !isServiceCredentialAccess(access)) {
        forwardHeaders.set(CLOUD_UPLOAD_ROUTE_HEADER, await signCloudUploadRoute(access, key));
      }
    } catch {
      // Without the proof the cell counts the request as bearer-only, and an upload cell
      // reports uploads unavailable; the MCP request itself proceeds.
      forwardHeaders.delete(CLOUD_ORIGIN_HEADER);
      forwardHeaders.delete(CLOUD_UPLOAD_ROUTE_HEADER);
      console.warn({ event: "exomem_cloud_gateway_upload_origin_unsigned" });
    }
    if (inspectArtifacts && request.method === "POST") {
      const grant = read?.inspected ? cloudArtifactGrant(read.inspected, access.cellId, key) : null;
      if (grant) forwardHeaders.set("x-exomem-artifact-grant", grant);
      else forwardHeaders.delete("x-exomem-artifact-grant");
    }
  };

  const holdable = holdOn && (request.method === "DELETE" || read?.inspected !== undefined);

  const origin = new URL((dependencies.cellOrigin ?? defaultCellOrigin)(access.cellId));
  let deadline: number | undefined;
  let upstream: Response;
  while (true) {
    await signProofs();
    try {
      upstream = await fetchCell(new URL("/mcp", origin).toString(), {
        method: request.method,
        headers: forwardHeaders,
        body,
        duplex: "half",
        signal: request.signal,
        dispatcher: upstreamSettings.dispatcher,
      } as RequestInit);
      break;
    } catch (error) {
      if (isCellHeadersTimeout(error)) return errorResponse(504, "CELL_TIMEOUT");
      // Only a connection that never opened is retried: a request the cell
      // may have read could run twice.
      if (!holdable || !isCellConnectFailure(error) || request.signal.aborted) {
        return errorResponse(503, "CELL_NOT_READY");
      }
      deadline ??= Date.now() + upstreamSettings.holdBudgetMs;
      const outcome = await holdForCell({
        origin,
        tenantId: access.tenantId,
        upstream: upstreamSettings,
        deadline,
        signal: request.signal,
        inflight: slot,
      });
      if (outcome === "busy") return errorResponse(429, "RATE_LIMITED");
      if (outcome !== "accepted") return cellNotReadyRetryLater(upstreamSettings);
    }
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
      await relayUploadToCell(request, login, ticket, key, config, dependencies, () =>
        currentUploadLogin(route, config, findLogin)
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
  dependencies: CloudGatewayDependencies,
  recheck: () => Promise<ActiveCloudOAuthLogin | null>
): Promise<Response> {
  const fetchCell = dependencies.fetchCell ?? defaultFetchCell;
  const origin = (dependencies.cellOrigin ?? defaultCellOrigin)(login.cellId);
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
    upstream = await fetchCell(`${origin}/upload`, {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
      signal: request.signal,
      dispatcher: (dependencies.upstream ?? gatewayCloudUpstream()).dispatcher,
    } as RequestInit);
  } catch (error) {
    if (isCellHeadersTimeout(error)) return errorResponse(504, "CELL_TIMEOUT");
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

  // 2. Token lookup and IP bucket, in the MCP route's order — the shared
  // admission helper (review B4). This route keeps its OAuth-only contract:
  // an `exs_` bearer is refused without touching either lookup, so no service
  // credential — and no OAuth token whose bytes collided with the prefix —
  // can reach a cell here.
  const admitted = await authenticateCloudBearer(request, dependencies, config, {
    serviceCredentials: false,
  });
  if ("response" in admitted) return admitted.response;
  const { access } = admitted;

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
      await relayDownloadFromCell(request, login, path, key, config, dependencies),
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
  dependencies: CloudGatewayDependencies
): Promise<Response> {
  const fetchCell = dependencies.fetchCell ?? defaultFetchCell;
  const origin = (dependencies.cellOrigin ?? defaultCellOrigin)(login.cellId);
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
      `${origin}${CLOUD_DOWNLOAD_PATH}?${new URLSearchParams({ path })}`,
      // A redirect is never followed: the cell has no reason to send one.
      {
        method: "GET",
        headers,
        redirect: "manual",
        signal: request.signal,
        dispatcher: (dependencies.upstream ?? gatewayCloudUpstream()).dispatcher,
      } as RequestInit
    );
  } catch (error) {
    if (isCellHeadersTimeout(error)) return errorResponse(504, "CELL_TIMEOUT");
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

/**
 * Design D6's discovery pass-through (add-cloud-service-credentials): an
 * authenticated caller — OAuth token or service credential — receives the
 * bytes its own cell serves at `/.well-known/exomem-cell`, byte for byte.
 * Every check below runs before the cell is contacted, in the MCP route's
 * order; the credential selects the cell exactly as it does there, so a
 * caller can never read another tenant's discovery document.
 */
export async function handleCloudDiscoveryRequest(
  request: Request,
  dependencies: CloudGatewayDependencies = {}
): Promise<Response> {
  const config = dependencies.config ?? loadExomemCloudConfig();
  const takeRateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;

  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { ...CACHE_HEADERS, allow: "GET" } });
  }
  if (hasForbiddenGatewayHeaders(request.headers)) {
    return errorResponse(400, "HOSTED_SELECTOR_REJECTED");
  }

  // The shared admission helper (review B4) — this route, like the MCP route,
  // admits both credential kinds.
  const admitted = await authenticateCloudBearer(request, dependencies, config, {
    serviceCredentials: true,
  });
  if ("response" in admitted) return admitted.response;
  const { access } = admitted;
  if (access.cellDesiredState !== "running" && access.cellDesiredState !== "read_only") {
    return errorResponse(503, "CELL_NOT_READY");
  }
  // The same cell_id revalidation the MCP route runs before building a URL.
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
    return await relayDiscoveryFromCell(request, access, dependencies);
  } finally {
    release();
  }
}

async function relayDiscoveryFromCell(
  request: Request,
  access: ActiveCloudOAuthAccessToken,
  dependencies: CloudGatewayDependencies
): Promise<Response> {
  const fetchCell = dependencies.fetchCell ?? defaultFetchCell;
  const origin = (dependencies.cellOrigin ?? defaultCellOrigin)(access.cellId);
  // The cell's discovery document is unauthenticated inside the cluster — the
  // credential check above is the boundary. No bearer, no proof and none of
  // the caller's headers reach the cell (D6).
  let upstream: Response;
  try {
    upstream = await fetchCell(new URL(CLOUD_DISCOVERY_PATH, origin).toString(), {
      method: "GET",
      headers: new Headers({ "accept-encoding": "identity", "x-request-id": randomUUID() }),
      redirect: "manual",
      signal: request.signal,
      dispatcher: (dependencies.upstream ?? gatewayCloudUpstream()).dispatcher,
    } as RequestInit);
  } catch (error) {
    if (isCellHeadersTimeout(error)) return errorResponse(504, "CELL_TIMEOUT");
    return errorResponse(503, "CELL_NOT_READY");
  }
  if (upstream.status !== 200) {
    await upstream.body?.cancel().catch(() => undefined);
    return errorResponse(502, "CELL_ANSWER_INVALID");
  }
  const body = await readCellDiscoveryBody(upstream);
  if (body === null) return errorResponse(502, "CELL_ANSWER_INVALID");
  const headers = new Headers(CACHE_HEADERS);
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return new Response(body, { status: 200, headers });
}

/** The cell's discovery document under the D6 cap, or null when it is larger. */
async function readCellDiscoveryBody(
  upstream: Response
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!upstream.body) return new Uint8Array(0);
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CLOUD_DISCOVERY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
