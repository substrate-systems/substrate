import { z } from "zod";

const count = z.number().int().nonnegative().safe();

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
  staged_files: count.nullable().optional(),
  staged_bytes: count.nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export const cloudImportReply = z.object({ import: cloudImport.nullable() });
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
