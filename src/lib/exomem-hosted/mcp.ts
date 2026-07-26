import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
  hasReservedSelector,
  routeExomemCommand,
  type HostedContractCommand,
} from "./gateway";
import { SqlLifecycleStore } from "./lifecycle-store";
import { findActiveOAuthAccessToken, type ActiveOAuthAccessToken } from "./oauth-store";
import { bearerChallenge, mcpAuthenticateMeta, parseBearerAuthorization } from "./oauth";
import { exomemPublicBaseUrlFromEnv } from "./public-origin";
import { EXOMEM_RATE_LIMITS, clientAddressKey, takeExomemRateLimit } from "./rate-limit";
import { digestSecret } from "./security";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MCP_PROTOCOLS = new Set(["2025-11-25", "2025-06-18"]);
const MAX_MCP_CONCURRENCY = 16;
let activeMcpCalls = 0;

type JsonRecord = Record<string, unknown>;
type LiveTool = { tool: JsonRecord; readOnly: boolean; command: HostedContractCommand };
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

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  const candidate = object(value);
  if (!candidate) return value;
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(([, nested]) => nested !== null)
      .map(([key, nested]) => [key, clean(nested)])
  );
}

/** Canonical JSON makes a JSON-RPC retry bind to the same logical mutation. */
export function canonicalMcpArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMcpArguments).join(",")}]`;
  const candidate = object(value);
  if (!candidate) return JSON.stringify(value);
  return `{${Object.keys(candidate)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalMcpArguments(candidate[key])}`)
    .join(",")}}`;
}

export function hasMcpSelector(value: unknown): boolean {
  return hasReservedSelector(value);
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
    const parsed = ToolSchema.safeParse(clean(rawTool));
    if (
      !command ||
      !params ||
      typeof name !== "string" ||
      typeof readOnly !== "boolean" ||
      !parsed.success ||
      parsed.data.name !== name ||
      tools.has(name)
    ) {
      throw exomemErrors.protocolMismatch();
    }
    tools.set(name, {
      tool: parsed.data as unknown as JsonRecord,
      readOnly,
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
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_MCP_REQUEST_BYTES) throw exomemErrors.requestTooLarge();
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

async function withConcurrency<T>(operation: () => Promise<T>): Promise<T> {
  if (activeMcpCalls >= MAX_MCP_CONCURRENCY) throw exomemErrors.rateLimited();
  activeMcpCalls += 1;
  try {
    return await operation();
  } finally {
    activeMcpCalls -= 1;
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
  const access = await (dependencies.findAccessToken ?? findActiveOAuthAccessToken)(
    digestSecret(bearer)
  );
  if (!access || access.resource !== EXOMEM_HOSTED_RESOURCE) return unauthorized(baseUrl);
  if (!(await take(EXOMEM_RATE_LIMITS.mcpIdentity, `${access.familyId}:${access.clientId}`))) {
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
  if (hasMcpSelector(body))
    return Response.json({ error: "HOSTED_SELECTOR_REJECTED" }, { status: 400 });

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
    if (!tool || hasMcpSelector(args) || !access.scopes.includes(requiredScope(tool.readOnly)))
      return toolFailure(exomemErrors.entitlementDenied());
    try {
      if (extra.signal.aborted) throw exomemErrors.cellUnavailable();
      const status = await (
        dependencies.statusForTenant ??
        ((tenantId: string) => new SqlLifecycleStore().statusForTenant(tenantId))
      )(access.tenantId);
      const lifecycle = lifecycleError(status);
      if (lifecycle) throw lifecycle;
      const result = await withConcurrency(() =>
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
            : idempotencyKey(access, extra.requestId, rpc.params.name, args),
          requestId: randomUUID(),
        })
      );
      const envelope = object(result.body);
      if (envelope?.success === true)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope.data ?? null) }],
        };
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
