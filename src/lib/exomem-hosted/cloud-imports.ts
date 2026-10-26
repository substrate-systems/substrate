import { randomUUID } from "node:crypto";
import { validate as validUuid } from "uuid";
import {
  cloudImportAvailable,
  calculateImportAdmission,
  IMPORT_GIB,
  importPartLimits,
  type ImportStorage,
  type ImportLimit,
  MAX_IMPORT_PARTS,
  type CloudImport,
  type UploadPart,
} from "../exomem/cloud-import-contract";
import { resolveCloudOwnerPrincipal } from "./cloud-owner-principal";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";

export type CloudImportAction =
  | "create"
  | "status"
  | "prepare-upload"
  | "complete"
  | "cancel"
  | "discard";
type CloudImportPrincipal = {
  userId: string;
  tenantId: string;
  cellId: string;
  cellDesiredState: string;
};
type CellRow = {
  desired_state: string;
  import_limits: unknown;
  storage_gib: number;
  grown_storage_gib: number | null;
  used_bytes: string | null;
  filesystem_bytes: string | null;
  usage_observed_at: Date | null;
  generation: string;
  observed_storage_capacity_bytes: string | null;
  observed_storage_generation: string | null;
  observed_storage_pvc_uid: string | null;
  observed_storage_pvc_version: string | null;
  observed_storage_at: Date | null;
};
type PartETag = { part_number: number; etag: string };
type ImportRow = {
  import_id: string;
  cell_id: string;
  kind: string;
  declared_bytes: string;
  declared_files: string;
  requested_state: string;
  part_etags: PartETag[] | null;
  ciphertext_sha256: string | null;
  ciphertext_bytes: string | null;
  recipient: string | null;
  upload_id: string | null;
  part_urls: UploadPart[] | null;
  urls_expire_at: Date | null;
  observed_state: string | null;
  error_code: string | null;
  required_storage_gib: number | null;
  staged_files: string | null;
  staged_bytes: string | null;
  created_at: Date;
  updated_at: Date;
};

function importError(
  code: string,
  status: number,
  message: string,
  limit?: ImportLimit
): ExomemHostedError {
  return new ExomemHostedError({ code, status, message, limit });
}
const notFound = () => importError("IMPORT_NOT_FOUND", 404, "the import is unavailable");
const conflict = () =>
  importError("IMPORT_CONFLICT", 409, "the import request conflicts with its current state");

/** An import belongs to the owner's one live cell, which a session must look up. */
export async function resolveCloudImportPrincipal(request: Request): Promise<CloudImportPrincipal> {
  const owner = await resolveCloudOwnerPrincipal(request);
  if (owner.via === "bearer") return owner;
  const { rows } = await executeExomemSql`
    SELECT cell_id, desired_state FROM exomem_cloud_cells
    WHERE tenant_id = ${owner.tenantId}::uuid AND desired_state <> 'deleted'
  `;
  if (!rows[0]) throw notFound();
  return {
    userId: owner.userId,
    tenantId: owner.tenantId,
    cellId: String(rows[0].cell_id),
    cellDesiredState: String(rows[0].desired_state),
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw exomemErrors.invalidRequest();
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw exomemErrors.invalidRequest();
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !validUuid(value)) throw exomemErrors.invalidRequest();
  return value.toLowerCase();
}

function report(body: Record<string, unknown>) {
  // SHA-256 uses exactly 64 hexadecimal characters; this checks format only.
  if (
    typeof body.ciphertext_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(body.ciphertext_sha256)
  ) {
    throw exomemErrors.invalidRequest();
  }
  return {
    ciphertext_sha256: body.ciphertext_sha256.toLowerCase(),
    ciphertext_bytes: count(body.ciphertext_bytes),
  };
}

function partETags(value: unknown): PartETag[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMPORT_PARTS)
    throw exomemErrors.invalidRequest();
  const seen = new Set<number>();
  const parts = value.map((value) => {
    const part = objectBody(value);
    if (
      Object.keys(part).length !== 2 ||
      !Number.isInteger(part.part_number) ||
      typeof part.part_number !== "number" ||
      part.part_number < 1 ||
      part.part_number > MAX_IMPORT_PARTS ||
      typeof part.etag !== "string" ||
      !part.etag ||
      part.etag.length > 1024 ||
      seen.has(part.part_number)
    ) {
      throw exomemErrors.invalidRequest();
    }
    seen.add(part.part_number);
    return { part_number: part.part_number, etag: part.etag };
  });
  return parts.sort((a, b) => a.part_number - b.part_number);
}

function storedCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("import count exceeds JSON integer precision");
  return parsed;
}

function storage(cell: CellRow): ImportStorage {
  return {
    storage_gib: cell.storage_gib,
    grown_storage_gib: cell.grown_storage_gib,
    used_bytes: cell.used_bytes === null ? null : storedCount(cell.used_bytes),
    filesystem_bytes: cell.filesystem_bytes === null ? null : storedCount(cell.filesystem_bytes),
    observed_storage_capacity_bytes:
      cell.observed_storage_capacity_bytes === null
        ? null
        : storedCount(cell.observed_storage_capacity_bytes),
    usage_observed_at: cell.usage_observed_at?.toISOString() ?? null,
  };
}

function limits(cell: CellRow) {
  return calculateImportAdmission(cell.import_limits, storage(cell), 0, 0)
    ? cell.import_limits
    : null;
}

function status(row: ImportRow, cell: CellRow): CloudImport {
  const required = row.required_storage_gib === null ? null : row.required_storage_gib * IMPORT_GIB;
  // The controller publishes this generation receipt only after resize conditions clear.
  const storageReady =
    required === null
      ? null
      : Boolean(
          cell.observed_storage_capacity_bytes !== null &&
          storedCount(cell.observed_storage_capacity_bytes) >= required &&
          cell.observed_storage_generation === cell.generation &&
          cell.observed_storage_pvc_uid &&
          cell.observed_storage_pvc_version &&
          cell.observed_storage_at
        );
  const staged =
    row.observed_state === "done" &&
    row.requested_state !== "cancelled" &&
    row.requested_state !== "discard_requested";

  return {
    import_id: row.import_id,
    kind: row.kind,
    declared_bytes: storedCount(row.declared_bytes),
    declared_files: storedCount(row.declared_files),
    requested_state: row.requested_state,
    observed_state: row.observed_state ?? "pending",
    recipient: row.recipient,
    part_urls: row.part_urls,
    urls_expire_at: row.urls_expire_at?.toISOString() ?? null,
    error_code: row.error_code,
    ciphertext_sha256: row.ciphertext_sha256,
    ciphertext_bytes: row.ciphertext_bytes === null ? null : storedCount(row.ciphertext_bytes),
    required_storage_bytes: required,
    storage_ready: storageReady,
    staged_files: staged && row.staged_files !== null ? storedCount(row.staged_files) : null,
    staged_bytes: staged && row.staged_bytes !== null ? storedCount(row.staged_bytes) : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function readCloudImport(principal: CloudImportPrincipal, importId?: string) {
  const id = importId === undefined ? null : uuid(importId);
  // Migration 0061 fixes the open predicate; default status prefers unfinished work over history.
  const { rows } = await executeExomemSql`
    SELECT request.*, cell.import_limits, cell.storage_gib, cell.grown_storage_gib,
      cell.used_bytes, cell.filesystem_bytes, cell.usage_observed_at, cell.generation,
      cell.observed_storage_capacity_bytes, cell.observed_storage_generation,
      cell.observed_storage_pvc_uid, cell.observed_storage_pvc_version, cell.observed_storage_at
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    LEFT JOIN LATERAL (
      SELECT * FROM exomem_cloud_imports AS request
      WHERE request.cell_id = cell.cell_id AND (${id}::uuid IS NULL OR request.import_id = ${id}::uuid)
      ORDER BY (request.observed_state IS NULL
        OR request.observed_state IN ('key_ready', 'importing', 'cleanup_running', 'cleanup_stopping', 'cleanup_discard_stopping', 'cleanup_pending')
        OR (request.requested_state = 'discard_requested' AND request.observed_state IS DISTINCT FROM 'discarded')) DESC,
        request.created_at DESC, request.import_id DESC LIMIT 1
    ) AS request ON true
    WHERE cell.cell_id = ${principal.cellId} AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted') AND cell.desired_state <> 'deleted'
  `;
  const row = rows[0] as (ImportRow & CellRow) | undefined;
  if (!row || (!row.import_id && id)) throw notFound();
  return {
    import: row.import_id ? status(row, row) : null,
    limits: limits(row),
    storage: storage(row),
  };
}

async function lockCell(tx: ExomemSql, principal: CloudImportPrincipal, writable: boolean) {
  const { rows } = await tx`
    SELECT cell.desired_state, cell.import_limits, cell.storage_gib, cell.grown_storage_gib,
      cell.used_bytes, cell.filesystem_bytes, cell.usage_observed_at, cell.generation,
      cell.observed_storage_capacity_bytes, cell.observed_storage_generation,
      cell.observed_storage_pvc_uid, cell.observed_storage_pvc_version, cell.observed_storage_at
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.cell_id = ${principal.cellId} AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted') AND cell.desired_state <> 'deleted'
    FOR UPDATE OF cell
  `;
  if (!rows[0]) throw notFound();
  if (writable && !cloudImportAvailable(rows[0].desired_state))
    throw exomemErrors.entitlementDenied();
  return rows[0] as CellRow;
}

export async function mutateCloudImport(
  principal: CloudImportPrincipal,
  action: Exclude<CloudImportAction, "status">,
  value: unknown,
  importId?: string
) {
  // These keys and kinds are the closed C5 HTTP protocol, not inferred tenant vocabulary.
  const body = action === "cancel" || action === "discard" ? {} : objectBody(value);
  const keys =
    action === "create"
      ? ["import_id", "kind", "declared_bytes", "declared_files"]
      : action === "complete"
        ? ["part_etags", "ciphertext_sha256", "ciphertext_bytes"]
        : ["ciphertext_sha256", "ciphertext_bytes"];
  if (Object.keys(body).some((key) => !keys.includes(key))) throw exomemErrors.invalidRequest();
  const id =
    action === "create"
      ? body.import_id === undefined
        ? randomUUID()
        : uuid(body.import_id)
      : uuid(importId);
  const creation =
    action === "create"
      ? {
          kind: body.kind,
          declared_bytes: count(body.declared_bytes),
          declared_files: count(body.declared_files),
        }
      : null;
  if (creation && creation.kind !== "adopt" && creation.kind !== "archive_members")
    throw exomemErrors.invalidRequest();
  const prepared = action === "prepare-upload" || action === "complete" ? report(body) : null;
  const parts = action === "complete" ? partETags(body.part_etags) : null;
  try {
    return await withExomemTransaction(async (tx) => {
      let cell = await lockCell(tx, principal, action === "create" || prepared !== null);
      const reply = (row: ImportRow, created = false) => ({
        import: status(row, cell),
        created,
        limits: limits(cell),
        storage: storage(cell),
      });
      const existing = await tx`
        SELECT * FROM exomem_cloud_imports
        WHERE import_id = ${id}::uuid AND cell_id = ${principal.cellId} FOR UPDATE
      `;
      const row = existing.rows[0] as ImportRow | undefined;
      if (creation) {
        if (row) {
          if (
            row.kind !== creation.kind ||
            storedCount(row.declared_bytes) !== creation.declared_bytes ||
            storedCount(row.declared_files) !== creation.declared_files
          )
            throw conflict();
          return reply(row);
        }
        const admission = calculateImportAdmission(
          cell.import_limits,
          storage(cell),
          creation.declared_bytes,
          creation.declared_files
        );
        if (admission?.refusal) {
          throw importError(
            admission.refusal.code,
            422,
            "the import exceeds a published limit",
            admission.refusal.limit
          );
        }
        if (admission) {
          const grown = await tx`
            UPDATE exomem_cloud_cells SET storage_gib = GREATEST(storage_gib, ${admission.required_storage_gib})
            WHERE cell_id = ${principal.cellId} RETURNING *
          `;
          cell = grown.rows[0] as CellRow;
        }
        const inserted = await tx`
          INSERT INTO exomem_cloud_imports (import_id, cell_id, kind, declared_bytes, declared_files, required_storage_gib)
          VALUES (${id}::uuid, ${principal.cellId}, ${creation.kind}, ${creation.declared_bytes}, ${creation.declared_files}, ${admission?.required_storage_gib ?? null})
          RETURNING *
        `;
        return reply(inserted.rows[0] as ImportRow, true);
      }
      if (!row) throw notFound();
      if (prepared) {
        if (
          row.ciphertext_sha256 !== null &&
          (row.ciphertext_sha256 !== prepared.ciphertext_sha256 ||
            storedCount(row.ciphertext_bytes!) !== prepared.ciphertext_bytes)
        )
          throw conflict();
        if (action === "prepare-upload" && row.ciphertext_sha256 !== null) {
          return reply(row);
        }
        if (action === "prepare-upload" && row.ciphertext_sha256 === null) {
          const parsed = importPartLimits.safeParse(cell.import_limits);
          // A wrong refusal costs a valid upload; only the published multipart ceiling prevents wasted transfer.
          if (
            parsed.success &&
            prepared.ciphertext_bytes > parsed.data.max_parts * parsed.data.part_bytes
          ) {
            throw importError(
              "IMPORT_PARTS_LIMIT",
              422,
              "the encrypted upload exceeds a published limit",
              {
                unit: "bytes",
                value: parsed.data.max_parts * parsed.data.part_bytes,
                requested: prepared.ciphertext_bytes,
              }
            );
          }
        }
        if (parts && row.part_etags !== null) {
          if (
            row.part_etags.length !== parts.length ||
            row.part_etags.some(
              (part, index) =>
                part.part_number !== parts[index].part_number || part.etag !== parts[index].etag
            )
          )
            throw conflict();
          return reply(row);
        }
        if (
          row.requested_state !== "requested" ||
          row.observed_state !== "key_ready" ||
          !row.recipient
        )
          throw conflict();
        if (parts) {
          const issuedParts = row.part_urls?.map((part) => part.part_number).sort((a, b) => a - b);
          if (
            row.ciphertext_sha256 === null ||
            !row.upload_id ||
            !issuedParts ||
            !row.urls_expire_at ||
            new Date(row.urls_expire_at).getTime() <= Date.now() ||
            issuedParts.length !== parts.length ||
            issuedParts.some((partNumber, index) => parts[index].part_number !== partNumber)
          ) {
            throw conflict();
          }
        }
        const updated = await tx`
          UPDATE exomem_cloud_imports
          SET ciphertext_sha256 = ${prepared.ciphertext_sha256}, ciphertext_bytes = ${prepared.ciphertext_bytes},
              part_etags = ${parts === null ? null : JSON.stringify(parts)}::jsonb,
              requested_state = ${parts ? "uploaded" : "requested"}
          WHERE import_id = ${id}::uuid AND cell_id = ${principal.cellId} RETURNING *
        `;
        return reply(updated.rows[0] as ImportRow);
      }
      const requested = action === "cancel" ? "cancelled" : "discard_requested";
      if (row.requested_state === requested) return reply(row);
      // C5 fixes terminal observations; cancellation must never invent one.
      if (
        action === "cancel" &&
        (row.requested_state === "discard_requested" ||
          ["done", "failed", "expired", "discarded"].includes(row.observed_state ?? ""))
      )
        throw conflict();
      const updated = await tx`
        UPDATE exomem_cloud_imports SET requested_state = ${requested}
        WHERE import_id = ${id}::uuid AND cell_id = ${principal.cellId} RETURNING *
      `;
      return reply(updated.rows[0] as ImportRow);
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505")
      throw conflict();
    throw error;
  }
}
