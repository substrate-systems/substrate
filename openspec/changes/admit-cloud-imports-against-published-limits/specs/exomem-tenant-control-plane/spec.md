## ADDED Requirements

### Requirement: Cells publish their import limits in C5

Cellctl SHALL write `exomem_cloud_cells.import_limits` for each live cell, and SHALL rewrite it only when its content changes. The value SHALL be a JSON object, or NULL when the cell has published nothing. Its keys SHALL be `max_members`, `reserve_bytes`, `space_factor`, `max_storage_gib`, `part_bytes`, `max_parts`, `upload_window_seconds`, `import_deadline_seconds` and `import_growth_deadline_seconds`, each a positive integer. Readers SHALL ignore keys they do not use. A reader SHALL treat the value as unpublished when it is not an object, or when a key that the reader needs is missing or invalid. `max_storage_gib` SHALL be at least the cell's current size, `max(storage_gib, grown_storage_gib)`. Only cellctl SHALL write the column, and a write SHALL NOT change the cell's generation.

#### Scenario: Cellctl publishes a changed limit

- **WHEN** cellctl observes that a live cell's limits differ from its `import_limits`
- **THEN** it writes the new object
- **AND** the cell's generation does not change and no notification is sent

#### Scenario: Substrate writes the limits

- **WHEN** Substrate attempts to write `import_limits`
- **THEN** PostgreSQL rejects the write

#### Scenario: A paid cell is larger than the usual cap

- **WHEN** a cell's current size is above the configured cap
- **THEN** its published `max_storage_gib` equals that current size
- **AND** an import is never refused only because of the configured cap

#### Scenario: The limits cannot be parsed

- **WHEN** `import_limits` is not an object, or lacks a key that the reader needs
- **THEN** the reader treats the limits as unpublished and applies no limit of its own

### Requirement: Import records carry the storage they require and the files they staged

C5 SHALL add `required_storage_gib` (integer greater than 0), `staged_files` and `staged_bytes` (not negative) to `exomem_cloud_imports`. Each column SHALL be nullable, and `staged_files` and `staged_bytes` SHALL be both set or both NULL. Substrate SHALL write `required_storage_gib` at INSERT only. Cellctl SHALL write `staged_files` and `staged_bytes` from the import Job's report when the Job succeeds. The touch trigger SHALL make `required_storage_gib` immutable, and SHALL make each staged column immutable once set. The gateway SHALL have no access to these columns. The migration SHALL be additive, so a deployed cellctl that does not know the columns keeps working.

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
5. When the storage need exceeds `max_storage_gib` even with no content in the vault, refuse with 422 `IMPORT_STORAGE_LIMIT`.
6. When the target size exceeds the cell's current size, raise `storage_gib`. Then insert the import with `required_storage_gib`.

The storage need SHALL be `used + space_factor × declared_bytes + reserve_bytes`, scaled by the ratio of the volume's observed capacity to its measured filesystem size. When `used_bytes` is unknown, the need SHALL treat the whole current volume as used. One pure function SHALL compute the need, and the API and Home SHALL both use it with parameters taken only from `import_limits`.

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

- **WHEN** the need with no vault content is above `max_storage_gib`
- **THEN** creation returns 422 `IMPORT_STORAGE_LIMIT` and inserts nothing

#### Scenario: Existing content leaves too little room

- **WHEN** the need with no vault content fits the cap, but the vault's used bytes push the full need above it
- **THEN** creation raises `storage_gib` to the cap and inserts the import
- **AND** the cell's own free-space check decides the outcome

#### Scenario: A concurrent import holds the open slot

- **WHEN** admission has raised `storage_gib` and the insert fails on the open-import index
- **THEN** the transaction rolls back and `storage_gib` keeps its earlier value

### Requirement: Admission grows storage within the published cap before the key exists

Admission SHALL raise `storage_gib` with `GREATEST(storage_gib, target)`, so it SHALL never lower a size and SHALL never exceed `max_storage_gib`. It SHALL record the target as `required_storage_gib`. Cellctl SHALL NOT write `recipient` or report `key_ready` for an import that has a `required_storage_gib` until the cell's observed capacity covers it with no resize pending. While it waits, cellctl SHALL leave the cell mounted and running. A brief cell restart that the raise causes SHALL count as waiting, not as failure. When the claim has not grown within `import_growth_deadline_seconds` of the import's creation, cellctl SHALL fail the import with `IMPORT_STORAGE_UNAVAILABLE`. For a local-storage cell, cellctl SHALL check the node's room again before it reports `key_ready`. It SHALL fail the import with `IMPORT_STORAGE_NO_ROOM` when the node cannot hold the size.

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

`GET /api/exomem/cloud/imports` and the creation reply SHALL carry `limits`, the cell's published object or null, beside `import`. Each import SHALL carry `required_storage_bytes` (null when not required), `storage_ready` (null when not required), `staged_files` and `staged_bytes` (null when not recorded). `storage_ready` SHALL be true only when the cell's observed capacity covers `required_storage_bytes` and its storage receipt shows no resize pending. Replies SHALL stay readable to clients that predate these fields.

#### Scenario: An import waits for growth

- **WHEN** the claim has not yet grown to `required_storage_bytes`
- **THEN** the import reports `storage_ready` false and its observed state stays `pending`

#### Scenario: An older client reads a reply

- **WHEN** a client that predates these fields reads an import
- **THEN** it ignores the new fields and reads the others as before
