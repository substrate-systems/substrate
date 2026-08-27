import { createHash, randomUUID } from "node:crypto";
import {
  cloudflareAccessConfigFromEnv,
  cloudflareAccessHeaders,
  type CloudflareAccessConfig,
} from "./cloudflare-access";
import { resolveGatewayTarget, type GatewayTarget } from "./db";
import { exomemErrors } from "./errors";
import { exomemHostedContractFixture as agentFixture0340 } from "./agent-contract-fixture-0-34-0";
import { exomemHostedContractFixture as agentFixture0350 } from "./agent-contract-fixture-0-35-0";
import { exomemHostedContractFixture as agentFixture0392 } from "./agent-contract-fixture-0-39-2";
import { exomemHostedContractFixture as agentFixture0490 } from "./agent-contract-fixture-0-49-0";
import { exomemHostedContractFixture as agentFixture0631 } from "./agent-contract-fixture";
import { exomemHostedContractFixture as agentFixture0572 } from "./agent-contract-fixture-0-57-2";
import { exomemHostedContractFixture as agentFixture0500 } from "./agent-contract-fixture-0-50-0";
import { exomemHostedContractFixture as agentFixture0541 } from "./agent-contract-fixture-0-54-1";
import { exomemContractFixture0340 } from "./gateway-contract-0-34-0";
import { exomemContractFixture0350 } from "./gateway-contract-0-35-0";
import { exomemContractFixture0392 } from "./gateway-contract-0-39-2";
import { exomemContractFixture0490 } from "./gateway-contract-0-49-0";
import { exomemContractFixture0500 } from "./gateway-contract-0-50-0";
import { exomemContractFixture0541 } from "./gateway-contract-0-54-1";
import { exomemContractFixture0572 } from "./gateway-contract-0-57-2";
import { exomemContractFixture0631 } from "./gateway-contract-0-63-1";
import {
  decryptSecret,
  opaquePrincipalScope,
  type SecretEnvelope,
  type SensitiveSecret,
} from "./security";

const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_CELL_RESPONSE_BYTES = 4 * 1024 * 1024;
const CONTRACT_TTL_MS = 60_000;
const MAX_CONTRACT_CACHE_ENTRIES = 256;
const PRIVATE_TIMEOUT_MS = 10_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMAND_NAME = /^[a-z][a-z0-9_]{0,63}$/;

class CellResponseBodyReadError extends Error {}

function privateDeadlineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function awaitPrivateBound<T>(
  value: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) throw exomemErrors.cellUnavailable();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(exomemErrors.cellUnavailable());
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const RESERVED_FIELDS = new Set([
  "tenant",
  "tenant_id",
  "tenant_scope",
  "account",
  "account_id",
  "user",
  "user_id",
  "resource",
  "cell",
  "cell_id",
  "cell_endpoint",
  "vault",
  "vault_path",
  "vault_root",
  "path",
  "principal",
  "principal_scope",
  "request_id",
  "request",
  "protocol",
  "protocol_version",
  "service_credential",
  "internal_endpoint",
  "endpoint",
  "private_address",
  "public_subject",
  "storage_root",
  "subject",
  "idempotency_scope",
  "idempotency",
  "retry_scope",
  "retry",
  "profile",
  "profile_id",
  "auth",
  "authorization",
  "session",
  "session_id",
  "candidate",
  "candidate_id",
  "assignment",
  "assignment_id",
  "assignment_generation",
  "generation",
  "stage",
  "stage_id",
  "staged_client_release",
  "staged_client_release_id",
  "artifact",
  "artifact_id",
  "artifact_sha256",
  "release",
  "release_version",
  "schema",
  "schema_digest",
  "compatibility",
  "compatibility_digest",
  "gateway_contract_digest",
  "source_release",
  "bound_cell_id",
  "target_candidate_id",
  "contract_digest",
  "command_fingerprint",
]);

const INTERCEPTED_COMMANDS = new Set(["transfer_artifact", "adopt_vault"]);
const PUBLIC_MCP_HEADER_EXCEPTIONS = new Set(["authorization", "cookie"]);
const RELEASE_SELECTOR_FIELDS = new Set([
  "candidate",
  "candidate_id",
  "assignment",
  "assignment_id",
  "assignment_generation",
  "generation",
  "stage",
  "stage_id",
  "staged_client_release",
  "staged_client_release_id",
  "artifact",
  "artifact_id",
  "artifact_sha256",
  "release",
  "release_version",
  "protocol",
  "protocol_version",
  "schema",
  "schema_digest",
  "compatibility",
  "compatibility_digest",
  "gateway_contract_digest",
  "source_release",
  "bound_cell_id",
  "target_candidate_id",
  "contract_digest",
  "command_fingerprint",
]);

export function normalizeIdempotencyKey(value: string | null | undefined): string {
  const key = value?.trim() ?? "";
  if (!key) throw exomemErrors.idempotencyRequired();
  if (!IDEMPOTENCY_KEY.test(key)) throw exomemErrors.invalidRequest();
  return key;
}

export type HostedContractParameter = {
  name: string;
  type: string;
  required: boolean;
};

export type HostedContractCommand = {
  name: string;
  params: HostedContractParameter[];
  read_only: boolean;
  mode: "read" | "write";
  tier: number;
  capability: string;
  guarded_fields: string[];
};

export type HostedContract = {
  schema_version: number;
  protocol_version: string;
  exomem_release: string;
  commands: HostedContractCommand[];
  digest: { algorithm: "sha256"; value: string };
};

export type ResolvedPrivateTarget = {
  row: GatewayTarget;
  endpoint: URL;
  credential: SensitiveSecret;
  principalScope: string;
};

export type GatewayResult = {
  status: number;
  body: Record<string, unknown>;
  requestId: string;
  attempts?: number;
};

export type GatewayDependencies = {
  resolveTarget?: typeof resolveGatewayTarget;
  fetch?: typeof fetch;
  expectedProtocol?: string;
  now?: () => number;
  decrypt?: typeof decryptSecret;
  principalScope?: typeof opaquePrincipalScope;
  access?: CloudflareAccessConfig | null;
  signal?: AbortSignal;
};

export type ExpectedHostedContract = {
  profile: string;
  sourceRelease: string;
  protocolVersion: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
};

type CachedContract = {
  contract: HostedContract;
  expiresAt: number;
};

const contractCache = new Map<string, CachedContract>();

export function clearContractCacheForTests(): void {
  contractCache.clear();
}

function normalizeField(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

export function hasReservedSelector(
  value: unknown,
  allowedTopLevelFields = new Set<string>(),
  depth = 0
): boolean {
  if (Array.isArray(value))
    return value.some((nested) => hasReservedSelector(nested, allowedTopLevelFields, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      (RESERVED_FIELDS.has(normalizeField(key)) &&
        !(depth === 0 && allowedTopLevelFields.has(normalizeField(key)))) ||
      hasReservedSelector(nested, allowedTopLevelFields, depth + 1)
  );
}

export function hasForbiddenGatewayHeaders(headers: Headers): boolean {
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    const selector = normalizeField(normalized);
    if (
      (normalized.startsWith("x-exomem-") && normalized !== "x-exomem-csrf") ||
      normalized.startsWith("x-tenant") ||
      normalized === "x-cell-id" ||
      normalized === "x-vault-path" ||
      normalized === "x-vault-root" ||
      normalized === "x-principal-scope" ||
      normalized === "x-protocol-version" ||
      normalized === "x-internal-endpoint" ||
      normalized === "cf-access-client-id" ||
      normalized === "cf-access-client-secret" ||
      (RESERVED_FIELDS.has(selector) && !PUBLIC_MCP_HEADER_EXCEPTIONS.has(selector)) ||
      (normalized === "cookie" &&
        value.split(";").some((cookie) => {
          const [name] = cookie.split("=", 1);
          return RELEASE_SELECTOR_FIELDS.has(normalizeField(name ?? ""));
        }))
    ) {
      return true;
    }
  }
  return false;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const gatewayContractCatalog = Object.freeze([
  Object.freeze({ full: exomemContractFixture0340, agent: agentFixture0340 }),
  Object.freeze({ full: exomemContractFixture0350, agent: agentFixture0350 }),
  Object.freeze({ full: exomemContractFixture0392, agent: agentFixture0392 }),
  Object.freeze({ full: exomemContractFixture0490, agent: agentFixture0490 }),
  Object.freeze({ full: exomemContractFixture0500, agent: agentFixture0500 }),
  Object.freeze({ full: exomemContractFixture0541, agent: agentFixture0541 }),
  Object.freeze({ full: exomemContractFixture0572, agent: agentFixture0572 }),
  Object.freeze({ full: exomemContractFixture0631, agent: agentFixture0631 }),
]);

function contractFixture(
  target: GatewayTarget,
  expected?: ExpectedHostedContract
): (typeof gatewayContractCatalog)[number]["full"] {
  const matches = gatewayContractCatalog.filter(
    ({ full, agent }) =>
      target.releaseVersion === full.release &&
      target.protocolVersion === full.protocol &&
      (!expected ||
        (expected.sourceRelease === full.release &&
          expected.protocolVersion === full.protocol &&
          agent.sourceRelease === full.release &&
          agent.compatibility.agent_contract.agent_profile.profile === expected.profile &&
          agent.compatibility.agent_contract.protocol_version === full.protocol &&
          agent.compatibility.command_surface_sha256 === expected.commandFingerprint &&
          agent.compatibility.schema_contract_sha256 === expected.schemaDigest &&
          agent.compatibility.compatibility_sha256 === expected.compatibilityDigest))
  );
  if (matches.length !== 1) throw exomemErrors.protocolMismatch();
  return matches[0]!.full;
}

function semanticProjection(commands: HostedContractCommand[]): unknown {
  return commands.map((command) => [
    command.name,
    command.read_only,
    command.mode,
    command.tier,
    command.capability,
    command.params.map((parameter) => [parameter.name, parameter.type, parameter.required]),
    command.guarded_fields,
  ]);
}

function parseContract(value: unknown, target: GatewayTarget): HostedContract {
  const candidate = safeJsonObject(value);
  if (!candidate) throw exomemErrors.cellResponseInvalid();
  const expected = contractFixture(target);
  const digest = safeJsonObject(candidate.digest);
  if (
    candidate.schema_version !== 1 ||
    candidate.protocol_version !== target.protocolVersion ||
    candidate.exomem_release !== target.releaseVersion ||
    digest?.algorithm !== "sha256" ||
    typeof digest.value !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest.value) ||
    !Array.isArray(candidate.commands)
  ) {
    throw exomemErrors.protocolMismatch();
  }

  const names = new Set<string>();
  const commands: HostedContractCommand[] = candidate.commands.map((raw) => {
    const command = safeJsonObject(raw);
    if (
      !command ||
      typeof command.name !== "string" ||
      !COMMAND_NAME.test(command.name) ||
      names.has(command.name) ||
      typeof command.read_only !== "boolean" ||
      (command.mode !== "read" && command.mode !== "write") ||
      command.read_only !== (command.mode === "read") ||
      !Number.isInteger(command.tier) ||
      typeof command.capability !== "string" ||
      !Array.isArray(command.params) ||
      !Array.isArray(command.guarded_fields)
    ) {
      throw exomemErrors.cellResponseInvalid();
    }
    names.add(command.name);
    const parameterNames = new Set<string>();
    const params = command.params.map((rawParameter) => {
      const parameter = safeJsonObject(rawParameter);
      if (
        !parameter ||
        typeof parameter.name !== "string" ||
        !COMMAND_NAME.test(parameter.name) ||
        parameterNames.has(parameter.name) ||
        typeof parameter.type !== "string" ||
        typeof parameter.required !== "boolean"
      ) {
        throw exomemErrors.cellResponseInvalid();
      }
      parameterNames.add(parameter.name);
      return {
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
      };
    });
    const guardedFields = command.guarded_fields;
    if (
      guardedFields.some((field) => typeof field !== "string" || !COMMAND_NAME.test(field)) ||
      new Set(guardedFields).size !== guardedFields.length
    ) {
      throw exomemErrors.cellResponseInvalid();
    }
    return {
      name: command.name,
      params,
      read_only: command.read_only,
      mode: command.mode,
      tier: Number(command.tier),
      capability: command.capability,
      guarded_fields: [...guardedFields],
    };
  });
  const unsigned = { ...candidate };
  delete unsigned.digest;
  const actual = createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex");
  if (actual !== digest.value) throw exomemErrors.cellResponseInvalid();
  if (
    digest.value !== expected.digest ||
    canonicalJson(semanticProjection(commands)) !== canonicalJson(expected.commands)
  ) {
    throw exomemErrors.protocolMismatch();
  }
  return {
    schema_version: 1,
    protocol_version: String(candidate.protocol_version),
    exomem_release: String(candidate.exomem_release),
    commands,
    digest: { algorithm: "sha256", value: digest.value },
  };
}

export function privateGatewayHeaders(
  target: ResolvedPrivateTarget,
  requestId: string,
  access: CloudflareAccessConfig | null = cloudflareAccessConfigFromEnv()
): Record<string, string> {
  return {
    ...cloudflareAccessHeaders(access),
    authorization: `Bearer ${target.credential.reveal()}`,
    "x-exomem-cell-id": target.row.cellId,
    "x-exomem-protocol-version": target.row.protocolVersion,
    "x-exomem-request-id": requestId,
    "x-exomem-principal-scope": target.principalScope,
  };
}

async function boundedJsonResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    cancelResponseBody(response);
    throw exomemErrors.cellResponseInvalid();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await readResponseChunk(reader, signal);
        } catch {
          void reader.cancel().catch(() => undefined);
          throw new CellResponseBodyReadError();
        }
        const { done, value } = chunk;
        if (done) break;
        if (totalBytes + value.byteLength > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw exomemErrors.cellResponseInvalid();
        }
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const object = safeJsonObject(parsed);
    if (!object) throw new Error("not an object");
    return object;
  } catch {
    throw exomemErrors.cellResponseInvalid();
  }
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw new CellResponseBodyReadError();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CellResponseBodyReadError());
    signal.addEventListener("abort", onAbort, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A retry never depends on draining or successfully canceling a cell
    // error body. The next attempt remains bounded by its own timeout.
  }
}

function validatePrivateEndpoint(secret: SensitiveSecret): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(secret.reveal());
  } catch {
    throw exomemErrors.cellUnavailable();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw exomemErrors.cellUnavailable();
  }
  return endpoint;
}

function assertRoutable(target: GatewayTarget, expectedProtocol: string): void {
  if (target.manuallySuspended || target.tenantStatus === "suspended") {
    throw exomemErrors.suspensionActive();
  }
  if (
    target.tenantStatus !== "active" ||
    target.tenantDesiredState !== "running" ||
    target.cellLifecycleState !== "active" ||
    target.cellRoutingState !== "bound"
  ) {
    throw exomemErrors.cellUnavailable();
  }
  if (target.protocolVersion !== expectedProtocol) {
    throw exomemErrors.protocolMismatch();
  }
  if (!target.credentialCiphertext || !target.endpointCiphertext) {
    throw exomemErrors.cellUnavailable();
  }
}

export async function resolveGatewayPrivateTarget(
  session: { userId: string; tenantId: string },
  dependencies: GatewayDependencies
): Promise<ResolvedPrivateTarget> {
  const target = await awaitPrivateBound(
    (dependencies.resolveTarget ?? resolveGatewayTarget)(session),
    dependencies.signal
  );
  if (!target) throw exomemErrors.cellMappingMissing();
  const expectedProtocol =
    dependencies.expectedProtocol ?? process.env.EXOMEM_CELL_PROTOCOL_VERSION;
  if (!expectedProtocol) throw exomemErrors.protocolMismatch();
  assertRoutable(target, expectedProtocol);
  const decrypt = dependencies.decrypt ?? decryptSecret;
  const credential = decrypt(target.credentialCiphertext as SecretEnvelope);
  const endpointSecret = decrypt(target.endpointCiphertext as SecretEnvelope);
  const endpoint = validatePrivateEndpoint(endpointSecret);
  const principalScope = (dependencies.principalScope ?? opaquePrincipalScope)({
    product: "exomem",
    userId: session.userId,
    tenantId: session.tenantId,
  });
  return { row: target, endpoint, credential, principalScope };
}

function cacheKey(target: GatewayTarget, digest: string): string {
  return `${target.cellId}:${target.protocolVersion}:${target.releaseVersion}:${digest}`;
}

async function fetchContract(
  target: ResolvedPrivateTarget,
  dependencies: GatewayDependencies,
  requestId: string
): Promise<HostedContract> {
  const now = (dependencies.now ?? Date.now)();
  contractFixture(target.row);
  const fetchImpl = dependencies.fetch ?? fetch;
  const url = new URL(
    "private/exomem/v1/contract",
    `${target.endpoint.toString().replace(/\/$/, "")}/`
  );
  let response: Response;
  const signal = privateDeadlineSignal(dependencies.signal, PRIVATE_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: privateGatewayHeaders(target, requestId, dependencies.access),
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    throw exomemErrors.cellUnavailable();
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw exomemErrors.cellUnavailable();
  }
  let contractBody: Record<string, unknown>;
  try {
    contractBody = await boundedJsonResponse(response, MAX_CELL_RESPONSE_BYTES, signal);
  } catch (error) {
    if (error instanceof CellResponseBodyReadError) throw exomemErrors.cellUnavailable();
    throw error;
  }
  const contract = parseContract(contractBody, target.row);
  const key = cacheKey(target.row, contract.digest.value);
  const cached = contractCache.get(key);
  if (cached && cached.expiresAt > now) return cached.contract;
  if (contractCache.size >= MAX_CONTRACT_CACHE_ENTRIES) {
    contractCache.delete(contractCache.keys().next().value as string);
  }
  contractCache.set(key, { contract, expiresAt: now + CONTRACT_TTL_MS });
  return contract;
}

// Code-point key order, matching Python's `json.dumps(sort_keys=True)`. The
// `canonicalJson` above sorts with `localeCompare`, which is locale-sensitive
// and is NOT the publisher's rule; it agrees on today's contract by accident,
// and an accident is not what a digest comparison should rest on.
function publisherCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publisherCanonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, publisherCanonicalize(nested)])
  );
}

// The cell advertises a RELEASE-INCLUSIVE digest: `digest.value` hashes a base
// that still contains `exomem_release`. The candidate pins `schema_contract_sha256`,
// which exomem deliberately made release-INDEPENDENT (exomem #345, 2026-07-27) by
// hashing the same contract with `exomem_release` and `digest` removed, so that a
// version bump no longer invalidates a published artifact whose surface never moved.
//
// Comparing `digest.value` against the candidate's `schemaDigest` therefore compares
// two values that were never the same quantity, and it can never succeed. That is
// exactly what this function existed to do until now: substrate #59 landed the
// comparison the same day exomem #345 removed its premise, and the comment on the
// exomem side ("nothing cross-checks it against the running gateway's digest") named
// the assumption that made it wrong. No hosted tool call could pass this check for
// any release built after that date, 0.54.1 and 0.57.2 included.
//
// Recomputing the published digest from the body the cell actually served keeps the
// full-surface guarantee — every byte of the contract still has to match what the
// candidate pinned — while comparing like with like.
function publishedAgentContractDigest(body: Record<string, unknown>): string {
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "exomem_release" || key === "digest") continue;
    base[key] = value;
  }
  return createHash("sha256")
    .update(JSON.stringify(publisherCanonicalize(base)), "utf8")
    .digest("hex");
}

async function verifyHostedPrivateContract(
  target: ResolvedPrivateTarget,
  expected: ExpectedHostedContract,
  dependencies: GatewayDependencies,
  requestId: string
): Promise<void> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const url = new URL(
    `private/exomem/v1/agent/${encodeURIComponent(expected.profile)}/contract`,
    `${target.endpoint.toString().replace(/\/$/, "")}/`
  );
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: privateGatewayHeaders(target, requestId, dependencies.access),
      cache: "no-store",
      redirect: "error",
      signal: privateDeadlineSignal(dependencies.signal, PRIVATE_TIMEOUT_MS),
    });
  } catch {
    throw exomemErrors.cellUnavailable();
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw exomemErrors.cellUnavailable();
  }
  const body = await boundedJsonResponse(response, MAX_CELL_RESPONSE_BYTES, dependencies.signal);
  const profile = safeJsonObject(body.agent_profile);
  if (
    profile?.profile !== expected.profile ||
    profile.active_capability_sha256 !== expected.commandFingerprint ||
    body.exomem_release !== expected.sourceRelease ||
    body.protocol_version !== expected.protocolVersion ||
    publishedAgentContractDigest(body) !== expected.schemaDigest
  ) {
    throw exomemErrors.protocolMismatch();
  }
}

function validateArguments(command: HostedContractCommand, args: Record<string, unknown>): void {
  const selectorChecked = command.name === "bootstrap" ? { ...args } : args;
  if (command.name === "bootstrap") delete selectorChecked.profile;
  const known = new Set(command.params.map((parameter) => parameter.name));
  if (
    hasReservedSelector(
      selectorChecked,
      new Set([...known].map((parameter) => normalizeField(parameter)))
    )
  )
    throw exomemErrors.selectorRejected();
  if (Object.keys(args).some((key) => !known.has(key))) {
    throw exomemErrors.invalidRequest();
  }
  if (
    command.params.some((parameter) => parameter.required && !Object.hasOwn(args, parameter.name))
  ) {
    throw exomemErrors.invalidRequest();
  }
}

function assertEntitled(target: GatewayTarget, command: HostedContractCommand): void {
  const capability = command.read_only ? "recall" : "capture";
  if (
    !target.capabilities.includes(capability) ||
    ["suspended", "deleted", "provisioning"].includes(target.entitlementEffectiveState)
  ) {
    throw exomemErrors.entitlementDenied();
  }
}

function validEnvelope(value: Record<string, unknown>): boolean {
  if (value.success === true) return Object.hasOwn(value, "data");
  if (value.success !== false) return false;
  const error = safeJsonObject(value.error);
  return Boolean(
    error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    Object.hasOwn(error, "remediation")
  );
}

async function forwardCommand(input: {
  target: ResolvedPrivateTarget;
  command: HostedContractCommand;
  args: Record<string, unknown>;
  idempotencyKey: string | null;
  requestId: string;
  dependencies: GatewayDependencies;
  hostedProfile: string | null;
}): Promise<GatewayResult> {
  const fetchImpl = input.dependencies.fetch ?? fetch;
  const url = new URL(
    `${input.hostedProfile ? `private/exomem/v1/agent/${encodeURIComponent(input.hostedProfile)}` : "private/exomem/v1"}/command/${encodeURIComponent(input.command.name)}`,
    `${input.target.endpoint.toString().replace(/\/$/, "")}/`
  );
  const headers: Record<string, string> = {
    ...privateGatewayHeaders(input.target, input.requestId, input.dependencies.access),
    "content-type": "application/json",
  };
  if (!input.command.read_only && input.idempotencyKey) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
  const body = JSON.stringify(input.args);
  const attempts = !input.command.read_only && !input.idempotencyKey ? 1 : 2;
  const now = input.dependencies.now ?? Date.now;
  const deadline = now() + PRIVATE_TIMEOUT_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) throw exomemErrors.cellUnavailable();
    const signal = privateDeadlineSignal(input.dependencies.signal, Math.max(1, remainingMs));
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      if (attempt + 1 === attempts) throw exomemErrors.cellUnavailable();
      continue;
    }
    if (response.status >= 500 && attempt + 1 < attempts) {
      cancelResponseBody(response);
      continue;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = await boundedJsonResponse(response, MAX_CELL_RESPONSE_BYTES, signal);
    } catch (error) {
      if (!(error instanceof CellResponseBodyReadError)) throw error;
      if (attempt + 1 === attempts || now() >= deadline) {
        throw exomemErrors.cellUnavailable();
      }
      continue;
    }
    if (!validEnvelope(envelope)) throw exomemErrors.cellResponseInvalid();
    return {
      status: response.status,
      body: envelope,
      requestId: input.requestId,
      attempts: attempt + 1,
    };
  }
  throw exomemErrors.cellUnavailable();
}

export async function routeExomemCommand(input: {
  session: { userId: string; tenantId: string };
  commandName: string;
  args: Record<string, unknown>;
  idempotencyKey?: string | null;
  requestId?: string;
  hostedContract?: ExpectedHostedContract;
  command?: HostedContractCommand;
  dependencies?: GatewayDependencies;
}): Promise<GatewayResult> {
  const requestId = input.requestId ?? randomUUID();
  if (!COMMAND_NAME.test(input.commandName)) throw exomemErrors.commandNotFound();
  if (input.command) validateArguments(input.command, input.args);
  else if (hasReservedSelector(input.args)) throw exomemErrors.selectorRejected();
  if (INTERCEPTED_COMMANDS.has(input.commandName)) {
    throw exomemErrors.commandInterceptRequired();
  }
  const serialized = Buffer.byteLength(JSON.stringify(input.args), "utf8");
  if (serialized > MAX_COMMAND_BYTES) throw exomemErrors.requestTooLarge();
  const dependencies = input.dependencies ?? {};
  if (dependencies.signal?.aborted) throw exomemErrors.cellUnavailable();
  const target = await resolveGatewayPrivateTarget(input.session, dependencies);
  if (dependencies.signal?.aborted) throw exomemErrors.cellUnavailable();
  if (input.hostedContract) {
    const expected = input.hostedContract;
    contractFixture(target.row, expected);
    if (
      target.row.hostedProfile !== expected.profile ||
      target.row.hostedSourceRelease !== expected.sourceRelease ||
      target.row.hostedProtocolVersion !== expected.protocolVersion ||
      target.row.hostedCommandFingerprint !== expected.commandFingerprint ||
      target.row.hostedContractDigest !== expected.schemaDigest ||
      target.row.hostedCompatibilityDigest !== expected.compatibilityDigest
    ) {
      throw exomemErrors.protocolMismatch();
    }
    await verifyHostedPrivateContract(target, expected, dependencies, requestId);
  }
  const contract = input.command ? null : await fetchContract(target, dependencies, requestId);
  const command =
    input.command ?? contract?.commands.find((candidate) => candidate.name === input.commandName);
  if (!command) throw exomemErrors.commandNotFound();
  if (!input.command) validateArguments(command, input.args);
  assertEntitled(target.row, command);

  const idempotencyKey = command.read_only
    ? input.idempotencyKey?.trim() || null
    : normalizeIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) throw exomemErrors.invalidRequest();
  return forwardCommand({
    target,
    command,
    args: input.args,
    idempotencyKey,
    requestId,
    dependencies,
    hostedProfile: input.hostedContract?.profile ?? null,
  });
}

export const gatewayLimits = {
  commandBytes: MAX_COMMAND_BYTES,
  responseBytes: MAX_CELL_RESPONSE_BYTES,
} as const;
