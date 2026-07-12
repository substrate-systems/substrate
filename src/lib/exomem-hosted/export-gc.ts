import { randomUUID } from "node:crypto";
import { executeExomemSql } from "./db";
import {
  HttpCellProvisioner,
  ProvisionerFailure,
  provisionerConfigFromEnv,
  type CellProvisioner,
} from "./provisioner";
import { decryptSecret, type SecretEnvelope } from "./security";

export type ExportGcCandidate = {
  exportId: string;
  tenantId: string;
  fenceGeneration: number;
  storageReferenceEnvelope: SecretEnvelope;
};

export interface ExportGcStore {
  claim(input: { owner: string; leaseMs: number }): Promise<ExportGcCandidate | null>;
  complete(input: { exportId: string; owner: string }): Promise<boolean>;
  retry(input: {
    exportId: string;
    owner: string;
    errorCode: string;
    nextAttemptAt: Date;
  }): Promise<boolean>;
}

function asEnvelope(value: unknown): SecretEnvelope {
  return (typeof value === "string" ? JSON.parse(value) : value) as SecretEnvelope;
}

export class SqlExportGcStore implements ExportGcStore {
  async claim(input: { owner: string; leaseMs: number }): Promise<ExportGcCandidate | null> {
    const { rows } = await executeExomemSql`
      /* exomem:export-gc-claim */
      WITH candidate AS (
        SELECT export_row.id
        FROM exomem_exports AS export_row
        JOIN exomem_tenants AS tenant ON tenant.id = export_row.tenant_id
        WHERE tenant.desired_state <> 'deleted'
          AND export_row.gc_next_attempt_at <= now()
          AND (
            (export_row.state = 'available' AND export_row.expires_at <= now())
            OR export_row.state = 'deleting'
          )
          AND (export_row.gc_lease_expires_at IS NULL OR export_row.gc_lease_expires_at <= now())
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_lifecycle_operations AS restore
            WHERE restore.input_export_id = export_row.id
              AND restore.operation_type = 'restore'
              AND restore.state IN ('pending', 'running', 'waiting', 'failed_retryable')
          )
        ORDER BY export_row.gc_next_attempt_at, export_row.expires_at, export_row.created_at
        FOR UPDATE OF export_row SKIP LOCKED
        LIMIT 1
      )
      UPDATE exomem_exports AS export_row
      SET state = 'deleting',
          gc_lease_owner = ${input.owner},
          gc_lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
          gc_attempts = gc_attempts + 1,
          gc_error_code = NULL
      FROM candidate, exomem_tenants AS tenant
      WHERE export_row.id = candidate.id
        AND tenant.id = export_row.tenant_id
      RETURNING export_row.id AS export_id,
                export_row.tenant_id,
                export_row.storage_reference_ciphertext,
                tenant.fence_generation
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      exportId: String(row.export_id),
      tenantId: String(row.tenant_id),
      fenceGeneration: Number(row.fence_generation),
      storageReferenceEnvelope: asEnvelope(row.storage_reference_ciphertext),
    };
  }

  async complete(input: { exportId: string; owner: string }): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:export-gc-complete */
      UPDATE exomem_exports AS export_row
      SET state = 'deleted',
          storage_reference_ciphertext = NULL,
          storage_reference_digest = NULL,
          archive_sha256 = NULL,
          manifest_sha256 = NULL,
          archive_size = NULL,
          encryption_scheme = NULL,
          integrity_verified = NULL,
          provider_deleted_at = COALESCE(provider_deleted_at, now()),
          deleted_at = COALESCE(deleted_at, now()),
          gc_lease_owner = NULL,
          gc_lease_expires_at = NULL,
          gc_error_code = NULL
      WHERE export_row.id = ${input.exportId}
        AND export_row.state = 'deleting'
        AND export_row.gc_lease_owner = ${input.owner}
        AND export_row.gc_lease_expires_at > now()
      RETURNING export_row.id
    `;
    return rows.length === 1;
  }

  async retry(input: {
    exportId: string;
    owner: string;
    errorCode: string;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:export-gc-retry */
      UPDATE exomem_exports AS export_row
      SET gc_lease_owner = NULL,
          gc_lease_expires_at = NULL,
          gc_error_code = ${input.errorCode},
          gc_next_attempt_at = ${input.nextAttemptAt.toISOString()}
      WHERE export_row.id = ${input.exportId}
        AND export_row.state = 'deleting'
        AND export_row.gc_lease_owner = ${input.owner}
        AND export_row.gc_lease_expires_at > now()
      RETURNING export_row.id
    `;
    return rows.length === 1;
  }
}

export type ExportGcResult = {
  attempted: number;
  deleted: number;
  retryScheduled: number;
};

export async function runExportGc(input: {
  maxExports: number;
  timeBudgetMs: number;
  owner?: string;
  leaseMs?: number;
  store?: ExportGcStore;
  provisioner?: Pick<CellProvisioner, "deleteExport">;
  envelopeKey?: Buffer;
  now?: () => Date;
}): Promise<ExportGcResult> {
  const startedAt = Date.now();
  const now = input.now ?? (() => new Date());
  const owner = input.owner ?? randomUUID();
  const leaseMs = input.leaseMs ?? 30_000;
  const store = input.store ?? new SqlExportGcStore();
  const provisioner = input.provisioner ?? new HttpCellProvisioner(provisionerConfigFromEnv());
  const result: ExportGcResult = { attempted: 0, deleted: 0, retryScheduled: 0 };

  while (result.attempted < input.maxExports && Date.now() - startedAt < input.timeBudgetMs) {
    const candidate = await store.claim({ owner, leaseMs });
    if (!candidate) break;
    result.attempted += 1;
    try {
      const proof = await provisioner.deleteExport({
        context: {
          operationId: candidate.exportId,
          checkpoint: "provider-delete",
          idempotencyKey: `${candidate.exportId}:provider-delete`,
          fenceGeneration: candidate.fenceGeneration,
        },
        tenantId: candidate.tenantId,
        exportRef: decryptSecret(candidate.storageReferenceEnvelope, {
          key: input.envelopeKey,
        }),
      });
      if (proof.objectDestroyed !== true) {
        throw new ProvisionerFailure({
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
      }
      if (!(await store.complete({ exportId: candidate.exportId, owner }))) {
        throw new ProvisionerFailure({
          code: "CONTROL_PLANE_STATE_CONFLICT",
          retryable: true,
        });
      }
      result.deleted += 1;
    } catch (error) {
      const code = error instanceof ProvisionerFailure ? error.code : "PROVISIONER_UNAVAILABLE";
      const retryAt = new Date(now().getTime() + 60_000);
      if (
        await store.retry({
          exportId: candidate.exportId,
          owner,
          errorCode: code,
          nextAttemptAt: retryAt,
        })
      ) {
        result.retryScheduled += 1;
      }
    }
  }
  return result;
}
