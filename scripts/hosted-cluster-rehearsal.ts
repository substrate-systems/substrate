import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { isIP, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "./migrate";
import { drainGatewayServer, createGatewayServer } from "../src/exomem-gateway/server";
import {
  activateExomemHostedRuntime,
  storeExomemAgentContractCandidate,
} from "../src/lib/exomem-hosted/agent-contract-store";
import { exomemHostedContractFixture } from "../src/lib/exomem-hosted/agent-contract-fixture";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createInviteRecord,
  type ExomemSql,
} from "../src/lib/exomem-hosted/db";
import { EXOMEM_ALPHA_BUNDLE } from "../src/lib/exomem-hosted/entitlements";
import { ExomemHostedError } from "../src/lib/exomem-hosted/errors";
import { routeExomemCommand } from "../src/lib/exomem-hosted/gateway";
import { SqlLifecycleStore } from "../src/lib/exomem-hosted/lifecycle-store";
import { handleHostedMcpRequest } from "../src/lib/exomem-hosted/mcp";
import {
  mintAuthorizationCode,
  mintOpaqueTokenMaterial,
  pkceS256,
} from "../src/lib/exomem-hosted/oauth";
import { parseCimdDocument } from "../src/lib/exomem-hosted/oauth-client-admission";
import {
  admitFirstOAuthInviteAtomic,
  createAuthorizationTransaction,
  issueOAuthTokensFromCodeAtomic,
  registerAdmittedCimdClient,
} from "../src/lib/exomem-hosted/oauth-store";
import { HttpCellProvisioner } from "../src/lib/exomem-hosted/provisioner";
import {
  expectedCellConfiguration,
  LifecycleReconciler,
} from "../src/lib/exomem-hosted/reconciler";
import { routableSetDigest } from "../src/lib/exomem-hosted/routable-authority";
import { getTrustedHostedRuntimeTarget } from "../src/lib/exomem-hosted/runtime-target-registry";
import { importTrustedHostedRuntimeTarget } from "../src/lib/exomem-hosted/runtime-target-store";
import {
  digestSecret,
  encryptSecret,
  generateExternalToken,
  SensitiveSecret,
} from "../src/lib/exomem-hosted/security";

const PUBLIC_BASE_URL = "https://substratesystems.io";
const RESOURCE = `${PUBLIC_BASE_URL}/api/exomem/mcp/v1`;
const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CONTROL_HOSTNAME = "control.drill.invalid";
const HANDOFF_FILENAME = "connection.json";
const REHEARSAL_DEADLINE_MS = 20 * 60_000;
const MAX_LOGGED_CONTENT_LENGTH = 4 * 1024 * 1024;
const SAFE_ENVELOPE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_STATE_STATUS = new Set([
  "accepted",
  "available",
  "completed",
  "error",
  "failed",
  "healthy",
  "ok",
  "pending",
  "preparing",
  "ready",
  "running",
  "serving",
  "succeeded",
  "unavailable",
]);
const claudeCimdRaw = JSON.stringify({
  client_id: CLAUDE_CLIENT_ID,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [CLAUDE_REDIRECT_URI],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

type Phase =
  | "schema-ready"
  | "runtime-active"
  | "admitted"
  | "waiting-for-provisioner"
  | "cell-ready"
  | "gateway-ready"
  | "waiting-for-finish"
  | "finished"
  | "failed";

type PhaseFields = {
  tenantId?: string;
  cellId?: string;
  operationId?: string;
  fence?: number;
};

function emitPhase(phase: Phase, fields: PhaseFields = {}): void {
  process.stdout.write(`${JSON.stringify({ phase, ...fields })}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

function selectedRuntimeTarget() {
  const release = process.env.EXOMEM_REHEARSAL_RELEASE ?? "0.77.0";
  const trusted = getTrustedHostedRuntimeTarget(release);
  if (!trusted || trusted.target.releaseVersion !== exomemHostedContractFixture.sourceRelease) {
    throw new Error("rehearsal requires a reviewed runtime target and matching candidate fixture");
  }
  const expected = process.env.EXOMEM_REHEARSAL_EXPECTED_TARGET;
  if (expected !== undefined) {
    let supplied: unknown;
    try {
      supplied = JSON.parse(expected);
    } catch {
      throw new Error("paired runtime target must be valid JSON");
    }
    if (!isDeepStrictEqual(supplied, trusted.target)) {
      throw new Error("paired runtime target differs from the reviewed consumer target");
    }
  }
  return trusted;
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.split(".")[0] === "127")
  );
}

function loopbackHttpOrigin(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact loopback HTTP origin`);
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.replace(/\/$/, "") !== url.origin
  ) {
    throw new Error(`${name} must be an exact loopback HTTP origin`);
  }
  return new URL(`${url.origin}/`);
}

function explicitDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXOMEM_TEST_DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !isLoopbackHostname(url.hostname) ||
    !url.hostname ||
    !url.pathname.slice(1) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EXOMEM_TEST_DATABASE_URL must be a loopback PostgreSQL URL without query options"
    );
  }
  return url;
}

async function privateStateDirectory(value: string): Promise<string> {
  const directory = resolve(value);
  if (directory === "/")
    throw new Error("EXOMEM_REHEARSAL_STATE_DIR must be a private scratch directory");
  try {
    const state = await lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
      throw new Error("EXOMEM_REHEARSAL_STATE_DIR must be a private scratch directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return directory;
}

function sql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

function transaction(pool: Pool) {
  return async <T>(work: (transactionSql: ExomemSql) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await work(sql(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

function digest(value: string): Buffer {
  const result = digestSecret(value);
  assert.ok(result);
  return result;
}

async function configureCapacity(pool: Pool): Promise<void> {
  const result = await pool.query(
    `UPDATE exomem_capacity_pools
     SET storage_capacity_bytes = 10737418240, runtime_capacity_slots = 2,
         provision_reservation_capacity = 2, provision_claim_capacity = 1,
         reserved_storage_bytes = 0, reserved_runtime_slots = 0,
         reserved_provision_slots = 0, configured_at = now()`
  );
  assert.equal(result.rowCount, 1);
}

async function importAndActivateRuntime(): Promise<{
  candidateId: string;
  runtimeTargetDigest: string;
}> {
  const trusted = selectedRuntimeTarget();
  const candidateId = await storeExomemAgentContractCandidate();
  const imported = await importTrustedHostedRuntimeTarget({
    candidateId,
    operatorPrincipalDigest: digest(generateExternalToken()),
  });
  assert.equal(imported.outcome, "imported");
  assert.equal(
    await activateExomemHostedRuntime({
      candidateId,
      expectedLiveCandidateId: null,
      expectedRoutableCellDigest: routableSetDigest(trusted.target.agentProfile, []),
    }),
    "activated"
  );
  return { candidateId, runtimeTargetDigest: imported.runtimeTargetDigest };
}

async function admitClaude(): Promise<{
  tenantId: string;
  operationId: string;
  accessToken: SensitiveSecret;
}> {
  const metadata = parseCimdDocument(claudeCimdRaw, CLAUDE_CLIENT_ID);
  const client = await registerAdmittedCimdClient(CLAUDE_CLIENT_ID, {
    fetchCimd: async () => metadata,
  });
  assert.ok(client);
  assert.deepEqual(client.redirectUris, [CLAUDE_REDIRECT_URI]);

  const invite = generateExternalToken();
  await createInviteRecord({
    tokenDigest: digest(invite),
    emailNormalized: `cluster-rehearsal-${randomUUID()}@example.test`,
    entitlementSource: "complimentary",
    capabilities: [...EXOMEM_ALPHA_BUNDLE.capabilities],
    resourceLimits: { ...EXOMEM_ALPHA_BUNDLE.resourceLimits },
    operatorPrincipalDigest: digest(generateExternalToken()),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const verifier = generateExternalToken();
  const authorizationCode = mintAuthorizationCode({
    clientId: CLAUDE_CLIENT_ID,
    redirectUri: CLAUDE_REDIRECT_URI,
    resource: RESOURCE,
    scopes: ["exomem.read", "exomem.write"],
    offlineAccess: true,
    codeChallenge: pkceS256(verifier),
  });
  const transactionToken = generateExternalToken();
  const transactionDigest = digest(transactionToken);
  assert.ok(
    await createAuthorizationTransaction({
      transactionDigest,
      stateDigest: digest(generateExternalToken()),
      stateEnvelope: encryptSecret(
        JSON.stringify({
          version: 1,
          state: generateExternalToken(),
          transaction: transactionToken,
        })
      ),
      formNonceDigest: digest(generateExternalToken()),
      continuationBinding: digest(generateExternalToken()),
      clientId: CLAUDE_CLIENT_ID,
      redirectUri: CLAUDE_REDIRECT_URI,
      resource: RESOURCE,
      scopes: ["exomem.read", "exomem.write", "offline_access"],
      pkceChallenge: pkceS256(verifier),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
  );
  const admitted = await admitFirstOAuthInviteAtomic({
    inviteDigest: digest(invite),
    transactionDigest,
    sessionDigest: digest(generateExternalToken()),
    csrfDigest: digest(generateExternalToken()),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
    codeDigest: authorizationCode.codeDigest,
    codeExpiresAt: authorizationCode.record.expiresAt,
  });
  assert.ok(admitted);
  assert.ok(admitted.operationId);

  const material = mintOpaqueTokenMaterial({ refreshAllowed: true });
  const issued = await issueOAuthTokensFromCodeAtomic({
    codeDigest: digest(authorizationCode.code),
    clientId: CLAUDE_CLIENT_ID,
    redirectUri: CLAUDE_REDIRECT_URI,
    resource: RESOURCE,
    pkceChallenge: pkceS256(verifier),
    refreshDigest: material.refreshTokenDigest!,
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessDigest: material.accessTokenDigest,
    accessExpiresAt: material.accessTokenExpiresAt,
  });
  assert.ok(issued);
  assert.equal(issued.refreshInserted, true);
  assert.deepEqual([...issued.scopes].sort(), ["exomem.read", "exomem.write"]);
  return {
    tenantId: admitted.tenantId,
    operationId: admitted.operationId,
    accessToken: material.accessToken,
  };
}

async function assertAlphaEntitlement(pool: Pool, tenantId: string): Promise<void> {
  const result = await pool.query<{
    capabilities: string[];
    resource_limits: Record<string, number>;
  }>(
    `SELECT capabilities, resource_limits
     FROM exomem_entitlements WHERE tenant_id = $1`,
    [tenantId]
  );
  assert.deepEqual(result.rows, [
    {
      capabilities: [...EXOMEM_ALPHA_BUNDLE.capabilities],
      resource_limits: { ...EXOMEM_ALPHA_BUNDLE.resourceLimits },
    },
  ]);
}

type SafeEnvelopeSummary = {
  parseableJson: boolean;
  topLevelKeys?: string[];
  success?: boolean;
  dataKeyNames?: string[];
  state?: string;
  status?: string;
  errorCode?: string;
};

function safeEnvelopeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => SAFE_ENVELOPE_KEY.test(key))
    .sort()
    .slice(0, 32);
}

function safeStateStatus(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_STATE_STATUS.has(value) ? value : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : undefined;
}

function safeEnvelopeSummary(value: unknown): SafeEnvelopeSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { parseableJson: true };
  }
  const envelope = value as Record<string, unknown>;
  const data =
    envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : undefined;
  const error =
    envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
      ? (envelope.error as Record<string, unknown>)
      : undefined;
  const state = safeStateStatus(data?.state ?? envelope.state);
  const status = safeStateStatus(data?.status ?? envelope.status);
  const errorCode = safeErrorCode(error?.code);
  return {
    parseableJson: true,
    topLevelKeys: safeEnvelopeKeys(envelope),
    ...(typeof envelope.success === "boolean" ? { success: envelope.success } : {}),
    ...(data ? { dataKeyNames: safeEnvelopeKeys(data) } : {}),
    ...(state ? { state } : {}),
    ...(status ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function privateEndpointKind(url: URL): "contract" | "agent-contract" | "command" | "other" {
  if (url.pathname.includes("/command/")) return "command";
  if (url.pathname.includes("/agent/") && url.pathname.endsWith("/contract")) {
    return "agent-contract";
  }
  return url.pathname.endsWith("/contract") ? "contract" : "other";
}

function logPrivateResponse(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response
): void {
  try {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    const method = (
      init?.method ?? (request instanceof Request ? request.method : "GET")
    ).toUpperCase();
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength =
      contentLengthHeader && /^(0|[1-9][0-9]{0,7})$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : undefined;
    process.stderr.write(
      `${JSON.stringify({
        event: "gateway-private-response",
        method,
        endpointKind: privateEndpointKind(url),
        status: response.status,
        contentType,
        ...(contentLength !== undefined && contentLength <= MAX_LOGGED_CONTENT_LENGTH
          ? { contentLength }
          : {}),
      })}\n`
    );
  } catch {
    // Rehearsal diagnostics must not change private routing behavior.
  }
}

const diagnosticRouteCommand: typeof routeExomemCommand = async (input) => {
  try {
    const result = await routeExomemCommand({
      ...input,
      dependencies: {
        ...input.dependencies,
        fetch: async (request, init) => {
          const response = await fetch(request, init);
          logPrivateResponse(request, init, response);
          return response;
        },
      },
    });
    process.stderr.write(
      `${JSON.stringify({
        event: "gateway-route-result",
        status: result.status,
        attempts: result.attempts,
        ...safeEnvelopeSummary(result.body),
      })}\n`
    );
    return result;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "gateway-route-error",
        errorCode:
          error instanceof ExomemHostedError
            ? error.code
            : (safeErrorCode((error as { code?: unknown } | null)?.code) ?? "UNCLASSIFIED_ERROR"),
      })}\n`
    );
    throw error;
  }
};

type OperationState = {
  state: string;
  checkpoint: string;
  next_attempt_at: Date;
  cell_id: string | null;
  fence_generation: string;
  error_code: string | null;
};

async function operationState(pool: Pool, operationId: string): Promise<OperationState> {
  const result = await pool.query<OperationState>(
    `SELECT state, checkpoint, next_attempt_at, cell_id::text, fence_generation::text, error_code
     FROM exomem_lifecycle_operations WHERE id = $1`,
    [operationId]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function reconcileProvision(input: {
  pool: Pool;
  tenantId: string;
  operationId: string;
  providerUrl: URL;
  providerBearer: string;
  wrappingKey: Buffer;
}): Promise<{ cellId: string; fence: number }> {
  const initial = await operationState(input.pool, input.operationId);
  const fence = Number(initial.fence_generation);
  assert.ok(Number.isSafeInteger(fence));
  let submitted = false;
  const provisionerFetch: typeof fetch = async (request, init) => {
    let responsePromise: Promise<Response>;
    try {
      const headers = new Headers(init?.headers);
      // The disposable loopback bridge is the trusted TLS terminator for the
      // production provisioner app, whose middleware still requires the
      // original public scheme to be HTTPS.
      headers.set("x-forwarded-proto", "https");
      responsePromise = fetch(request, { ...init, headers });
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: "provisioner-network-error",
          errorName: error instanceof Error ? error.name : "unknown",
        })}\n`
      );
      throw error;
    }
    if (!submitted && init?.method === "POST") {
      submitted = true;
      emitPhase("waiting-for-provisioner", {
        tenantId: input.tenantId,
        operationId: input.operationId,
        fence,
      });
    }
    try {
      const response = await responsePromise;
      let bodyCode: string | undefined;
      let bodyStatus: string | undefined;
      let retryable: boolean | undefined;
      try {
        const body = (await response.clone().json()) as Record<string, unknown>;
        if (typeof body.code === "string" && /^[A-Z0-9_]{1,64}$/.test(body.code)) {
          bodyCode = body.code;
        }
        if (typeof body.status === "string" && /^[a-z_]{1,32}$/.test(body.status)) {
          bodyStatus = body.status;
        }
        if (typeof body.retryable === "boolean") retryable = body.retryable;
      } catch {
        // Empty success bodies and non-JSON proxy failures are fully described by status.
      }
      process.stderr.write(
        `${JSON.stringify({
          event: "provisioner-response",
          status: response.status,
          ...(bodyCode ? { bodyCode } : {}),
          ...(bodyStatus ? { bodyStatus } : {}),
          ...(retryable === undefined ? {} : { retryable }),
        })}\n`
      );
      return response;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: "provisioner-network-error",
          errorName: error instanceof Error ? error.name : "unknown",
        })}\n`
      );
      throw error;
    }
  };
  const trusted = selectedRuntimeTarget();
  const reconciler = new LifecycleReconciler({
    store: new SqlLifecycleStore(),
    provisioner: new HttpCellProvisioner(
      {
        endpoint: input.providerUrl,
        credential: new SensitiveSecret(input.providerBearer),
        timeoutMs: 10_000,
        access: null,
      },
      provisionerFetch
    ),
    config: expectedCellConfiguration({
      protocolVersion: trusted.target.protocolVersion,
      releaseVersion: trusted.target.releaseVersion,
      workerPolicy: { workerCount: 2, semantic: true, media: false },
    }),
    envelopeKey: input.wrappingKey,
  });
  const deadline = Date.now() + 10 * 60_000;
  const owner = `cluster-rehearsal-${randomUUID()}`;
  while (Date.now() < deadline) {
    const result = await reconciler.reconcileOne({ owner, tenantId: input.tenantId });
    process.stderr.write(
      `${JSON.stringify({
        event: "lifecycle-reconcile-result",
        kind: result.kind,
        ...(result.kind === "idle" ? {} : { operationId: result.operationId }),
        ...(result.kind === "retry_scheduled" || result.kind === "terminal"
          ? { code: result.code }
          : {}),
      })}\n`
    );
    if (result.kind === "terminal") throw new Error(`Lifecycle terminal: ${result.code}`);
    if (result.kind === "succeeded") {
      assert.equal(result.operationId, input.operationId);
    }
    const current = await operationState(input.pool, input.operationId);
    if (current.state === "succeeded") {
      assert.ok(current.cell_id);
      return { cellId: current.cell_id, fence };
    }
    if (current.state === "failed_terminal") {
      throw new Error(`Lifecycle terminal: ${current.error_code ?? "unknown"}`);
    }
    process.stderr.write(
      `${JSON.stringify({
        event: "lifecycle-operation-state",
        operationId: input.operationId,
        state: current.state,
        checkpoint: current.checkpoint,
        ...(current.error_code ? { errorCode: current.error_code } : {}),
      })}\n`
    );
    const waitMs = Math.min(30_000, Math.max(100, current.next_attempt_at.getTime() - Date.now()));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, waitMs));
  }
  throw new Error("Lifecycle reconciliation deadline exceeded");
}

async function listenGateway(accessToken: SensitiveSecret): Promise<{
  endpoint: string;
  close: () => Promise<void>;
}> {
  const server = createGatewayServer({
    handleMcp: (request) =>
      handleHostedMcpRequest(request, {
        baseUrl: PUBLIC_BASE_URL,
        takeRateLimit: async () => true,
        routeCommand: diagnosticRouteCommand,
      }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo | null;
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/exomem/mcp/v1`;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${accessToken.reveal()}` } },
  });
  const client = new Client({ name: "hosted-cluster-rehearsal", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      exomemHostedContractFixture.compatibility.agent_contract.commands.map(
        (command) => command.mcp_tool.name
      )
    );
  } finally {
    await transport.close();
  }
  return { endpoint, close: () => drainGatewayServer(server) };
}

async function writeHandoff(
  stateDirectory: string,
  value: Record<string, unknown>
): Promise<string> {
  const finalPath = resolve(stateDirectory, HANDOFF_FILENAME);
  const temporaryPath = resolve(stateDirectory, `.connection-${randomUUID()}.json`);
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await unlink(temporaryPath);
  await chmod(finalPath, 0o600);
  return finalPath;
}

async function waitForFinish(): Promise<void> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  await new Promise<void>((resolveFinish, reject) => {
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error("Rehearsal finish deadline exceeded"));
    }, REHEARSAL_DEADLINE_MS);
    const finish = () => {
      clearTimeout(timeout);
      lines.close();
      resolveFinish();
    };
    lines.on("line", (line) => {
      if (line === "finish") finish();
    });
    lines.once("close", () => {
      if (!process.stdin.readable) finish();
    });
  });
}

async function main(): Promise<void> {
  const selected = selectedRuntimeTarget();
  if (process.argv.length === 3 && process.argv[2] === "--describe-runtime-target") {
    process.stdout.write(`${JSON.stringify(selected.target)}\n`);
    return;
  }
  if (process.argv.length !== 2) throw new Error("unknown rehearsal arguments");
  if (!process.env.EXOMEM_REHEARSAL_EXPECTED_TARGET) {
    throw new Error("paired runtime target is required before creating rehearsal resources");
  }
  const databaseUrl = explicitDatabaseUrl(requiredEnvironment("EXOMEM_TEST_DATABASE_URL"));
  const providerUrl = loopbackHttpOrigin(
    "EXOMEM_REHEARSAL_PROVIDER_URL",
    requiredEnvironment("EXOMEM_REHEARSAL_PROVIDER_URL")
  );
  const ingressUrl = loopbackHttpOrigin(
    "EXOMEM_REHEARSAL_INGRESS_URL",
    requiredEnvironment("EXOMEM_REHEARSAL_INGRESS_URL")
  );
  const providerBearer = requiredEnvironment("EXOMEM_REHEARSAL_PROVIDER_BEARER");
  const stateDirectory = await privateStateDirectory(
    requiredEnvironment("EXOMEM_REHEARSAL_STATE_DIR")
  );
  const handoffPath = resolve(stateDirectory, HANDOFF_FILENAME);
  try {
    await lstat(handoffPath);
    throw new Error(`${HANDOFF_FILENAME} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const schema = `hosted_cluster_rehearsal_${randomUUID().replaceAll("-", "")}`;
  const scopedDatabaseUrl = new URL(databaseUrl);
  scopedDatabaseUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const admin = new Pool({ connectionString: databaseUrl.toString() });
  let pool: Pool | undefined;
  let gatewayClose: (() => Promise<void>) | undefined;
  let schemaCreated = false;
  let handoffWritten = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A = "yes";
    const originalLog = console.log;
    const originalStdoutWrite = process.stdout.write;
    console.log = () => undefined;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await applyMigrations({ databaseUrl: scopedDatabaseUrl.toString() });
    } finally {
      console.log = originalLog;
      process.stdout.write = originalStdoutWrite;
    }
    pool = new Pool({ connectionString: scopedDatabaseUrl.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction(pool));

    const wrappingKey = randomBytes(32);
    process.env.DATABASE_URL = scopedDatabaseUrl.toString();
    process.env.EXOMEM_CONTROL_PLANE_KEY = wrappingKey.toString("base64url");
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    process.env.EXOMEM_PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.EXOMEM_CELL_PROTOCOL_VERSION = "1";
    process.env.EXOMEM_GATEWAY_CONTROL_HOSTNAME = CONTROL_HOSTNAME;
    process.env.EXOMEM_GATEWAY_INTERNAL_ORIGIN = ingressUrl.origin;
    process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = "x-exomem-rehearsal-ingress";
    process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE = randomUUID();

    emitPhase("schema-ready");
    const target = await importAndActivateRuntime();
    emitPhase("runtime-active");
    await configureCapacity(pool);
    const admission = await admitClaude();
    await assertAlphaEntitlement(pool, admission.tenantId);
    const initial = await operationState(pool, admission.operationId);
    const fence = Number(initial.fence_generation);
    emitPhase("admitted", {
      tenantId: admission.tenantId,
      operationId: admission.operationId,
      fence,
    });
    const ready = await reconcileProvision({
      pool,
      tenantId: admission.tenantId,
      operationId: admission.operationId,
      providerUrl,
      providerBearer,
      wrappingKey,
    });
    assert.equal(
      (await new SqlLifecycleStore().statusForTenant(admission.tenantId)).state,
      "ready"
    );
    emitPhase("cell-ready", {
      tenantId: admission.tenantId,
      cellId: ready.cellId,
      operationId: admission.operationId,
      fence: ready.fence,
    });

    const gateway = await listenGateway(admission.accessToken);
    gatewayClose = gateway.close;
    emitPhase("gateway-ready", {
      tenantId: admission.tenantId,
      cellId: ready.cellId,
      operationId: admission.operationId,
      fence: ready.fence,
    });
    const trusted = selectedRuntimeTarget();
    await writeHandoff(stateDirectory, {
      mcp_endpoint: gateway.endpoint,
      access_token: admission.accessToken.reveal(),
      tenant_id: admission.tenantId,
      cell_id: ready.cellId,
      operation_id: admission.operationId,
      schema,
      target: {
        candidate_id: target.candidateId,
        release_version: trusted.target.releaseVersion,
        protocol_version: trusted.target.protocolVersion,
        runtime_target_digest: target.runtimeTargetDigest,
        runtime_target: trusted.target,
      },
    });
    handoffWritten = true;
    emitPhase("waiting-for-finish", {
      tenantId: admission.tenantId,
      cellId: ready.cellId,
      operationId: admission.operationId,
      fence: ready.fence,
    });
    await waitForFinish();
    emitPhase("finished", {
      tenantId: admission.tenantId,
      cellId: ready.cellId,
      operationId: admission.operationId,
      fence: ready.fence,
    });
  } finally {
    if (gatewayClose) await gatewayClose().catch(() => undefined);
    if (handoffWritten) await unlink(handoffPath).catch(() => undefined);
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end().catch(() => undefined);
    if (schemaCreated) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  emitPhase("failed");
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`hosted cluster rehearsal failed: ${message}\n`);
  process.exitCode = 1;
});
