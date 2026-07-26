import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
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
import { EXOMEM_RATE_LIMITS, clientAddressKey, takeExomemRateLimit } from "./rate-limit";
import { digestSecret } from "./security";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MCP_PROTOCOLS = new Set(["2025-11-25", "2025-06-18"]);
const MAX_MCP_CONCURRENCY = 16;
let activeMcpCalls = 0;
const activeMcpCallsByTenantClient = new Map<string, number>();
const MAX_MCP_TENANT_CLIENT_CONCURRENCY = 4;

type JsonRecord = Record<string, unknown>;
type LiveTool = {
  tool: JsonRecord;
  readOnly: boolean;
  command: HostedContractCommand;
  inputSchema: JsonRecord;
  outputSchema: JsonRecord;
};
type LifecycleStatus = { state: string; code: string; retryable: boolean };

export type McpDependencies = {
  findAccessToken?: (digest: Buffer) => Promise<ActiveOAuthAccessToken | null>;
  getLiveContract?: () => Promise<LiveExomemAgentContract | null>;
  statusForTenant?: (tenantId: string) => Promise<LifecycleStatus>;
  routeCommand?: typeof routeExomemCommand;
  takeRateLimit?: typeof takeExomemRateLimit;
  baseUrl?: string;
};

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const TOOL_SELECTOR_FIELDS = new Set([
  "tenant",
  "tenant_id",
  "cell",
  "cell_id",
  "endpoint",
  "internal_endpoint",
  "auth",
  "authorization",
  "session",
  "session_id",
  "vault",
  "vault_path",
  "principal",
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

export function hasMcpSelector(value: unknown, allowTopLevelProfile = false): boolean {
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
          !(allowTopLevelProfile && current.depth === 0 && normalized === "profile")
        )
          return true;
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

export function mcpProtocolSupported(value: string | null): boolean {
  return value !== null && MCP_PROTOCOLS.has(value);
}

function importedTools(contract: LiveExomemAgentContract): Map<string, LiveTool> {
  const compatibility = object(contract.contract);
  const agent = compatibility && object(compatibility.agent_contract);
  const commands = agent && Array.isArray(agent.commands) ? agent.commands : null;
  if (!commands) throw exomemErrors.protocolMismatch();
  const tools = new Map<string, LiveTool>();
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
    // SDK validation is applied to a validation copy only: discovery returns the exact imported tool,
    // including explicit null/default values used by native clients.
    const validationTool = rawTool && {
      ...rawTool,
      execution: rawTool.execution ?? undefined,
      icons: rawTool.icons ?? undefined,
    };
    const parsed = ToolSchema.safeParse(validationTool);
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
    });
  }
  if (tools.size === 0) throw exomemErrors.protocolMismatch();
  return tools;
}

function requiredScope(readOnly: boolean): "exomem.read" | "exomem.write" {
  return readOnly ? "exomem.read" : "exomem.write";
}

function lifecycleError(status: LifecycleStatus): ExomemHostedError | null {
  if (status.state === "ready") return null;
  const messages: Record<string, { status: number; retryable: boolean; message: string }> = {
    CAPACITY_UNAVAILABLE: {
      status: 503,
      retryable: true,
      message: "Hosted capacity is temporarily unavailable",
    },
    EXOMEM_SUSPENDED: {
      status: 403,
      retryable: false,
      message: "Your Exomem is currently suspended",
    },
    EXOMEM_DELETED: { status: 410, retryable: false, message: "Your Exomem has been deleted" },
    CELL_PREPARING: { status: 503, retryable: true, message: "Your Exomem is still preparing" },
    TENANT_PREPARING: { status: 503, retryable: true, message: "Your Exomem is still preparing" },
  };
  const mapped = messages[status.code];
  if (mapped) return new ExomemHostedError({ code: status.code, ...mapped });
  if (status.state === "degraded") {
    return new ExomemHostedError({
      code: "EXOMEM_PROVISIONING_FAILED",
      status: 503,
      retryable: status.retryable,
      message: "Your Exomem could not be prepared",
    });
  }
  return new ExomemHostedError({
    code: "EXOMEM_NOT_READY",
    status: 503,
    retryable: status.retryable,
    message: "Your Exomem is not ready",
  });
}

function toolFailure(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const safe = error instanceof ExomemHostedError ? error : exomemErrors.cellUnavailable();
  return { content: [{ type: "text", text: `${safe.code}: ${safe.message}` }], isError: true };
}

async function boundedBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_MCP_REQUEST_BYTES))
    throw exomemErrors.requestTooLarge();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MCP_REQUEST_BYTES) {
          await reader.cancel();
          throw exomemErrors.requestTooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw exomemErrors.invalidRequest();
  }
}

function idempotencyKey(
  access: ActiveOAuthAccessToken,
  id: unknown,
  tool: string,
  args: JsonRecord
): string {
  return createHash("sha256")
    .update("exomem-mcp-mutation:v1\0")
    .update(access.familyId)
    .update("\0")
    .update(access.userId)
    .update("\0")
    .update(access.tenantId)
    .update("\0")
    .update(String(id ?? ""))
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
    if (activeForIdentity === 0) activeMcpCallsByTenantClient.delete(key);
    else activeMcpCallsByTenantClient.set(key, activeForIdentity);
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

/** A stateless, OAuth-bound MCP resource. Authentication material never enters the SDK or private cell. */
export async function handleHostedMcpRequest(
  request: Request,
  dependencies: McpDependencies = {}
): Promise<Response> {
  const baseUrl = dependencies.baseUrl ?? exomemPublicBaseUrlFromEnv();
  const take = dependencies.takeRateLimit ?? takeExomemRateLimit;
  const ip = clientAddressKey(request);
  if (ip && !(await take(EXOMEM_RATE_LIMITS.mcpIp, ip)))
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  if (
    hasForbiddenGatewayHeaders(request.headers) ||
    hasMcpSelector(Object.fromEntries(new URL(request.url).searchParams))
  ) {
    return Response.json({ error: "HOSTED_SELECTOR_REJECTED" }, { status: 400 });
  }
  const bearer = parseBearerAuthorization(request.headers.get("authorization"));
  if (!bearer) return unauthorized(baseUrl);
  const access = await (dependencies.findAccessToken ?? findMcpOAuthAccessToken)(
    digestSecret(bearer)
  );
  if (!access || access.resource !== EXOMEM_HOSTED_RESOURCE) return unauthorized(baseUrl);
  if (!(await take(EXOMEM_RATE_LIMITS.mcpIdentity, `${access.tenantId}:${access.clientId}`))) {
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  if (request.method === "GET" || request.method === "DELETE")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const protocol = request.headers.get("mcp-protocol-version");
  if (protocol && !mcpProtocolSupported(protocol))
    return Response.json({ error: "MCP_PROTOCOL_UNSUPPORTED" }, { status: 400 });
  let body: unknown;
  try {
    body = await boundedBody(request);
  } catch (error) {
    const safe = error instanceof ExomemHostedError ? error : exomemErrors.invalidRequest();
    return Response.json({ error: safe.code }, { status: safe.status });
  }
  try {
    boundedJson(body);
  } catch (error) {
    const safe = error instanceof ExomemHostedError ? error : exomemErrors.invalidRequest();
    return Response.json({ error: safe.code }, { status: safe.status });
  }
  const envelope = object(body);
  if (envelope?.method === "initialize") {
    const params = object(envelope.params);
    if (
      !mcpProtocolSupported(
        typeof params?.protocolVersion === "string" ? params.protocolVersion : null
      )
    ) {
      return Response.json({ error: "MCP_PROTOCOL_UNSUPPORTED" }, { status: 400 });
    }
  }

  const live = await (dependencies.getLiveContract ?? getLiveExomemAgentContract)();
  if (!live || live.profile !== EXOMEM_HOSTED_PROFILE || live.endpoint !== EXOMEM_HOSTED_RESOURCE) {
    return Response.json({ error: "HOSTED_CONTRACT_UNAVAILABLE" }, { status: 503 });
  }
  let tools: Map<string, LiveTool>;
  try {
    tools = importedTools(live);
  } catch (error) {
    return Response.json(
      { error: error instanceof ExomemHostedError ? error.code : "HOSTED_CONTRACT_INCOMPATIBLE" },
      { status: 503 }
    );
  }

  const server = new Server(
    { name: "Hosted Exomem", version: live.sourceRelease },
    { capabilities: { tools: {} } }
  );
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
    const args = object(rpc.params.arguments) ?? {};
    if (
      !tool ||
      hasMcpSelector(args, rpc.params.name === "bootstrap") ||
      !access.scopes.includes(requiredScope(tool.readOnly))
    )
      return toolFailure(exomemErrors.entitlementDenied());
    try {
      if (extra.signal.aborted) throw exomemErrors.cellUnavailable();
      const inputValidator = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      if (!inputValidator(args).valid) throw exomemErrors.invalidRequest();
      const result = await withConcurrency(`${access.tenantId}:${access.clientId}`, async () => {
        const status = await (
          dependencies.statusForTenant ??
          ((tenantId: string) => new SqlLifecycleStore().statusForTenant(tenantId))
        )(access.tenantId);
        const lifecycle = lifecycleError(status);
        if (lifecycle) throw lifecycle;
        if (extra.signal.aborted) throw exomemErrors.cellUnavailable();
        return (dependencies.routeCommand ?? routeExomemCommand)({
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
            : idempotencyKey(access, extra.requestId, rpc.params.name, args),
          requestId: randomUUID(),
        });
      });
      const envelope = object(result.body);
      if (envelope?.success === true) {
        const outputValidator = new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
        if (!outputValidator(envelope.data).valid) throw exomemErrors.cellResponseInvalid();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope.data ?? null) }],
          structuredContent: envelope.data as JsonRecord,
        };
      }
      if (envelope?.success === false && object(envelope.error)) {
        const error = object(envelope.error)!;
        const code =
          typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : "CELL_UNAVAILABLE";
        return toolFailure(
          new ExomemHostedError({
            code,
            status: result.status >= 400 ? result.status : 502,
            retryable: error.retryable === true,
            message:
              typeof error.message === "string"
                ? error.message.slice(0, 256)
                : "the Exomem action could not be completed",
          })
        );
      }
      return toolFailure(exomemErrors.cellResponseInvalid());
    } catch (error) {
      return toolFailure(error);
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request, { parsedBody: body });
  await server.close();
  return response;
}

export const mcpLimits = {
  requestBytes: MAX_MCP_REQUEST_BYTES,
  concurrency: MAX_MCP_CONCURRENCY,
} as const;
