## ADDED Requirements

### Requirement: Cells publish their import limits in C5

Cellctl SHALL write `exomem_cloud_cells.import_limits` for each live cell whose storage has passed its rollout gate. It SHALL rewrite the value only when its content changes. Cellctl SHALL inspect the actual claim class and actively write NULL for local claims until authoritative shared capacity accounting and the local rehearsal pass. This SHALL clear any previously published object. Local publication and import growth SHALL remain open work in the paired Exomem task 1.7. The value SHALL be a JSON object, or NULL when the cell has published nothing. Its keys SHALL be `max_members`, `reserve_bytes`, `space_factor`, `max_storage_gib`, `part_bytes`, `max_parts`, `upload_window_seconds`, `import_deadline_seconds` and `import_growth_deadline_seconds`, each a positive integer. Readers SHALL ignore keys they do not use. A reader SHALL treat the value as unpublished when it is not an object, or when a key that the reader needs is missing or invalid. `max_storage_gib` SHALL be at least the cell's current size, `max(storage_gib, grown_storage_gib)`. Only cellctl SHALL write the column, and a write SHALL NOT change the cell's generation.

#### Scenario: Cellctl publishes a changed limit

- **WHEN** cellctl observes that a live cell's limits differ from its `import_limits`
- **THEN** it writes the new object
- **AND** the cell's generation does not change and no notification is sent

#### Scenario: Substrate writes the limits

- **WHEN** Substrate attempts to write `import_limits`
- **THEN** PostgreSQL rejects the write, including after the grants script runs again

#### Scenario: A paid cell is larger than the usual cap

- **WHEN** a cell's current size is above the configured cap
- **THEN** its published `max_storage_gib` equals that current size
- **AND** an import is never refused only because of the configured cap

#### Scenario: The limits cannot be parsed

- **WHEN** `import_limits` is not an object, or lacks a key that the reader needs
- **THEN** the reader treats the limits as unpublished and applies no limit of its own

#### Scenario: Local import growth has not passed its cutover

- **WHEN** the actual claim class is local and authoritative shared capacity accounting or the local rehearsal remains incomplete
- **THEN** cellctl writes `import_limits` NULL, including replacing an earlier object
- **AND** legacy admission leaves `required_storage_gib` NULL, with desired storage, grown storage and generation unchanged

### Requirement: Import records carry the storage they require and the files they staged

C5 SHALL add `required_storage_gib` (integer greater than 0), `staged_files` and `staged_bytes` (not negative) to `exomem_cloud_imports`. Each column SHALL be nullable, and `staged_files` and `staged_bytes` SHALL be both set or both NULL. Substrate SHALL write `required_storage_gib` at INSERT only. Cellctl SHALL persist a valid successful Job report's staged counts before cleanup removes the reporting Pods. The pair SHALL remain a historical staging observation if later cancellation, failure or expiry prevents successful completion. Missing or malformed reports SHALL leave both counts unknown without blocking cleanup. The touch trigger SHALL make `required_storage_gib` immutable, and SHALL make each staged column immutable once set. The gateway SHALL have no access to these columns. The migration SHALL be additive, so a deployed cellctl that does not know the columns keeps working.

#### Scenario: A role writes outside its columns

- **WHEN** Substrate writes `staged_files`, or cellctl writes `required_storage_gib`
- **THEN** PostgreSQL rejects the write, including after the grants script runs again

#### Scenario: A recorded value changes

- **WHEN** an update changes `required_storage_gib`, or changes a staged column that is already set
- **THEN** the trigger rejects the update

#### Scenario: The deployed cellctl updates an import

- **WHEN** a cellctl that does not know the new columns updates `observed_state` or `part_urls`
- **THEN** the update succeeds and the new columns keep their values

#### Scenario: Only one staged count is written

- **WHEN** an update sets `staged_files` without `staged_bytes`
- **THEN** PostgreSQL rejects the update

### Requirement: Import creation is admitted against the published limits

Creation SHALL run these steps in order inside its existing transaction, with the cell row locked:

1. Validate the body (400), resolve the owner and the cell (404), and require a running cell (403).
2. When the import ID exists with identical declarations, return the stored import. Run no later step and write no growth.
3. When the limits are unpublished, insert the import with `required_storage_gib` NULL and reply `limits: null`.
4. When `declared_files` exceeds `max_members`, refuse with 422 `IMPORT_TOO_MANY_FILES`.
5. When `space_factor × declared_bytes + reserve_bytes` exceeds the cap in bytes, refuse with 422 `IMPORT_STORAGE_LIMIT`.
6. Raise `storage_gib` with `GREATEST(storage_gib, required_storage_gib)`, then insert the import with that requirement.

The storage need SHALL be `used + space_factor × declared_bytes + reserve_bytes`, scaled by the ratio of `observed_storage_capacity_bytes` to `filesystem_bytes`. The cell's `used_bytes` and `filesystem_bytes` readings come from migration 0066; its observed capacity comes from migration 0071. A recorded usage reading SHALL count regardless of its age. When `used_bytes` is unknown, the need SHALL treat the whole current volume as used with a ratio of 1. The ratio SHALL affect only the growth estimate. The necessary-only refusal SHALL use the unscaled lower bound `space_factor × declared_bytes + reserve_bytes`, so a filesystem reading from before growth cannot refuse an import that fits.

One pure function SHALL compute the need and `required_storage_gib = min(ceil(need / GiB), max_storage_gib)`, where one GiB is 1,073,741,824 bytes. The API and Home SHALL both use that function with the cell readings and the published limits. The recorded requirement SHALL be the clamped target, never the unclamped need.

#### Scenario: A client retries a creation

- **WHEN** a client creates an import with an ID and declarations that match a stored import
- **THEN** the stored import returns, with no limit check and no growth

#### Scenario: The cell has published no limits

- **WHEN** a client creates an import for a cell whose limits are unpublished
- **THEN** the import is inserted as before with `required_storage_gib` NULL
- **AND** the reply carries `limits: null` and the cell's storage is unchanged

#### Scenario: The folder has too many files

- **WHEN** `declared_files` is above `max_members`
- **THEN** creation returns 422 `IMPORT_TOO_MANY_FILES` and inserts nothing

#### Scenario: The declared files fit but the folders do not

- **WHEN** `declared_files` is within `max_members` and the archive's folders raise its member count above the limit
- **THEN** creation accepts the declaration, because it counts files only
- **AND** the cell's exact count refuses the archive later

#### Scenario: The import can never fit

- **WHEN** the unscaled empty-vault lower bound is above the cap in bytes
- **THEN** creation returns 422 `IMPORT_STORAGE_LIMIT` and inserts nothing

#### Scenario: Existing content leaves too little room

- **WHEN** the unscaled empty-vault lower bound fits the cap, but the growth estimate exceeds it
- **THEN** creation raises `storage_gib` to the cap and inserts the import
- **AND** `required_storage_gib` equals the cap, so the import reaches `key_ready` after that growth
- **AND** the cell refuses insufficient free space at import time with its own free-space code

#### Scenario: Usage was recorded before a resize

- **WHEN** a cell grew from 2 GiB to 20 GiB and still reports its earlier 1.9 GiB filesystem reading
- **AND** the import holds 1 GiB, with space factor 2 and reserve 256 MiB
- **THEN** admission compares the unscaled 2.25 GiB lower bound with the 20 GiB cap and accepts
- **AND** the stale ratio can increase only the clamped growth estimate

#### Scenario: A concurrent import holds the open slot

- **WHEN** admission has raised `storage_gib` and the insert fails on the open-import index
- **THEN** the transaction rolls back and `storage_gib` keeps its earlier value

### Requirement: Admission grows storage within the published cap before the key exists

Admission SHALL raise `storage_gib` with `GREATEST(storage_gib, required_storage_gib)`, so it SHALL never lower a size and SHALL never exceed `max_storage_gib`. It SHALL record the clamped target as `required_storage_gib`. Cellctl SHALL NOT write `recipient` or report `key_ready` for an import that has a `required_storage_gib` until the cell's observed capacity covers it with no resize pending. While it waits, cellctl SHALL leave the cell mounted and running. A brief cell restart that the raise causes SHALL count as waiting, not as failure. When the claim has not grown within `import_growth_deadline_seconds` of the import's creation, cellctl SHALL fail the import with `IMPORT_STORAGE_UNAVAILABLE`. For a local-storage cell, cellctl SHALL check the node's room again before it reports `key_ready`. It SHALL fail the import with `IMPORT_STORAGE_NO_ROOM` when the node cannot hold the size. Before any larger local claim request, cellctl SHALL check the node's room. If room is unavailable, it SHALL retain the last accepted claim request, including during cleanup and later reconciliation. The desired `storage_gib` SHALL stay raised, and cellctl SHALL NOT lower a claim. Unknown room SHALL leave growth waiting until its deadline. Known insufficient room SHALL fail the import with `IMPORT_STORAGE_NO_ROOM`. Local import growth SHALL ship only after authoritative capacity accounting shared by local volume consumers and this behavior pass the local cutover check. Until that gate passes, cellctl SHALL actively publish NULL for local claims.

#### Scenario: The volume grows

- **WHEN** admission raised `storage_gib` and the claim has expanded
- **THEN** cellctl reports `key_ready` with the recipient
- **AND** no earlier observation carries a recipient

#### Scenario: The raise restarts the cell

- **WHEN** the cell pod restarts while the claim expands
- **THEN** the import stays pending, not failed, until the deadline

#### Scenario: The volume does not grow in time

- **WHEN** `import_growth_deadline_seconds` pass after creation without the required capacity
- **THEN** cellctl fails the import with `IMPORT_STORAGE_UNAVAILABLE` through its ordinary cleanup

#### Scenario: A local node has no room

- **WHEN** a local-storage cell's node cannot hold the required size at `key_ready`
- **THEN** cellctl fails the import with `IMPORT_STORAGE_NO_ROOM` and mints no key
- **AND** the claim keeps its last accepted request while desired `storage_gib` stays raised
- **AND** cleanup and later reconciliation request no larger local claim until the node can hold it

### Requirement: Prepare-upload refuses ciphertext beyond the part ceiling

On the first report of an import, prepare-upload SHALL refuse a `ciphertext_bytes` above `max_parts × part_bytes` with 422 `IMPORT_PARTS_LIMIT`. A replayed report SHALL return the stored import unchanged and run no new check. Prepare-upload SHALL run no check when the limits are unpublished.

#### Scenario: The encrypted size needs too many parts

- **WHEN** the first report's `ciphertext_bytes` is above `max_parts × part_bytes`
- **THEN** prepare-upload returns 422 `IMPORT_PARTS_LIMIT` and freezes no digest

#### Scenario: A client repeats an accepted report

- **WHEN** a client repeats a report that prepare-upload already accepted
- **THEN** it returns the stored import unchanged

### Requirement: Admission refusals carry a typed, content-free limit

The error envelope of `IMPORT_TOO_MANY_FILES`, `IMPORT_STORAGE_LIMIT` and `IMPORT_PARTS_LIMIT` SHALL carry `limit`, an object with `unit` (`files` or `bytes`), `value` and `requested`. `value` and `requested` SHALL be non-negative integers. `limit` SHALL carry no content from the import. A client that does not know `limit` SHALL still parse the envelope.

#### Scenario: A refusal names its limit

- **WHEN** admission refuses an import with 422
- **THEN** the envelope carries the code and `limit` with the unit, the limit and the requested amount
- **AND** it names no file, path or folder

### Requirement: Import replies carry the limits, the growth state and the staged counts

`GET /api/exomem/cloud/imports` and the creation reply SHALL carry `limits`, the cell's published object or null, beside `import`. The reply SHALL also carry nullable `storage` with `storage_gib`, `grown_storage_gib`, `observed_storage_capacity_bytes`, `used_bytes`, `filesystem_bytes` and `usage_observed_at`, read through the same owner scope. Unknown readings SHALL remain null. Home SHALL use these readings for the shared calculation. Each import SHALL carry `required_storage_bytes` (null when not required), `storage_ready` (null when not required), `staged_files` and `staged_bytes` (null when not recorded). Replies SHALL expose staged counts only when `observed_state` is `done` without pending cancellation or discard; otherwise both SHALL be null. `storage_ready` SHALL be true only when the cell's observed capacity covers `required_storage_bytes` and its storage receipt shows no resize pending. Replies SHALL stay readable to clients that predate these fields.

#### Scenario: Cancellation follows successful staging

- **WHEN** the row holds staged counts and newer cancellation or discard intent prevents successful completion
- **THEN** the row retains its immutable historical counts, but the import reply returns both counts as null

#### Scenario: An import waits for growth

- **WHEN** the claim has not yet grown to `required_storage_bytes`
- **THEN** the import reports `storage_ready` false and its observed state stays `pending`

#### Scenario: An older client reads a reply

- **WHEN** a client that predates these fields reads an import
- **THEN** it ignores the new fields and reads the others as before

#### Scenario: Home reads the admission context

- **WHEN** the owner reads imports before creating one
- **THEN** the reply carries the cell's published limits and calculator readings even when no import exists
- **AND** a reply that omits the new optional fields still parses
