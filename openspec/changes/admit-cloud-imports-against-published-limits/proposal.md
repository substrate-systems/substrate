# Admit Cloud imports against published limits

## Why

An import has no admission check. Home encrypts and uploads a folder, and only then does the cell refuse it for too many members or too little free space. The cell's limits are fixed in its image and its controller, so no client can read them. A cell also cannot grow its volume for an import, so a folder larger than the free space fails after the whole upload.

## What changes

- Each cell publishes its effective import limits in C5, in a new `import_limits` column on the cell row. Cellctl writes it. Substrate, Home and the CLI read it.
- Import creation checks the declaration against the published limits in its existing transaction. It refuses with `IMPORT_TOO_MANY_FILES` or `IMPORT_STORAGE_LIMIT`. Prepare-upload refuses an upload that needs more than the published part ceiling with `IMPORT_PARTS_LIMIT`. Each refusal carries a typed `limit`.
- When the import needs more storage, creation raises the cell's `storage_gib` within the published cap and records the requirement on the import. The cell reports `key_ready` only after the volume has grown.
- The import row records the staged file and byte counts from the import Job's report.
- Home checks a folder against the published limits before it creates an import. It shows the wait while storage grows, and it shows staged and adopted counts.
- The follow-ups from the first Home import change (part receipts, error mapping, lock order, the `.gitignore` reason) go into `make-home-import-visible-and-resumable`.

## Decision

Cellctl publishes each cell's effective limits. Admission grows `storage_gib` within the published cap before `key_ready`. The `key_ready` observation waits for observed growth.

## Non-goals

- Plan-storage entitlement enforcement and the paid-storage baseline. The operator deferred both on 2026-10-26. Growth on demand can therefore take a vault of any plan up to the published cap.
- Adopted counts in C5. Adoption Studio files the staged notes after C5 reports `done`, so Home reads that count through the existing owner channel.

## Capabilities

### Modified Capabilities

- `exomem-tenant-control-plane`: Add the C5 limit, requirement and staged fields, the admission order, the refusal codes, and growth at creation.
- `exomem-home`: Check a folder against the published limits, show the wait for growth, and show staged and adopted counts.

## Impact

The change adds migration 0079, the grants script, the C5 types, the import API handlers and the Home import dialog. The paired Exomem change `publish-cloud-import-limits` adds the cellctl, image and CLI side. The Cloud control-plane owner reviews the migration and the C5 text.

Archive order: the C5 requirements that this change builds on exist only in the active change `add-cloud-vault-import`. The Home requirement that it modifies exists only in `make-home-import-visible-and-resumable`. Archive both of those first. Then archive this change.
