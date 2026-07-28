import { createHash } from "node:crypto";
import {
  InitializeResultSchema,
  JSONRPCResultResponseSchema,
  ListToolsResultSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exomemHostedContractFixture } from "../src/lib/exomem-hosted/agent-contract-fixture";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type RouteEvidence = {
  path: string;
  status: number;
  digest?: string;
};

const PUBLIC_PAGE_MARKERS: Record<string, readonly string[]> = {
  "/exomem": ["Hosted private alpha", "plaintext", "search"],
  "/exomem/privacy": ["controller", "Legal basis", "retention", "plaintext"],
  "/exomem/terms": ["Substrate Systems OÜ", "private alpha", "export", "deletion"],
  "/exomem/support": ["founder@substratesystems.io"],
  "/exomem/setup": ["sign in", "Custom instructions", "fallback"],
};
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_INITIALIZE_REQUEST_ID = 1;
const MCP_TOOLS_REQUEST_ID = 2;
const HOSTED_INITIALIZE_CAPABILITIES = { tools: {} };

export type MarketplacePreflightEvidence = {
  ok: true;
  origin: string;
  generatedAt: string;
  challengeDigest: string;
  routes: RouteEvidence[];
  authenticated?: {
    initializeStatus: number;
    toolNames: string[];
    toolContractDigest: string;
  };
};

export async function runMarketplacePreflight({
  origin,
  challenge,
  reviewerToken,
  timeoutMs = 10_000,
  fetch = globalThis.fetch,
}: {
  origin: string;
  challenge: string;
  reviewerToken?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}): Promise<MarketplacePreflightEvidence> {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("INVALID_ORIGIN");
  }

  const routes = [
    "/exomem",
    "/exomem/privacy",
    "/exomem/terms",
    "/exomem/support",
    "/exomem/setup",
    "/.well-known/oauth-protected-resource/api/exomem/mcp/v1",
    "/.well-known/oauth-authorization-server/api/exomem/oauth",
    "/.well-known/openai-apps-challenge",
  ];
  const evidence: RouteEvidence[] = [];

  for (const path of routes) {
    const response = await request(fetch, new URL(path, base).toString(), timeoutMs);
    if (response.status !== 200) throw new Error(`PUBLIC_ROUTE_STATUS:${path}:${response.status}`);
    const body = await response.text();
    verifyPublicContract(path, response, body, base.origin, challenge);
    evidence.push({ path, status: response.status, digest: digest(body) });
  }

  const mcpPath = "/api/exomem/mcp/v1";
  const mcpUrl = new URL(mcpPath, base).toString();
  const mcp = await request(fetch, mcpUrl, timeoutMs, { method: "POST" });
  const expectedChallenge = `Bearer resource_metadata="${base.origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`;
  if (mcp.status !== 401 || mcp.headers.get("www-authenticate") !== expectedChallenge) {
    throw new Error(`MCP_AUTH_CHALLENGE:${mcp.status}`);
  }
  evidence.push({ path: mcpPath, status: mcp.status });

  const attackerOrigin = await request(fetch, mcpUrl, timeoutMs, {
    method: "POST",
    headers: { origin: "https://attacker.invalid" },
  });
  if (attackerOrigin.status !== 403 || (await attackerOrigin.text()) !== "") {
    throw new Error(`MCP_ORIGIN_REJECTION:${attackerOrigin.status}`);
  }
  evidence.push({ path: `${mcpPath}#origin-rejection`, status: attackerOrigin.status });

  let authenticated: MarketplacePreflightEvidence["authenticated"];
  if (reviewerToken) {
    const headers = {
      authorization: `Bearer ${reviewerToken}`,
      accept: MCP_ACCEPT,
      "content-type": "application/json",
    };
    const initialize = await request(fetch, mcpUrl, timeoutMs, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: MCP_INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "exomem-marketplace-preflight", version: "1" },
        },
      }),
    });
    if (initialize.status !== 200) throw new Error(`MCP_INITIALIZE:${initialize.status}`);
    requireJsonResponse(initialize, "MCP_INITIALIZE_MEDIA_TYPE_INVALID");
    const initialized = normalizeInitializeResponse(
      (await initialize.json()) as unknown,
      MCP_INITIALIZE_REQUEST_ID
    );
    if (initialized.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error("MCP_INITIALIZE_PROTOCOL_MISMATCH");
    }
    const tools = await request(fetch, mcpUrl, timeoutMs, {
      method: "POST",
      headers: { ...headers, "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: MCP_TOOLS_REQUEST_ID,
        method: "tools/list",
        params: {},
      }),
    });
    if (tools.status !== 200) throw new Error(`MCP_TOOLS_LIST:${tools.status}`);
    requireJsonResponse(tools, "MCP_TOOLS_MEDIA_TYPE_INVALID");
    const toolContract = normalizeToolContract(
      (await tools.json()) as unknown,
      MCP_TOOLS_REQUEST_ID
    );
    authenticated = {
      initializeStatus: initialize.status,
      toolNames: toolContract.map((tool) => tool.name),
      toolContractDigest: digest(JSON.stringify(toolContract)),
    };
    evidence.push({
      path: `${mcpPath}#content-minimization`,
      status: tools.status,
      digest: authenticated.toolContractDigest,
    });
  }

  return {
    ok: true,
    origin: base.origin,
    generatedAt: new Date().toISOString(),
    challengeDigest: digest(challenge),
    routes: evidence,
    authenticated,
  };
}

async function request(fetch: FetchLike, url: string, timeoutMs: number, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`ROUTE_REQUEST_FAILURE:${new URL(url).pathname}`);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new Error(`UNEXPECTED_REDIRECT:${new URL(url).pathname}`);
  }
  return response;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyPublicContract(
  path: string,
  response: Response,
  body: string,
  origin: string,
  challenge: string
): void {
  const requiredMarkers = PUBLIC_PAGE_MARKERS[path];
  const normalizedBody = body.toLocaleLowerCase();
  if (
    requiredMarkers &&
    !requiredMarkers.every((marker) => normalizedBody.includes(marker.toLocaleLowerCase()))
  ) {
    throw new Error(`PUBLIC_PAGE_CONTRACT_MISMATCH:${path}`);
  }
  if (path === "/.well-known/openai-apps-challenge") {
    if (
      body !== challenge ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "text/plain" ||
      !/(?:^|,)\s*no-store(?:\s|,|$)/i.test(response.headers.get("cache-control") ?? "")
    ) {
      throw new Error("DOMAIN_CHALLENGE_RESPONSE_MISMATCH");
    }
    return;
  }
  if (path === "/.well-known/oauth-protected-resource/api/exomem/mcp/v1") {
    const metadata = parseMetadata(path, body);
    if (
      metadata.resource !== `${origin}/api/exomem/mcp/v1` ||
      !Array.isArray(metadata.authorization_servers) ||
      metadata.authorization_servers.length !== 1 ||
      metadata.authorization_servers[0] !== `${origin}/api/exomem/oauth` ||
      !exactStringArray(metadata.bearer_methods_supported, ["header"]) ||
      !exactStringArray(metadata.scopes_supported, ["exomem.read", "exomem.write"])
    ) {
      throw new Error("PROTECTED_RESOURCE_METADATA_MISMATCH");
    }
    return;
  }
  if (path === "/.well-known/oauth-authorization-server/api/exomem/oauth") {
    const metadata = parseMetadata(path, body);
    if (
      metadata.issuer !== `${origin}/api/exomem/oauth` ||
      metadata.authorization_endpoint !== `${origin}/api/exomem/oauth/authorize` ||
      metadata.token_endpoint !== `${origin}/api/exomem/oauth/token` ||
      metadata.revocation_endpoint !== `${origin}/api/exomem/oauth/revoke` ||
      !exactStringArray(metadata.response_types_supported, ["code"]) ||
      !exactStringArray(metadata.grant_types_supported, ["authorization_code", "refresh_token"]) ||
      !exactStringArray(metadata.code_challenge_methods_supported, ["S256"]) ||
      metadata.client_id_metadata_document_supported !== true ||
      !exactStringArray(metadata.token_endpoint_auth_methods_supported, ["none"]) ||
      !exactStringArray(metadata.scopes_supported, [
        "exomem.read",
        "exomem.write",
        "offline_access",
      ])
    ) {
      throw new Error("AUTHORIZATION_SERVER_METADATA_MISMATCH");
    }
  }
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

type CertifiedToolDescriptor = Record<string, unknown> & { name: string };

const expectedToolContract: CertifiedToolDescriptor[] =
  exomemHostedContractFixture.compatibility.agent_contract.commands
    .map((command) => {
      const securitySchemes =
        exomemHostedContractFixture.compatibility.oauth_discovery.tools[command.mcp_tool.name]
          .securitySchemes;
      return normalizeJson({
        ...command.mcp_tool,
        _meta: {
          ...command.mcp_tool._meta,
          securitySchemes,
        },
      }) as CertifiedToolDescriptor;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

function normalizeInitializeResponse(payload: unknown, requestId: number): Record<string, unknown> {
  const envelope = JSONRPCResultResponseSchema.safeParse(payload);
  if (!envelope.success) throw new Error("MCP_INITIALIZE_ENVELOPE_INVALID");
  if (envelope.data.id !== requestId) throw new Error("MCP_INITIALIZE_RESPONSE_ID_MISMATCH");
  const root = record(payload);
  const result = record(root?.result);
  if (!result) throw new Error("MCP_INITIALIZE_ENVELOPE_INVALID");
  const initialized = InitializeResultSchema.safeParse(result);
  if (!initialized.success) throw new Error("MCP_INITIALIZE_CONTRACT_INVALID");
  const capabilities = record(result.capabilities);
  if (!record(capabilities?.tools)) {
    throw new Error("MCP_INITIALIZE_TOOLS_CAPABILITY_MISSING");
  }
  if (
    JSON.stringify(normalizeJson(capabilities)) !== JSON.stringify(HOSTED_INITIALIZE_CAPABILITIES)
  ) {
    throw new Error("MCP_INITIALIZE_CAPABILITIES_MISMATCH");
  }
  const serverInfo = record(result.serverInfo);
  if (
    serverInfo?.name !== "Hosted Exomem" ||
    serverInfo.version !== exomemHostedContractFixture.sourceRelease
  ) {
    throw new Error("MCP_INITIALIZE_IDENTITY_MISMATCH");
  }
  return result;
}

function normalizeToolContract(payload: unknown, requestId: number): CertifiedToolDescriptor[] {
  const envelope = JSONRPCResultResponseSchema.safeParse(payload);
  if (!envelope.success) throw new Error("MCP_TOOLS_ENVELOPE_INVALID");
  if (envelope.data.id !== requestId) throw new Error("MCP_TOOLS_RESPONSE_ID_MISMATCH");
  const root = record(payload);
  const result = record(root?.result);
  if (!result || !ListToolsResultSchema.safeParse(result).success) {
    throw new Error("MCP_TOOLS_CONTRACT_INVALID");
  }
  if (Object.hasOwn(result, "nextCursor")) {
    throw new Error("MCP_TOOLS_PAGINATION_UNSUPPORTED");
  }
  const tools = result.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("MCP_TOOLS_CONTRACT_INVALID");
  }
  const names = new Set<string>();
  const normalized = tools.map((tool) => {
    const candidate = record(tool);
    if (
      !candidate ||
      !ToolSchema.safeParse(candidate).success ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      names.has(candidate.name)
    ) {
      throw new Error("MCP_TOOLS_CONTRACT_INVALID");
    }
    names.add(candidate.name);
    return normalizeJson(candidate) as CertifiedToolDescriptor;
  });
  const ordered = normalized.sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(ordered) !== JSON.stringify(expectedToolContract)) {
    throw new Error("MCP_TOOLS_CONTRACT_MISMATCH");
  }
  return ordered;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireJsonResponse(response: Response, errorCode: string): void {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new Error(errorCode);
  }
}

function normalizeJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  const candidate = record(value);
  if (!candidate) return null;
  return Object.fromEntries(
    Object.keys(candidate)
      .sort()
      .map((key) => [key, normalizeJson(candidate[key])])
  );
}

function parseMetadata(path: string, body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`METADATA_PARSE_FAILURE:${path}`);
  }
}

if (process.argv[1]?.endsWith("exomem-marketplace-preflight.ts")) {
  const origin = process.env.EXOMEM_PUBLIC_BASE_URL;
  const challenge = process.env.OPENAI_APPS_CHALLENGE;
  if (!origin || !challenge)
    throw new Error("EXOMEM_PUBLIC_BASE_URL and OPENAI_APPS_CHALLENGE are required");
  runMarketplacePreflight({
    origin,
    challenge,
    reviewerToken: process.env.EXOMEM_MARKETPLACE_REVIEWER_TOKEN,
  }).then((evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`));
}
