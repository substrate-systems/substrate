import { executeExomemSql, resolveGatewayTarget, type GatewayTarget } from "./db";
import { exomemErrors } from "./errors";
import { SqlLifecycleStore } from "./lifecycle-store";
import {
  HttpCellProvisioner,
  provisionerConfigFromEnv,
  type ExportDownloadResult,
} from "./provisioner";
import { immediateBestEffortReconcile } from "./reconcile-runtime";
import { exportTtlMsFromEnv } from "./reconciler";
import { decryptSecret, type SecretEnvelope } from "./security";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OwnerExportSummary = {
  exportId: string | null;
  operationId: string;
  requestId: string;
  state: "processing" | "available" | "failed";
  archiveSize: number | null;
  archiveSha256: string | null;
  manifestSha256: string | null;
  createdAt: string;
  expiresAt: string | null;
  errorCode: string | null;
};

export type OwnerExportPrivate = OwnerExportSummary & {
  tenantId: string;
  cellId: string;
  fenceGeneration: number;
  storageReferenceEnvelope: SecretEnvelope;
  storageReferenceDigest: Buffer;
};

export type DurabilityDependencies = {
  resolveTarget: typeof resolveGatewayTarget;
  enqueue: SqlLifecycleStore["enqueue"];
  reconcile: typeof immediateBestEffortReconcile;
  listExports: typeof listOwnerExports;
  getExport: typeof getOwnerExport;
  createDownload: (input: OwnerExportPrivate) => Promise<ExportDownloadResult>;
  exportTtlMs: number;
};

function defaults(): DurabilityDependencies {
  const store = new SqlLifecycleStore();
  return {
    resolveTarget: resolveGatewayTarget,
    enqueue: store.enqueue.bind(store),
    reconcile: immediateBestEffortReconcile,
    listExports: listOwnerExports,
    getExport: getOwnerExport,
    exportTtlMs: exportTtlMsFromEnv(),
    createDownload: async (record) => {
      const provisioner = new HttpCellProvisioner(provisionerConfigFromEnv());
      return provisioner.createExportDownload({
        context: {
          operationId: record.operationId,
          checkpoint: "owner-download",
          idempotencyKey: `${record.exportId}:download:${Math.floor(Date.now() / 60_000)}`,
          fenceGeneration: record.fenceGeneration,
        },
        tenantId: record.tenantId,
        exportRef: decryptSecret(record.storageReferenceEnvelope),
      });
    },
  };
}

function withDefaults(dependencies?: Partial<DurabilityDependencies>): DurabilityDependencies {
  return { ...defaults(), ...dependencies };
}

function assertExportEntitled(
  target: GatewayTarget | null,
  userId: string,
  tenantId: string
): void {
  if (
    !target ||
    target.userId !== userId ||
    target.tenantId !== tenantId ||
    !target.capabilities.includes("export") ||
    !["active", "suspended"].includes(target.tenantStatus) ||
    target.tenantDesiredState === "deleted" ||
    target.cellRoutingState !== "bound" ||
    !["active", "quiesced", "draining"].includes(target.cellLifecycleState)
  ) {
    throw exomemErrors.entitlementDenied();
  }
}

function assertRestoreEntitled(
  target: GatewayTarget | null,
  userId: string,
  tenantId: string
): void {
  assertExportEntitled(target, userId, tenantId);
  if (
    !target ||
    target.tenantStatus !== "active" ||
    target.tenantDesiredState !== "running" ||
    target.manuallySuspended ||
    target.entitlementEffectiveState !== "active" ||
    !target.capabilities.includes("capture")
  ) {
    throw exomemErrors.entitlementDenied();
  }
}

function validateRetryKey(value: string): string {
  const key = value.trim();
  if (!IDEMPOTENCY_KEY.test(key)) throw exomemErrors.invalidRequest();
  return key;
}

export async function requestOwnerExport(
  input: { userId: string; tenantId: string; idempotencyKey: string },
  dependencies?: Partial<DurabilityDependencies>
): Promise<{ operationId: string; requestId: string; state: "processing" }> {
  const deps = withDefaults(dependencies);
  const target = await deps.resolveTarget({ userId: input.userId, tenantId: input.tenantId });
  assertExportEntitled(target, input.userId, input.tenantId);
  const operation = await deps.enqueue(
    input.tenantId,
    "export",
    validateRetryKey(input.idempotencyKey),
    target?.cellId ?? null,
    { exportTtlMs: deps.exportTtlMs }
  );
  await deps.reconcile(input.tenantId);
  return { operationId: operation.id, requestId: operation.requestId, state: "processing" };
}

export async function requestOwnerRestore(
  input: {
    userId: string;
    tenantId: string;
    exportId: string;
    idempotencyKey: string;
  },
  dependencies?: Partial<DurabilityDependencies>
): Promise<{ operationId: string; requestId: string; state: "processing" }> {
  if (!UUID.test(input.exportId)) throw exomemErrors.invalidRequest();
  const deps = withDefaults(dependencies);
  const [target, record] = await Promise.all([
    deps.resolveTarget({ userId: input.userId, tenantId: input.tenantId }),
    deps.getExport(input.userId, input.tenantId, input.exportId),
  ]);
  assertRestoreEntitled(target, input.userId, input.tenantId);
  if (!record || record.state !== "available") throw exomemErrors.exportNotFound();
  if (!record.expiresAt || new Date(record.expiresAt) <= new Date()) {
    throw exomemErrors.exportExpired();
  }
  if (
    !record.archiveSha256 ||
    !record.manifestSha256 ||
    !record.archiveSize ||
    !/^[0-9a-f]{64}$/.test(record.archiveSha256) ||
    !/^[0-9a-f]{64}$/.test(record.manifestSha256)
  ) {
    throw exomemErrors.exportUnavailable();
  }
  const operation = await deps.enqueue(
    input.tenantId,
    "restore",
    validateRetryKey(input.idempotencyKey),
    null,
    {
      inputReferenceEnvelope: record.storageReferenceEnvelope,
      inputReferenceDigest: record.storageReferenceDigest,
      restoreBinding: {
        exportId: input.exportId,
        sourceCellId: record.cellId,
        archiveSha256: record.archiveSha256,
        manifestSha256: record.manifestSha256,
        archiveSize: record.archiveSize,
      },
    }
  );
  await deps.reconcile(input.tenantId);
  return { operationId: operation.id, requestId: operation.requestId, state: "processing" };
}

export async function ownerExportDownload(
  input: { userId: string; tenantId: string; exportId: string },
  dependencies?: Partial<DurabilityDependencies>
): Promise<ExportDownloadResult> {
  if (!UUID.test(input.exportId)) throw exomemErrors.exportNotFound();
  const deps = withDefaults(dependencies);
  const record = await deps.getExport(input.userId, input.tenantId, input.exportId);
  if (!record || record.state !== "available") throw exomemErrors.exportNotFound();
  if (!record.expiresAt || new Date(record.expiresAt) <= new Date()) {
    throw exomemErrors.exportExpired();
  }
  try {
    return await deps.createDownload(record);
  } catch {
    throw exomemErrors.exportUnavailable();
  }
}

export async function listOwnerExports(
  userId: string,
  tenantId: string
): Promise<OwnerExportSummary[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-owner-exports */
    SELECT export_row.id AS export_id,
           operation.id AS operation_id,
           operation.request_id,
           operation.state AS operation_state,
           operation.error_code,
           operation.created_at,
           export_row.state AS export_state,
           export_row.archive_size,
           export_row.archive_sha256,
           export_row.manifest_sha256,
           export_row.expires_at,
           tenant.fence_generation
    FROM exomem_lifecycle_operations AS operation
    JOIN exomem_tenants AS tenant
      ON tenant.id = operation.tenant_id
     AND tenant.owner_user_id = ${userId}
    LEFT JOIN exomem_exports AS export_row
      ON export_row.operation_id = operation.id
     AND export_row.tenant_id = tenant.id
     AND export_row.state = 'available'
     AND export_row.expires_at > now()
    WHERE tenant.id = ${tenantId}
      AND operation.operation_type = 'export'
      AND (operation.state <> 'succeeded' OR export_row.id IS NOT NULL)
    ORDER BY operation.created_at DESC
    LIMIT 10
  `;
  return rows.map((row) => ({
    exportId: row.export_id ? String(row.export_id) : null,
    operationId: String(row.operation_id),
    requestId: String(row.request_id),
    state:
      row.export_state === "available"
        ? "available"
        : row.operation_state === "failed_terminal"
          ? "failed"
          : "processing",
    archiveSize: row.archive_size == null ? null : Number(row.archive_size),
    archiveSha256: row.archive_sha256 ? String(row.archive_sha256) : null,
    manifestSha256: row.manifest_sha256 ? String(row.manifest_sha256) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
    errorCode: row.error_code ? String(row.error_code) : null,
  }));
}

export async function getOwnerExport(
  userId: string,
  tenantId: string,
  exportId: string
): Promise<OwnerExportPrivate | null> {
  const { rows } = await executeExomemSql`
    /* exomem:get-owner-export */
    SELECT export_row.id AS export_id,
           export_row.tenant_id,
           export_row.cell_id,
           export_row.operation_id,
           operation.request_id,
           operation.created_at,
           operation.error_code,
           export_row.state AS export_state,
           export_row.storage_reference_ciphertext,
           export_row.storage_reference_digest,
           export_row.archive_size,
           export_row.archive_sha256,
           export_row.manifest_sha256,
           export_row.expires_at,
           tenant.fence_generation
    FROM exomem_exports AS export_row
    JOIN exomem_lifecycle_operations AS operation
      ON operation.id = export_row.operation_id
     AND operation.tenant_id = export_row.tenant_id
    JOIN exomem_tenants AS tenant
      ON tenant.id = export_row.tenant_id
     AND tenant.owner_user_id = ${userId}
    WHERE export_row.id = ${exportId}
      AND export_row.tenant_id = ${tenantId}
      AND export_row.state = 'available'
      AND export_row.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const envelope =
    typeof row.storage_reference_ciphertext === "string"
      ? (JSON.parse(row.storage_reference_ciphertext) as SecretEnvelope)
      : (row.storage_reference_ciphertext as SecretEnvelope);
  return {
    exportId: String(row.export_id),
    operationId: String(row.operation_id),
    requestId: String(row.request_id),
    state: row.export_state === "available" ? "available" : "failed",
    archiveSize: Number(row.archive_size),
    archiveSha256: String(row.archive_sha256),
    manifestSha256: String(row.manifest_sha256),
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    tenantId: String(row.tenant_id),
    cellId: String(row.cell_id),
    fenceGeneration: Number(row.fence_generation),
    storageReferenceEnvelope: envelope,
    storageReferenceDigest: Buffer.from(row.storage_reference_digest as Uint8Array),
  };
}
