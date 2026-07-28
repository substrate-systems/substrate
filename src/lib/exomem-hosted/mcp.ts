import { createHash, createHmac, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
  ListToolsResultSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  EXOMEM_HOSTED_PROFILE,
  EXOMEM_HOSTED_RESOURCE,
  getLiveExomemAgentContract,
  type LiveExomemAgentContract,
} from "./agent-contract-store";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  hasForbiddenGatewayHeaders,
  routeExomemCommand,
  type HostedContractCommand,
} from "./gateway";
import { SqlLifecycleStore } from "./lifecycle-store";
import { findMcpOAuthAccessToken, type ActiveOAuthAccessToken } from "./oauth-store";
import { bearerChallenge, mcpAuthenticateMeta, parseBearerAuthorization } from "./oauth";
import { exomemPublicBaseUrlFromEnv } from "./public-origin";
import { buildOperationalEvent, type OperationalEvent } from "./observability";
import { EXOMEM_RATE_LIMITS, clientAddressKey, takeExomemRateLimit } from "./rate-limit";
import { controlPlaneKeyFromEnv, digestSecret } from "./security";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MAX_MCP_CONCURRENCY = 16;
let activeMcpCalls = 0;
const activeMcpCallsByTenantClient = new Map<string, number>();
const MAX_MCP_TENANT_CLIENT_CONCURRENCY = 4;
const MCP_BODY_TIMEOUT_MS = 10_000;
const PRIVATE_ERROR_MESSAGES: Record<string, string> = {
  CELL_UNAVAILABLE: "your Exomem is temporarily unavailable",
  COMMAND_NOT_FOUND: "that Exomem action is not available",
  EXOMEM_ENTITLEMENT_DENIED: "your current Exomem access does not include this action",
  INVALID_REQUEST: "the request could not be accepted",
  RATE_LIMITED: "too many requests",
};
const PRIVATE_REMEDIATIONS = new Set(["retry_later", "contact_support", "deletion_in_progress"]);

type JsonRecord = Record<string, unknown>;
type McpTelemetryInput = {
  outcome: "succeeded" | "failed" | "denied";
  errorCode?: string;
  access?: ActiveOAuthAccessToken;
  tool?: LiveTool;
  startedAt?: number;
  requestClass?: "request" | "tool";
  requestBytes?: number;
  responseBytes?: number;
  retryBucket?: "none" | "retried";
  requestId?: string;
};
type LiveTool = {
  tool: JsonRecord;
  readOnly: boolean;
  command: HostedContractCommand;
  inputSchema: JsonRecord;
  outputSchema: JsonRecord;
  inputValidator: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  outputValidator: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
};
type LifecycleStatus = { state: string; code: string; retryable: boolean; requestId?: string };

export type McpDependencies = {
  findAccessToken?: (digest: Buffer) => Promise<ActiveOAuthAccessToken | null>;
  getLiveContract?: () => Promise<LiveExomemAgentContract | null>;
  statusForTenant?: (tenantId: string) => Promise<LifecycleStatus>;
  routeCommand?: typeof routeExomemCommand;
  takeRateLimit?: typeof takeExomemRateLimit;
  baseUrl?: string;
  telemetry?: (event: OperationalEvent) => void;
  telemetryKey?: Buffer;
  bodyTimeoutMs?: number;
};

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function opaqueMcpIdentifier(value: string, key: Buffer): string {
  return createHmac("sha256", key).update("exomem-mcp-telemetry:v1\0").update(value).digest("hex");
}

function mcpByteBucket(size: number): string {
  return size <= 1024 ? "le_1k" : size <= 65_536 ? "le_64k" : "gt_64k";
}

function emitMcpTelemetry(
  dependencies: McpDependencies,
  request: Request,
  input: McpTelemetryInput
): void {
  if (!dependencies.telemetry) return;
  try {
    const key = dependencies.telemetryKey ?? controlPlaneKeyFromEnv();
    dependencies.telemetry(
      buildOperationalEvent({
        event: "mcp.request",
        outcome: input.outcome,
        requestClass: input.requestClass ?? (input.tool ? "tool" : "request"),
        ...(input.tool ? { toolClass: input.tool.readOnly ? "read" : "write" } : {}),
        ...(input.requestBytes === undefined
          ? {}
          : { byteBucket: mcpByteBucket(input.requestBytes) }),
        ...(input.responseBytes === undefined
          ? {}
          : { responseByteBucket: mcpByteBucket(input.responseBytes) }),
        ...(input.startedAt
          ? { durationBucket: Date.now() - input.startedAt < 1000 ? "lt_1s" : "ge_1s" }
          : {}),
        retryBucket: input.retryBucket ?? "none",
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.access
          ? {
              clientHash: opaqueMcpIdentifier(input.access.clientId, key),
              cohortHash: opaqueMcpIdentifier("hosted-alpha-agent-v1", key),
              tenantHash: opaqueMcpIdentifier(input.access.tenantId, key),
              tokenFamilyHash: opaqueMcpIdentifier(input.access.familyId, key),
            }
          : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      })
    );
  } catch {
    // Telemetry is observability-only and cannot change an MCP result.
  }
}

function mediaType(value: string | null): string | null {
  const [type] = value?.split(";", 1) ?? [];
  return type?.trim().toLowerCase() || null;
}

function acceptsMediaType(value: string | null, expected: string): boolean {
  return Boolean(
    value
      ?.split(",")
      .map((entry) => entry.trim().split(";"))
      .some(([type, ...parameters]) => {
        const excluded = parameters.some((parameter) =>
          /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter)
        );
        return type.trim().toLowerCase() === expected && !excluded;
      })
  );
}

function mcpPostMediaStatus(request: Request): 406 | 415 | null {
  if (mediaType(request.headers.get("content-type")) !== "application/json") return 415;
  const accept = request.headers.get("accept");
  return acceptsMediaType(accept, "application/json") &&
    acceptsMediaType(accept, "text/event-stream")
    ? null
    : 406;
}

async function responseByteLength(response: Response): Promise<number> {
  return (await response.clone().arrayBuffer()).byteLength;
}

async function awaitMcpBound<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw exomemErrors.cellUnavailable();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(exomemErrors.cellUnavailable());
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const TOOL_SELECTOR_FIELDS = new Set([
  "tenant",
  "tenant_id",
  "account",
  "account_id",
  "user",
  "user_id",
  "resource",
  "public_subject",
  "cell",
  "cell_id",
  "endpoint",
  "internal_endpoint",
  "private_address",
  "auth",
  "authorization",
  "session",
  "session_id",
  "vault",
  "vault_path",
  "vault_root",
  "storage_root",
  "path",
  "principal",
  "scope",
  "protocol",
  "protocol_version",
  "version",
  "service_credential",
  "request",
  "request_id",
  "idempotency",
  "idempotency_scope",
  "retry",
  "retry_scope",
  "profile_id",
  "profile",
]);

function normalizedField(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

function boundedJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
      throw exomemErrors.invalidRequest();
    if (Array.isArray(current.value)) {
      for (const nested of current.value) pending.push({ value: nested, depth: current.depth + 1 });
    } else {
      const candidate = object(current.value);
      if (candidate)
        for (const nested of Object.values(candidate))
          pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
}

/** Canonical JSON makes a JSON-RPC retry bind to the same logical mutation. */
export function canonicalMcpArguments(value: unknown): string {
  boundedJson(value);
  const root = Array.isArray(value) ? [] : object(value) ? {} : value;
  const pending: Array<{ source: unknown; target: unknown }> = [{ source: value, target: root }];
  while (pending.length) {
    const { source, target } = pending.pop()!;
    if (Array.isArray(source) && Array.isArray(target)) {
      source.forEach((nested, index) => {
        const child = Array.isArray(nested) ? [] : object(nested) ? {} : nested;
        target[index] = child;
        if (typeof child === "object" && child !== null)
          pending.push({ source: nested, target: child });
      });
    } else {
      const sourceRecord = object(source);
      const targetRecord = object(target);
      if (!sourceRecord || !targetRecord) continue;
      for (const key of Object.keys(sourceRecord).sort()) {
        const nested = sourceRecord[key];
        const child = Array.isArray(nested) ? [] : object(nested) ? {} : nested;
        targetRecord[key] = child;
        if (typeof child === "object" && child !== null)
          pending.push({ source: nested, target: child });
      }
    }
  }
  return JSON.stringify(root);
}

export function hasMcpSelector(
  value: unknown,
  allowTopLevelProfile = false,
  allowedTopLevelFields = new Set<string>()
): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (Array.isArray(current.value)) {
      for (const nested of current.value) pending.push({ value: nested, depth: current.depth + 1 });
    } else {
      const candidate = object(current.value);
      if (!candidate) continue;
      for (const [key, nested] of Object.entries(candidate)) {
        const normalized = normalizedField(key);
        if (
          TOOL_SELECTOR_FIELDS.has(normalized) &&
          !(
            current.depth === 0 &&
            (allowedTopLevelFields.has(normalized) ||
              (allowTopLevelProfile && normalized === "profile"))
          )
        )
          return true;
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

export function mcpProtocolSupported(
  value: string | null,
  supported: readonly string[] | undefined
): boolean {
  return value !== null && Boolean(supported?.includes(value));
}

function importedTools(contract: LiveExomemAgentContract): Map<string, LiveTool> {
  const compatibility = object(contract.contract);
  const agent = compatibility && object(compatibility.agent_contract);
  const commands = agent && Array.isArray(agent.commands) ? agent.commands : null;
  if (!commands) throw exomemErrors.protocolMismatch();
  const tools = new Map<string, LiveTool>();
  const validator = new AjvJsonSchemaValidator();
  for (const raw of commands) {
    const command = object(raw);
    const rawTool = command && object(command.mcp_tool);
    const readOnly = command?.read_only;
    const name = command?.name;
    const params = Array.isArray(command?.params)
      ? command.params.map((parameter) => {
          const value = object(parameter);
          if (
            !value ||
            typeof value.name !== "string" ||
            typeof value.type !== "string" ||
            typeof value.required !== "boolean"
          ) {
            throw exomemErrors.protocolMismatch();
          }
          return { name: value.name, type: value.type, required: value.required };
        })
      : null;
    const parsed = ToolSchema.safeParse(rawTool);
    const inputSchema = rawTool && object(rawTool.inputSchema);
    const outputSchema = rawTool && object(rawTool.outputSchema);
    if (
      !command ||
      !params ||
      typeof name !== "string" ||
      typeof readOnly !== "boolean" ||
      !parsed.success ||
      parsed.data.name !== name ||
      !inputSchema ||
      !outputSchema ||
      tools.has(name)
    ) {
      throw exomemErrors.protocolMismatch();
    }
    tools.set(name, {
      tool: rawTool,
      readOnly,
      inputSchema,
      outputSchema,
      command: {
        name,
        params,
        read_only: readOnly,
        mode: readOnly ? "read" : "write",
        tier: typeof command.tier === "number" ? command.tier : 0,
        capability: typeof command.capability === "string" ? command.capability : "core",
        guarded_fields: [],
      },
      inputValidator: validator.getValidator(inputSchema),
      outputValidator: validator.getValidator(outputSchema),
    });
  }
  if (
    tools.size === 0 ||
    !ListToolsResultSchema.safeParse({ tools: [...tools.values()].map(({ tool }) => tool) }).success
  )
    throw exomemErrors.protocolMismatch();
  return tools;
}

function requiredScope(readOnly: boolean): "exomem.read" | "exomem.write" {
  return readOnly ? "exomem.read" : "exomem.write";
}

function lifecycleError(status: LifecycleStatus): ExomemHostedError | null {
  if (status.state === "ready") return null;
  const messages: Record<
    string,
    {
      status: number;
      retryable: boolean;
      message: string;
      retryAfterMs?: number;
      remediation?: string;
    }
  > = {
    CAPACITY_UNAVAILABLE: {
      status: 503,
      retryable: true,
      message: "Hosted capacity is temporarily unavailable",
      retryAfterMs: 1_000,
      remediation: "retry_later",
    },
    EXOMEM_SUSPENDED: {
      status: 403,
      retryable: false,
      message: "Your Exomem is currently suspended",
      remediation: "contact_support",
    },
    EXOMEM_DELETED: {
      status: 410,
      retryable: false,
      message: "Your Exomem has been deleted",
      remediation: "contact_support",
    },
    DELETION_IN_PROGRESS: {
      status: 410,
      retryable: false,
      message: "Your Exomem deletion is in progress",
      remediation: "deletion_in_progress",
    },
    deletion_pending: {
      status: 410,
      retryable: false,
      message: "Your Exomem deletion is in progress",
      remediation: "deletion_in_progress",
    },
    CELL_PREPARING: {
      status: 503,
      retryable: true,
      message: "Your Exomem is still preparing",
      retryAfterMs: 1_000,
      remediation: "retry_later",
    },
    TENANT_PREPARING: {
      status: 503,
      retryable: true,
      message: "Your Exomem is still preparing",
      retryAfterMs: 1_000,
      remediation: "retry_later",
    },
  };
  const mapped = messages[status.code];
  if (mapped) return new ExomemHostedError({ code: status.code, ...mapped });
  if (status.state === "degraded") {
    return new ExomemHostedError({
      code: "EXOMEM_PROVISIONING_FAILED",
      status: 503,
      retryable: status.retryable,
      message: "Your Exomem could not be prepared",
      remediation: "contact_support",
    });
  }
  return new ExomemHostedError({
    code: "EXOMEM_NOT_READY",
    status: 503,
    retryable: status.retryable,
    message: "Your Exomem is not ready",
    retryAfterMs: status.retryable ? 1_000 : undefined,
    remediation: status.retryable ? "retry_later" : "contact_support",
  });
}

function toolFailure(
  error: unknown,
  requestId?: string
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  _meta?: Record<string, unknown>;
} {
  const safe = error instanceof ExomemHostedError ? error : exomemErrors.cellUnavailable();
  const meta = {
    code: safe.code,
    message: safe.message,
    ...(requestId ? { requestId } : {}),
    retryable: safe.retryable,
    ...(safe.retryAfterMs ? { retryAfterMs: safe.retryAfterMs } : {}),
    ...(safe.remediation ? { remediation: safe.remediation } : {}),
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: meta.code,
          message: meta.message,
          ...(meta.requestId ? { requestId: meta.requestId } : {}),
          retryable: meta.retryable,
          ...(meta.retryAfterMs ? { retryAfterMs: meta.retryAfterMs } : {}),
          ...(meta.remediation ? { remediation: meta.remediation } : {}),
        }),
      },
    ],
    isError: true,
    _meta: {
      exomem: meta,
    },
  };
}

async function boundedBody(
  request: Request,
  signal: AbortSignal
): Promise<{ value: unknown; bytes: number } | { error: ExomemHostedError; bytes?: number }> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_MCP_REQUEST_BYTES))
    return { error: exomemErrors.requestTooLarge() };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let interrupted = false;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            if (signal.aborted) {
              reject(exomemErrors.cellUnavailable());
              return;
            }
            const onAbort = () => reject(exomemErrors.cellUnavailable());
            signal.addEventListener("abort", onAbort, { once: true });
            void reader
              .read()
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", onAbort));
          }
        );
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MCP_REQUEST_BYTES) {
          await reader.cancel();
          return { error: exomemErrors.requestTooLarge(), bytes: total };
        }
        chunks.push(value);
      }
    } catch (error) {
      if (signal.aborted || error instanceof ExomemHostedError) {
        interrupted = true;
        return { error: exomemErrors.cellUnavailable(), bytes: total || undefined };
      }
      throw error;
    } finally {
      if (interrupted) {
        void reader.cancel().then(
          () => {
            try {
              reader.releaseLock();
            } catch {}
          },
          () => {
            try {
              reader.releaseLock();
            } catch {}
          }
        );
      } else {
        reader.releaseLock();
      }
    }
  }
  if (signal.aborted) return { error: exomemErrors.cellUnavailable(), bytes: total || undefined };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes: total };
  } catch {
    return { error: exomemErrors.invalidRequest(), bytes: total };
  }
}

function idempotencyKey(access: ActiveOAuthAccessToken, tool: string, args: JsonRecord): string {
  return createHash("sha256")
    .update("exomem-mcp-mutation:v1\0")
    .update(access.familyId)
    .update("\0")
    .update(access.userId)
    .update("\0")
    .update(access.tenantId)
    .update("\0")
    .update(tool)
    .update("\0")
    .update(canonicalMcpArguments(args))
    .digest("hex");
}

async function withConcurrency<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (activeMcpCalls >= MAX_MCP_CONCURRENCY) throw exomemErrors.rateLimited();
  const activeForIdentity = activeMcpCallsByTenantClient.get(key) ?? 0;
  if (activeForIdentity >= MAX_MCP_TENANT_CLIENT_CONCURRENCY) throw exomemErrors.rateLimited();
  activeMcpCalls += 1;
  activeMcpCallsByTenantClient.set(key, activeForIdentity + 1);
  try {
    return await operation();
  } finally {
    activeMcpCalls -= 1;
    const remaining = (activeMcpCallsByTenantClient.get(key) ?? 1) - 1;
    if (remaining <= 0) activeMcpCallsByTenantClient.delete(key);
    else activeMcpCallsByTenantClient.set(key, remaining);
  }
}

function unauthorized(baseUrl: string): Response {
  return Response.json(
    { _meta: mcpAuthenticateMeta(baseUrl) },
    {
      status: 401,
      headers: { "www-authenticate": bearerChallenge(baseUrl), "cache-control": "no-store" },
    }
  );
}

function exactWebOrigin(value: string): string | null {
  try {
    const origin = new URL(value);
    if ((origin.protocol !== "https:" && origin.protocol !== "http:") || value !== origin.origin) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

function mcpOriginAllowed(origin: string | null, baseUrl: string): boolean {
  if (origin === null) return true;
  const exact = exactWebOrigin(origin);
  if (!exact) return false;
  if (exact === baseUrl) return true;
  const configured = process.env.EXOMEM_MCP_ALLOWED_ORIGINS;
  if (!configured) return false;
  const allowed = configured.split(",").map(exactWebOrigin);
  return allowed.every((candidate) => candidate !== null) && allowed.includes(exact);
}

function originRejected(): Response {
  return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
}

/** A stateless, OAuth-bound MCP resource. Authentication material never enters the SDK or private cell. */
export async function handleHostedMcpRequest(
  request: Request,
  dependencies: McpDependencies = {}
): Promise<Response> {
  const baseUrl = dependencies.baseUrl ?? exomemPublicBaseUrlFromEnv();
  if (!mcpOriginAllowed(request.headers.get("origin"), baseUrl)) return originRejected();
  if (
    hasForbiddenGatewayHeaders(request.headers) ||
    hasMcpSelector(Object.fromEntries(new URL(request.url).searchParams))
  ) {
    emitMcpTelemetry(dependencies, request, {
      outcome: "denied",
      errorCode: "HOSTED_SELECTOR_REJECTED",
    });
    return Response.json({ error: "HOSTED_SELECTOR_REJECTED" }, { status: 400 });
  }
  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  if (!bearer) {
    emitMcpTelemetry(dependencies, request, {
      outcome: "denied",
      errorCode: "ACCESS_TOKEN_INVALID",
    });
    return unauthorized(baseUrl);
  }
  const take = dependencies.takeRateLimit ?? takeExomemRateLimit;
  const ip = clientAddressKey(request);
  if (ip && !(await take(EXOMEM_RATE_LIMITS.mcpIp, ip))) {
    emitMcpTelemetry(dependencies, request, { outcome: "denied", errorCode: "RATE_LIMITED" });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  const access = await (dependencies.findAccessToken ?? findMcpOAuthAccessToken)(
    digestSecret(bearer)
  );
  if (!access || access.resource !== EXOMEM_HOSTED_RESOURCE) {
    emitMcpTelemetry(dependencies, request, {
      outcome: "denied",
      errorCode: "ACCESS_TOKEN_INVALID",
    });
    return unauthorized(baseUrl);
  }
  const requestId = randomUUID();
  const emitAuthenticatedTelemetry = (
    input: Omit<McpTelemetryInput, "access" | "requestId">
  ): void =>
    emitMcpTelemetry(dependencies, request, {
      ...input,
      access,
      requestId,
    });
  const authenticatedDenial = async (
    errorCode: string,
    response: Response,
    requestBytes?: number
  ): Promise<Response> => {
    emitAuthenticatedTelemetry({
      outcome: "denied",
      errorCode,
      ...(requestBytes === undefined ? {} : { requestBytes }),
      responseBytes: await responseByteLength(response),
    });
    return response;
  };
  if (!(await take(EXOMEM_RATE_LIMITS.mcpIdentity, `${access.tenantId}:${access.clientId}`))) {
    return authenticatedDenial(
      "RATE_LIMITED",
      Response.json({ error: "RATE_LIMITED" }, { status: 429 })
    );
  }
  try {
    return await withConcurrency(`${access.tenantId}:${access.clientId}`, async () => {
      if (request.method === "GET" || request.method === "DELETE") {
        return authenticatedDenial(
          "INVALID_REQUEST",
          new Response(null, { status: 405, headers: { allow: "POST" } })
        );
      }
      if (request.method !== "POST") {
        return authenticatedDenial(
          "INVALID_REQUEST",
          new Response(null, { status: 405, headers: { allow: "POST" } })
        );
      }
      const mediaStatus = mcpPostMediaStatus(request);
      if (mediaStatus) {
        return authenticatedDenial(
          "INVALID_REQUEST",
          Response.json({ error: "INVALID_REQUEST" }, { status: mediaStatus })
        );
      }
      const live = await (dependencies.getLiveContract ?? getLiveExomemAgentContract)();
      if (
        !live ||
        live.profile !== EXOMEM_HOSTED_PROFILE ||
        live.endpoint !== EXOMEM_HOSTED_RESOURCE
      ) {
        return authenticatedDenial(
          "HOSTED_CONTRACT_UNAVAILABLE",
          Response.json({ error: "HOSTED_CONTRACT_UNAVAILABLE" }, { status: 503 })
        );
      }
      let body: unknown;
      let requestBytes: number;
      try {
        const bodyTimeoutMs =
          typeof dependencies.bodyTimeoutMs === "number" &&
          Number.isInteger(dependencies.bodyTimeoutMs) &&
          dependencies.bodyTimeoutMs > 0 &&
          dependencies.bodyTimeoutMs <= MCP_BODY_TIMEOUT_MS
            ? dependencies.bodyTimeoutMs
            : MCP_BODY_TIMEOUT_MS;
        const parsed = await boundedBody(
          request,
          AbortSignal.any([request.signal, AbortSignal.timeout(bodyTimeoutMs)])
        );
        if ("error" in parsed)
          return authenticatedDenial(
            parsed.error.code,
            Response.json({ error: parsed.error.code }, { status: parsed.error.status }),
            parsed.bytes
          );
        body = parsed.value;
        requestBytes = parsed.bytes;
      } catch (error) {
        const safe = error instanceof ExomemHostedError ? error : exomemErrors.invalidRequest();
        return authenticatedDenial(
          safe.code,
          Response.json({ error: safe.code }, { status: safe.status })
        );
      }
      try {
        boundedJson(body);
      } catch (error) {
        const safe = error instanceof ExomemHostedError ? error : exomemErrors.invalidRequest();
        return authenticatedDenial(
          safe.code,
          Response.json({ error: safe.code }, { status: safe.status }),
          requestBytes
        );
      }
      if (Array.isArray(body)) {
        return authenticatedDenial(
          "INVALID_REQUEST",
          Response.json({ error: "INVALID_REQUEST" }, { status: 400 }),
          requestBytes
        );
      }
      const envelope = object(body);
      const rpcMethod = typeof envelope?.method === "string" ? envelope.method : null;
      if (envelope?.method === "initialize") {
        const params = object(envelope.params);
        if (
          !mcpProtocolSupported(
            typeof params?.protocolVersion === "string" ? params.protocolVersion : null,
            live.mcpProtocolVersions
          )
        ) {
          return authenticatedDenial(
            "MCP_PROTOCOL_UNSUPPORTED",
            Response.json({ error: "MCP_PROTOCOL_UNSUPPORTED" }, { status: 400 }),
            requestBytes
          );
        }
      } else if (
        !mcpProtocolSupported(request.headers.get("mcp-protocol-version"), live.mcpProtocolVersions)
      ) {
        return authenticatedDenial(
          "MCP_PROTOCOL_UNSUPPORTED",
          Response.json({ error: "MCP_PROTOCOL_UNSUPPORTED" }, { status: 400 }),
          requestBytes
        );
      }

      let tools: Map<string, LiveTool>;
      try {
        tools = importedTools(live);
      } catch (error) {
        const code =
          error instanceof ExomemHostedError ? error.code : "HOSTED_CONTRACT_UNAVAILABLE";
        return authenticatedDenial(
          code,
          Response.json(
            { error: error instanceof ExomemHostedError ? code : "HOSTED_CONTRACT_INCOMPATIBLE" },
            { status: 503 }
          ),
          requestBytes
        );
      }

      const server = new Server(
        { name: "Hosted Exomem", version: live.sourceRelease },
        { capabilities: { tools: {} } }
      );
      const toolTelemetry: { value: McpTelemetryInput | null } = { value: null };
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...tools.values()].map(({ tool, readOnly }) => ({
          ...tool,
          _meta: {
            ...(object(tool._meta) ?? {}),
            securitySchemes: [{ type: "oauth2", scopes: [requiredScope(readOnly)] }],
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (rpc, extra) => {
        const tool = tools.get(rpc.params.name);
        const args = rpc.params.arguments === undefined ? {} : object(rpc.params.arguments);
        const startedAt = Date.now();
        const telemetry = (
          outcome: "succeeded" | "failed" | "denied",
          errorCode?: string,
          retryBucket?: "none" | "retried"
        ) => {
          toolTelemetry.value = {
            outcome,
            errorCode,
            access,
            tool,
            startedAt,
            requestClass: "tool",
            requestBytes,
            retryBucket,
            requestId,
          };
        };
        if (!tool) {
          telemetry("denied", "COMMAND_NOT_FOUND");
          return toolFailure(exomemErrors.commandNotFound(), requestId);
        }
        if (!args) {
          telemetry("denied", "INVALID_REQUEST");
          return toolFailure(exomemErrors.invalidRequest(), requestId);
        }
        if (
          hasMcpSelector(
            args,
            rpc.params.name === "bootstrap",
            new Set(tool.command.params.map((parameter) => normalizedField(parameter.name)))
          )
        ) {
          telemetry("denied", "HOSTED_SELECTOR_REJECTED");
          return toolFailure(exomemErrors.selectorRejected(), requestId);
        }
        if (!access.scopes.includes(requiredScope(tool.readOnly))) {
          telemetry("denied", "EXOMEM_ENTITLEMENT_DENIED");
          return toolFailure(exomemErrors.entitlementDenied(), requestId);
        }
        try {
          if (extra.signal.aborted) throw exomemErrors.cellUnavailable();
          if (!tool.inputValidator(args).valid) throw exomemErrors.invalidRequest();
          const result = await (async () => {
            const signal = AbortSignal.any([
              request.signal,
              extra.signal,
              AbortSignal.timeout(10_000),
            ]);
            const status = await awaitMcpBound(
              (
                dependencies.statusForTenant ??
                ((tenantId: string) => new SqlLifecycleStore().statusForTenant(tenantId))
              )(access.tenantId),
              signal
            );
            const lifecycle = lifecycleError(status);
            if (lifecycle) {
              telemetry("failed", lifecycle.code);
              return toolFailure(
                lifecycle,
                typeof status.requestId === "string" &&
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    status.requestId
                  )
                  ? status.requestId
                  : requestId
              );
            }
            if (signal.aborted) throw exomemErrors.cellUnavailable();
            return awaitMcpBound(
              (dependencies.routeCommand ?? routeExomemCommand)({
                session: { userId: access.userId, tenantId: access.tenantId },
                commandName: rpc.params.name,
                args,
                command: tool.command,
                hostedContract: {
                  profile: live.profile,
                  sourceRelease: live.sourceRelease,
                  protocolVersion: live.protocolVersion,
                  commandFingerprint: live.commandFingerprint,
                  schemaDigest: live.schemaDigest,
                  compatibilityDigest: live.compatibilityDigest,
                },
                idempotencyKey: tool.readOnly
                  ? null
                  : idempotencyKey(access, rpc.params.name, args),
                requestId,
                dependencies: { signal },
              }),
              signal
            );
          })();
          if ("content" in result) return result;
          const envelope = object(result.body);
          if (envelope?.success === true) {
            if (!tool.outputValidator(envelope.data).valid)
              throw exomemErrors.cellResponseInvalid();
            telemetry(
              "succeeded",
              undefined,
              result.attempts && result.attempts > 1 ? "retried" : "none"
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(envelope.data ?? null) }],
              structuredContent: envelope.data as JsonRecord,
            };
          }
          if (envelope?.success === false && object(envelope.error)) {
            const error = object(envelope.error)!;
            const code =
              typeof error.code === "string" && Object.hasOwn(PRIVATE_ERROR_MESSAGES, error.code)
                ? error.code
                : "CELL_UNAVAILABLE";
            const retryAfterMs =
              typeof error.retryAfterMs === "number" &&
              Number.isInteger(error.retryAfterMs) &&
              error.retryAfterMs >= 1_000 &&
              error.retryAfterMs <= 300_000
                ? error.retryAfterMs
                : undefined;
            const remediation =
              typeof error.remediation === "string" && PRIVATE_REMEDIATIONS.has(error.remediation)
                ? error.remediation
                : undefined;
            telemetry("failed", code, result.attempts && result.attempts > 1 ? "retried" : "none");
            return toolFailure(
              new ExomemHostedError({
                code,
                status: result.status >= 400 ? result.status : 502,
                retryable: error.retryable === true,
                message: PRIVATE_ERROR_MESSAGES[code],
                retryAfterMs,
                remediation,
              }),
              requestId
            );
          }
          telemetry(
            "failed",
            "CELL_RESPONSE_INVALID",
            result.attempts && result.attempts > 1 ? "retried" : "none"
          );
          return toolFailure(exomemErrors.cellResponseInvalid(), requestId);
        } catch (error) {
          telemetry("failed", error instanceof ExomemHostedError ? error.code : "CELL_UNAVAILABLE");
          return toolFailure(error, requestId);
        }
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      if (toolTelemetry.value) {
        emitMcpTelemetry(dependencies, request, {
          ...toolTelemetry.value,
          responseBytes: await responseByteLength(response),
        });
      } else {
        const knownMethod =
          rpcMethod === "initialize" ||
          rpcMethod === "tools/list" ||
          rpcMethod?.startsWith("notifications/");
        emitAuthenticatedTelemetry({
          outcome: knownMethod && response.ok ? "succeeded" : "denied",
          ...(knownMethod && response.ok ? {} : { errorCode: "INVALID_REQUEST" }),
          requestBytes,
          responseBytes: await responseByteLength(response),
        });
      }
      await server.close();
      return response;
    });
  } catch (error) {
    if (error instanceof ExomemHostedError && error.code === "RATE_LIMITED") {
      return authenticatedDenial(
        error.code,
        Response.json({ error: error.code }, { status: error.status })
      );
    }
    throw error;
  }
}

export const mcpLimits = {
  requestBytes: MAX_MCP_REQUEST_BYTES,
  concurrency: MAX_MCP_CONCURRENCY,
} as const;
