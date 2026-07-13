import { createHash, randomUUID } from "node:crypto";
import { resolveGatewayTarget, type GatewayTarget } from "./db";
import { exomemErrors } from "./errors";
import { exomemContractFixture0191 } from "./gateway-contract-0-19-1";
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

const RESERVED_FIELDS = new Set([
  "tenant",
  "tenant_id",
  "tenant_scope",
  "account",
  "account_id",
  "cell",
  "cell_id",
  "cell_endpoint",
  "vault",
  "vault_path",
  "vault_root",
  "principal",
  "principal_scope",
  "request_id",
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
  "retry_scope",
]);

const INTERCEPTED_COMMANDS = new Set(["transfer_artifact", "adopt_vault"]);

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
};

export type GatewayDependencies = {
  resolveTarget?: typeof resolveGatewayTarget;
  fetch?: typeof fetch;
  expectedProtocol?: string;
  now?: () => number;
  decrypt?: typeof decryptSecret;
  principalScope?: typeof opaquePrincipalScope;
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
  return value.trim().toLowerCase().replaceAll("-", "_");
}

export function hasReservedSelector(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReservedSelector);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => RESERVED_FIELDS.has(normalizeField(key)) || hasReservedSelector(nested)
  );
}

export function hasForbiddenGatewayHeaders(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      (normalized.startsWith("x-exomem-") && normalized !== "x-exomem-csrf") ||
      normalized.startsWith("x-tenant") ||
      normalized === "x-cell-id" ||
      normalized === "x-vault-path" ||
      normalized === "x-vault-root" ||
      normalized === "x-principal-scope" ||
      normalized === "x-protocol-version" ||
      normalized === "x-internal-endpoint"
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

function contractFixture(target: GatewayTarget): typeof exomemContractFixture0191 {
  if (
    target.releaseVersion !== exomemContractFixture0191.release ||
    target.protocolVersion !== exomemContractFixture0191.protocol
  ) {
    throw exomemErrors.protocolMismatch();
  }
  return exomemContractFixture0191;
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
      guardedFields.some(
        (field) =>
          typeof field !== "string" || !COMMAND_NAME.test(field) || !parameterNames.has(field)
      ) ||
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
  requestId: string
): Record<string, string> {
  return {
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
  const target = await (dependencies.resolveTarget ?? resolveGatewayTarget)(session);
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
  const signal = AbortSignal.timeout(PRIVATE_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: privateGatewayHeaders(target, requestId),
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

function validateArguments(command: HostedContractCommand, args: Record<string, unknown>): void {
  if (hasReservedSelector(args)) throw exomemErrors.selectorRejected();
  const known = new Set(command.params.map((parameter) => parameter.name));
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
}): Promise<GatewayResult> {
  const fetchImpl = input.dependencies.fetch ?? fetch;
  const url = new URL(
    `private/exomem/v1/command/${encodeURIComponent(input.command.name)}`,
    `${input.target.endpoint.toString().replace(/\/$/, "")}/`
  );
  const headers: Record<string, string> = {
    ...privateGatewayHeaders(input.target, input.requestId),
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
    const signal = AbortSignal.timeout(Math.max(1, remainingMs));
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
  dependencies?: GatewayDependencies;
}): Promise<GatewayResult> {
  const requestId = input.requestId ?? randomUUID();
  if (!COMMAND_NAME.test(input.commandName)) throw exomemErrors.commandNotFound();
  if (hasReservedSelector(input.args)) throw exomemErrors.selectorRejected();
  if (INTERCEPTED_COMMANDS.has(input.commandName)) {
    throw exomemErrors.commandInterceptRequired();
  }
  const serialized = Buffer.byteLength(JSON.stringify(input.args), "utf8");
  if (serialized > MAX_COMMAND_BYTES) throw exomemErrors.requestTooLarge();
  const dependencies = input.dependencies ?? {};
  const target = await resolveGatewayPrivateTarget(input.session, dependencies);
  const contract = await fetchContract(target, dependencies, requestId);
  const command = contract.commands.find((candidate) => candidate.name === input.commandName);
  if (!command) throw exomemErrors.commandNotFound();
  validateArguments(command, input.args);
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
  });
}

export const gatewayLimits = {
  commandBytes: MAX_COMMAND_BYTES,
  responseBytes: MAX_CELL_RESPONSE_BYTES,
} as const;
