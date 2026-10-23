import { z } from "zod";

const count = z.number().int().nonnegative().safe();

export const importUploadPart = z.object({
  part_number: z.number().int().positive(),
  url: z.url(),
  part_size_bytes: z.number().int().positive().safe(),
});

/** C5 owns these wire fields. Unknown controller states remain visible to newer clients. */
export const cloudImport = z.object({
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
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export const cloudImportReply = z.object({ import: cloudImport.nullable() });
export type CloudImport = z.infer<typeof cloudImport>;
export type UploadPart = z.infer<typeof importUploadPart>;
