import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
export const IMPORT_GIB = 1024 ** 3;

// These keys and units are the additive C5 protocol, not tenant vocabulary.
const admissionLimits = z.object({
  max_members: positive,
  reserve_bytes: positive,
  space_factor: positive,
  max_storage_gib: positive,
});
export const importPartLimits = z.object({ part_bytes: positive, max_parts: positive });
export const homeImportLimits = admissionLimits.extend({
  import_growth_deadline_seconds: positive,
});
export const importLimit = z.object({
  unit: z.enum(["files", "bytes"]),
  value: count,
  requested: count,
});
export type ImportLimit = z.infer<typeof importLimit>;

const importStorage = z.object({
  storage_gib: positive,
  grown_storage_gib: positive.nullable(),
  used_bytes: count.nullable(),
  filesystem_bytes: positive.nullable(),
  observed_storage_capacity_bytes: positive.nullable(),
  usage_observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type ImportStorage = z.infer<typeof importStorage>;

/** Shared admission: stale usage can size growth, but only an empty-vault lower bound refuses. */
export function calculateImportAdmission(
  published: unknown,
  storage: ImportStorage,
  declaredBytes: number,
  members: number
) {
  const parsed = admissionLimits.safeParse(published);
  if (!parsed.success) return null;
  const limits = parsed.data;
  const current = Math.max(storage.storage_gib, storage.grown_storage_gib ?? 0) * IMPORT_GIB;
  const ratio =
    storage.used_bytes !== null &&
    storage.filesystem_bytes &&
    storage.observed_storage_capacity_bytes
      ? storage.observed_storage_capacity_bytes / storage.filesystem_bytes
      : 1;
  const lowerBound = limits.space_factor * declaredBytes + limits.reserve_bytes;
  const need = Math.ceil(((storage.used_bytes ?? current) + lowerBound) * ratio);
  const cap = limits.max_storage_gib * IMPORT_GIB;
  // Wrong refusals cost owners a valid import; only necessary limits may prevent wasted transfer.
  const refusal =
    members > limits.max_members
      ? {
          code: "IMPORT_TOO_MANY_FILES" as const,
          limit: { unit: "files" as const, value: limits.max_members, requested: members },
        }
      : lowerBound > cap
        ? {
            code: "IMPORT_STORAGE_LIMIT" as const,
            limit: { unit: "bytes" as const, value: cap, requested: lowerBound },
          }
        : null;
  return {
    limits,
    need_bytes: need,
    current_storage_bytes: current,
    required_storage_gib: Math.min(Math.ceil(need / IMPORT_GIB), limits.max_storage_gib),
    refusal,
  };
}

/** S3's multipart protocol fixes this maximum number of numbered parts. */
export const MAX_IMPORT_PARTS = 10_000;

const importUploadPart = z.object({
  part_number: z.number().int().positive(),
  url: z.url(),
  part_size_bytes: z.number().int().positive().safe(),
});

/** C5 owns these wire fields. Unknown controller states remain visible to newer clients. */
const cloudImport = z.object({
  import_id: z.uuid(),
  kind: z.string(),
  declared_bytes: count,
  declared_files: count,
  requested_state: z.string(),
  observed_state: z.string(),
  recipient: z.string().nullable(),
  part_urls: z.array(importUploadPart).nullable(),
  urls_expire_at: z.iso.datetime({ offset: true }).nullable(),
  error_code: z.string().nullable(),
  ciphertext_sha256: z.string().nullable(),
  ciphertext_bytes: count.nullable(),
  required_storage_bytes: count.nullable().optional(),
  storage_ready: z.boolean().nullable().optional(),
  staged_files: count.nullable().optional(),
  staged_bytes: count.nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export const cloudImportReply = z.object({
  import: cloudImport.nullable(),
  limits: z.record(z.string(), z.unknown()).nullable().optional(),
  storage: importStorage.nullable().optional(),
});
export type CloudImportReply = z.infer<typeof cloudImportReply>;
export type CloudImport = z.infer<typeof cloudImport>;
export type UploadPart = z.infer<typeof importUploadPart>;

/** C5 permits import creation and completion only for a running desired cell state. */
export function cloudImportAvailable(desiredState: unknown): boolean {
  return desiredState === "running";
}

/**
 * Whether an import has stopped changing. A discard that the controller has
 * not yet observed keeps it open. The terminal observations are C5 protocol
 * states fixed by migration 0061, and migration 0061's open-import index is
 * their complement.
 */
export function cloudImportFinished(
  operation: Pick<CloudImport, "requested_state" | "observed_state">
): boolean {
  if (operation.requested_state === "discard_requested" && operation.observed_state !== "discarded")
    return false;
  return ["done", "failed", "expired", "discarded"].includes(operation.observed_state);
}

/** C5's adopt command stages the files here; the import's UUID names the folder. */
export function stagedImportFolder(importId: string): string {
  return `_Imports/${importId}`;
}
