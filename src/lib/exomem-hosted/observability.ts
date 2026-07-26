import { ExomemHostedError } from "./errors";

const EVENT_NAMES = new Set([
  "access.invite.created",
  "access.invite.redeemed",
  "access.invite.delivery_failed",
  "access.magic_link.requested",
  "access.magic_link.redeemed",
  "access.magic_link.delivery_failed",
  "access.logout.succeeded",
  "access.request.denied",
  "lifecycle.capacity.transition",
  "lifecycle.capacity.claim",
  "mcp.request",
]);

const ERROR_CODES = new Set([
  "ACCESS_TOKEN_INVALID",
  "ADMIN_DISABLED",
  "ADMIN_UNAUTHORIZED",
  "CELL_MAPPING_AMBIGUOUS",
  "CELL_MAPPING_MISSING",
  "CSRF_REJECTED",
  "EMAIL_DELIVERY_UNAVAILABLE",
  "EXOMEM_SESSION_INVALID",
  "INTERNAL_ERROR",
  "INVALID_EMAIL",
  "INVALID_ENTITLEMENT_SOURCE",
  "INVALID_EXPIRY",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "CAPACITY_UNAVAILABLE",
  "CELL_RESPONSE_INVALID",
  "CELL_UNAVAILABLE",
  "COMMAND_NOT_FOUND",
  "CELL_PROTOCOL_MISMATCH",
  "DELETION_IN_PROGRESS",
  "EXOMEM_ENTITLEMENT_DENIED",
  "EXOMEM_DELETED",
  "EXOMEM_NOT_READY",
  "EXOMEM_PROVISIONING_FAILED",
  "EXOMEM_SUSPENDED",
  "HOSTED_SELECTOR_REJECTED",
  "HOSTED_CONTRACT_UNAVAILABLE",
  "MCP_PROTOCOL_UNSUPPORTED",
  "TENANT_PREPARING",
  "TOO_LARGE",
]);

const OUTCOMES = new Set(["succeeded", "failed", "denied", "pending"]);
const CAPACITY_BUCKETS = new Set(["storage", "runtime", "provision"]);
const CAPACITY_TRANSITIONS = new Set([
  "reserved_to_uncertain",
  "uncertain_to_occupied",
  "occupied_to_retained_storage",
  "uncertain_to_retained_storage",
  "retained_storage_to_uncertain",
  "any_to_released",
]);
const CLAIM_KINDS = new Set(["initial_provision", "resume"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperationalEvent = {
  timestamp: string;
  event: string;
  outcome: string;
  requestId?: string;
  tenantId?: string;
  cellId?: string;
  operationId?: string;
  errorCode?: string;
  protocolVersion?: string;
  releaseVersion?: string;
  durationBucket?: string;
  byteBucket?: string;
  responseByteBucket?: string;
  countBucket?: string;
  capacityBucket?: string;
  transition?: string;
  claimKind?: string;
  clientHash?: string;
  cohortHash?: string;
  tenantHash?: string;
  tokenFamilyHash?: string;
  requestClass?: string;
  toolClass?: string;
  retryBucket?: string;
};

function optionalUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function optionalBoundedLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

function optionalEnum(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function optionalOpaqueHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

export function buildOperationalEvent(
  input: Record<string, unknown>,
  now: () => Date = () => new Date()
): OperationalEvent {
  const event = typeof input.event === "string" ? input.event : "";
  const outcome = typeof input.outcome === "string" ? input.outcome : "";
  if (!EVENT_NAMES.has(event) || !OUTCOMES.has(outcome)) {
    throw new ExomemHostedError({
      code: "INVALID_REQUEST",
      status: 500,
      message: "operational event metadata is invalid",
    });
  }
  const errorCode =
    typeof input.errorCode === "string" && ERROR_CODES.has(input.errorCode)
      ? input.errorCode
      : undefined;
  return {
    timestamp: now().toISOString(),
    event,
    outcome,
    ...(optionalUuid(input.requestId) ? { requestId: optionalUuid(input.requestId) } : {}),
    ...(optionalUuid(input.tenantId) ? { tenantId: optionalUuid(input.tenantId) } : {}),
    ...(optionalUuid(input.cellId) ? { cellId: optionalUuid(input.cellId) } : {}),
    ...(optionalUuid(input.operationId) ? { operationId: optionalUuid(input.operationId) } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(optionalBoundedLabel(input.protocolVersion)
      ? { protocolVersion: optionalBoundedLabel(input.protocolVersion) }
      : {}),
    ...(optionalBoundedLabel(input.releaseVersion)
      ? { releaseVersion: optionalBoundedLabel(input.releaseVersion) }
      : {}),
    ...(optionalBoundedLabel(input.durationBucket)
      ? { durationBucket: optionalBoundedLabel(input.durationBucket) }
      : {}),
    ...(optionalBoundedLabel(input.byteBucket)
      ? { byteBucket: optionalBoundedLabel(input.byteBucket) }
      : {}),
    ...(optionalBoundedLabel(input.responseByteBucket)
      ? { responseByteBucket: optionalBoundedLabel(input.responseByteBucket) }
      : {}),
    ...(optionalBoundedLabel(input.countBucket)
      ? { countBucket: optionalBoundedLabel(input.countBucket) }
      : {}),
    ...(optionalEnum(input.capacityBucket, CAPACITY_BUCKETS)
      ? { capacityBucket: optionalEnum(input.capacityBucket, CAPACITY_BUCKETS) }
      : {}),
    ...(optionalEnum(input.transition, CAPACITY_TRANSITIONS)
      ? { transition: optionalEnum(input.transition, CAPACITY_TRANSITIONS) }
      : {}),
    ...(optionalEnum(input.claimKind, CLAIM_KINDS)
      ? { claimKind: optionalEnum(input.claimKind, CLAIM_KINDS) }
      : {}),
    ...(optionalOpaqueHash(input.clientHash)
      ? { clientHash: optionalOpaqueHash(input.clientHash) }
      : {}),
    ...(optionalOpaqueHash(input.cohortHash)
      ? { cohortHash: optionalOpaqueHash(input.cohortHash) }
      : {}),
    ...(optionalOpaqueHash(input.tenantHash)
      ? { tenantHash: optionalOpaqueHash(input.tenantHash) }
      : {}),
    ...(optionalOpaqueHash(input.tokenFamilyHash)
      ? { tokenFamilyHash: optionalOpaqueHash(input.tokenFamilyHash) }
      : {}),
    ...(optionalBoundedLabel(input.requestClass)
      ? { requestClass: optionalBoundedLabel(input.requestClass) }
      : {}),
    ...(optionalBoundedLabel(input.toolClass)
      ? { toolClass: optionalBoundedLabel(input.toolClass) }
      : {}),
    ...(optionalBoundedLabel(input.retryBucket)
      ? { retryBucket: optionalBoundedLabel(input.retryBucket) }
      : {}),
  };
}

let operationalEventSink: (line: string) => void = console.info;

export function setOperationalEventSinkForTests(sink: ((line: string) => void) | null): void {
  operationalEventSink = sink ?? console.info;
}

export function emitOperationalEvent(event: OperationalEvent, sink = operationalEventSink): void {
  sink(JSON.stringify(event));
}
