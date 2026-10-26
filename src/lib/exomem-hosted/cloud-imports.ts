import { randomUUID } from "node:crypto";
import { validate as validUuid } from "uuid";
import {
  cloudImportAvailable,
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
  created_at: Date;
  updated_at: Date;
};

function importError(code: string, status: number, message: string): ExomemHostedError {
  return new ExomemHostedError({ code, status, message });
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

function status(row: ImportRow): CloudImport {
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
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function readCloudImport(principal: CloudImportPrincipal, importId?: string) {
  const id = importId === undefined ? null : uuid(importId);
  // Migration 0061 fixes the open predicate; default status prefers unfinished work over history.
  const { rows } = await executeExomemSql`
    SELECT request.* FROM exomem_cloud_imports AS request
    JOIN exomem_cloud_cells AS cell ON cell.cell_id = request.cell_id
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.cell_id = ${principal.cellId} AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted') AND cell.desired_state <> 'deleted'
      AND (${id}::uuid IS NULL OR request.import_id = ${id}::uuid)
    ORDER BY (request.observed_state IS NULL
      OR request.observed_state IN ('key_ready', 'importing', 'cleanup_running', 'cleanup_stopping', 'cleanup_discard_stopping', 'cleanup_pending')
      OR (request.requested_state = 'discard_requested' AND request.observed_state IS DISTINCT FROM 'discarded')) DESC,
      request.created_at DESC, request.import_id DESC LIMIT 1
  `;
  if (!rows[0] && id) throw notFound();
  return rows[0] ? status(rows[0] as ImportRow) : null;
}

async function lockCell(tx: ExomemSql, principal: CloudImportPrincipal, writable: boolean) {
  const { rows } = await tx`
    SELECT cell.desired_state FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.cell_id = ${principal.cellId} AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted') AND cell.desired_state <> 'deleted'
    FOR UPDATE OF cell
  `;
  if (!rows[0]) throw notFound();
  if (writable && !cloudImportAvailable(rows[0].desired_state))
    throw exomemErrors.entitlementDenied();
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
      await lockCell(tx, principal, action === "create" || prepared !== null);
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
          return { import: status(row), created: false };
        }
        const inserted = await tx`
          INSERT INTO exomem_cloud_imports (import_id, cell_id, kind, declared_bytes, declared_files)
          VALUES (${id}::uuid, ${principal.cellId}, ${creation.kind}, ${creation.declared_bytes}, ${creation.declared_files})
          RETURNING *
        `;
        return { import: status(inserted.rows[0] as ImportRow), created: true };
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
          return { import: status(row), created: false };
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
          return { import: status(row), created: false };
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
        return { import: status(updated.rows[0] as ImportRow), created: false };
      }
      const requested = action === "cancel" ? "cancelled" : "discard_requested";
      if (row.requested_state === requested) return { import: status(row), created: false };
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
      return { import: status(updated.rows[0] as ImportRow), created: false };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505")
      throw conflict();
    throw error;
  }
}
