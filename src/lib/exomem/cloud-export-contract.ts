import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime({ offset: true });

/**
 * C6's export display as `GET` and `POST /api/exomem/cloud/exports` answer it
 * (`CloudExportSummary` in cloud-exports.ts produces it). The states are the
 * closed C6 set. A reader that is not the web server parses the answer here.
 */
const cloudExport = z
  .object({
    state: z.enum(["none", "packing", "ready", "expired", "failed"]),
    export_id: z.uuid().optional(),
    requested_at: timestamp.optional(),
    ready_at: timestamp.optional(),
    // Null on an export that a newer one replaced.
    expires_at: timestamp.nullable().optional(),
    archive_bytes: count.nullable().optional(),
    archive_sha256: z.string().optional(),
    error_code: z.string().optional(),
    pauses_assistants: z.boolean(),
  })
  .refine((view) => view.state === "none" || view.export_id !== undefined);

export const cloudExportReply = z.object({ export: cloudExport });
export type CloudExport = z.infer<typeof cloudExport>;
