## Context

See proposal.md. This change adds to C5, the import request contract of `add-cloud-vault-import`, and to the Home import flow of `make-home-import-visible-and-resumable`.

Current state, read from source on 2026-10-26:

- The cell image fixes the member count (500,000), the free-space reserve (256 MiB), names (255 bytes) and paths (4096 bytes). Cellctl fixes the part size (64 MiB), the 24-hour upload window and the 2-hour import hold. Substrate's `MAX_IMPORT_PARTS` is the S3 protocol's fixed 10,000.
- Only a local-storage cell has a size cap. Hetzner-only fleets have none.
- Creation has no admission. `mutateCloudImport` locks the cell row, then inserts the import or replays it. Prepare-upload is idempotent on the digest and size. Neither checks a size.
- Substrate may write `storage_gib` since migration 0071. The 0071 trigger bumps the cell's generation and notifies cellctl. A Hetzner cell renders `storage_gib` into its claim. A local cell renders the larger of `storage_gib` and `grown_storage_gib`.
- Paid storage already writes `GREATEST(storage_gib, target)` and waits for observed capacity before it reports success.
- Cellctl writes only `recipient`, `upload_id`, `part_urls`, `urls_expire_at`, `observed_state` and `error_code` on an import. The Job's `{files, bytes}` report is never stored.
- The deployed cellctl reads cells through an explicit column list and reads imports through a filter to its known fields. Additive columns do not reach it.

## Goals / Non-Goals

**Goals:**

- Refuse an import that cannot succeed before the owner encrypts and uploads it.
- Let an import that needs more storage grow the volume without an operator.
- Show the owner the limits, the wait and the counts that the system measured.

**Non-Goals:**

- Plan-storage entitlement enforcement and the paid-storage baseline. The operator deferred both on 2026-10-26. The consequence is in the risks below.
- Adopted counts in C5.
- Path and name limits. The cell keeps enforcing them, and Home does not preflight them.
- A refusal for a vault that is merely nearly full. A stale reading of `used_bytes` must not refuse an import that the cell can hold.

## Decisions

### D1. Cellctl publishes each cell's effective limits

Cellctl owns the values: it enforces them and renders them into the import Jobs. It writes them to `exomem_cloud_cells.import_limits`. A copy of any number in Substrate would drift, because the storage cap is operator configuration and a local cell's room depends on its node. Substrate branches on no storage-class name. It reads only `max_storage_gib`.

*Rejected: constants in Substrate.* They need a code change each time the operator changes a cap.

### D2. New C5 fields

All new columns are nullable. Migration 0079 adds them.

| Field                                               | Type                                      | Writer                                  | Readers                                  |
| --------------------------------------------------- | ----------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `exomem_cloud_cells.import_limits`                  | jsonb, CHECK object or NULL               | cellctl, observed, written on change    | Substrate admission, Home, the CLI       |
| `exomem_cloud_imports.required_storage_gib`         | integer, CHECK greater than 0             | Substrate at INSERT; immutable          | cellctl                                  |
| `exomem_cloud_imports.staged_files`, `staged_bytes` | bigint, CHECK not negative, both or neither | cellctl, from the Job's report; immutable once set | Home, the CLI |

The migration replaces `exomem_cloud_imports_touch` (`CREATE OR REPLACE`). The trigger compares OLD and NEW only for the new columns, so an update from the deployed cellctl, which never touches them, passes. `required_storage_gib` is always immutable. `staged_files` and `staged_bytes` are immutable once set.

Grants:

- Substrate gains INSERT on `required_storage_gib`. It gains no UPDATE on any new column. The cells INSERT column list stays as it is, so Substrate cannot write `import_limits`.
- Cellctl gains UPDATE on `staged_files`, `staged_bytes` and `import_limits`.
- The gateway gains nothing.
- The grants script guards each new column grant on the column's existence, as its other late columns are, because grants also run after a partial upgrade.

The cells touch trigger does not change. A write of `import_limits` bumps no generation and sends no notification.

`import_limits` keys are add-only, and each value is a positive integer:

| Key                              | Meaning                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `max_members`                    | The most archive members, files and folders, the cell accepts |
| `reserve_bytes`                  | Free space the cell keeps back while it unpacks              |
| `space_factor`                   | Multiplier that admission applies to the declared bytes      |
| `max_storage_gib`                | The largest volume this cell may have                        |
| `part_bytes`, `max_parts`        | The upload part size and the most parts                      |
| `upload_window_seconds`          | How long an upload may stay open                             |
| `import_deadline_seconds`        | How long the import hold may last                            |
| `import_growth_deadline_seconds` | How long cellctl waits for growth before the key exists       |

A reader treats a value as unpublished when it is not an object, or when a key that the reader needs is missing or invalid. Admission needs the first four keys for creation and the two part keys for prepare-upload. Home also needs the two deadline keys.

### D3. Admission at creation

Creation keeps its transaction and its cell-row lock. It runs these steps in order:

1. Validate the body (400), resolve the owner and the cell (404), and require a running cell (403). This step exists today.
2. When the import ID exists with identical declarations, return the stored import. Run no later step and write no growth. Different declarations still return 409.
3. When `import_limits` is unpublished, insert the import as today with `required_storage_gib` NULL, and reply with `limits: null`.
4. When `declared_files` exceeds `max_members`, refuse with 422 `IMPORT_TOO_MANY_FILES`. The check is necessary only: folders count as members, and the cell and the clients count exactly.
5. Compare the unscaled empty-vault lower bound (D4) with the cap in bytes. Refuse only when that lower bound exceeds it.
6. Raise `storage_gib` with `GREATEST(storage_gib, required_storage_gib)`, then insert the import with that clamped requirement. A unique-index conflict on the open-import slot (23505) rolls back the growth with the transaction.

Replay runs before every check, so a client that retries after a timeout cannot trigger a second growth or a refusal.

Prepare-upload keeps its flow. On the first report only, it refuses a `ciphertext_bytes` above `max_parts × part_bytes` with 422 `IMPORT_PARTS_LIMIT`. A replayed report returns the stored import unchanged.

### D4. One formula, shared with Home

A pure function in `src/lib/exomem/cloud-import-contract.ts` parses `import_limits` and computes the need and the target. The API and Home import it. Its parameters come only from `import_limits` and the cell's readings.

- The growth estimate is `used + space_factor × declared_bytes + reserve_bytes`, in filesystem bytes.
- The growth estimate is scaled by the ratio of `observed_storage_capacity_bytes` (0071) to `filesystem_bytes` (0066). That ratio estimates overhead but cannot decide refusal.
- `used_bytes` and `filesystem_bytes` come from the cell's 0066 usage reading. Its age alone does not discard it; stale usage sizes growth but cannot alone refuse admission.
- When `used_bytes` is unknown, the function sizes the import as if the whole current volume were used, with a ratio of 1.
- The current size is `max(storage_gib, grown_storage_gib)`.
- The function returns `required_storage_gib = min(ceil(need / GiB), max_storage_gib)`, where one GiB is 1,073,741,824 bytes.

The `IMPORT_STORAGE_LIMIT` check uses the unscaled lower bound `space_factor × declared_bytes + reserve_bytes`. A filesystem reading can predate a resize, so its capacity ratio never decides refusal. When existing content alone pushes the need above the cap, both the requested growth and the recorded requirement equal the cap. Growth can therefore reach `key_ready`, and the cell's own per-member free-space check decides. Refusing only when necessary keeps a stale `used_bytes` reading from blocking an import that the cell can hold.

### D5. Growth at creation, and `key_ready` waits for it

Admission writes the growth. Cellctl does not mint the import key until the claim has grown, so the owner never encrypts for a volume that cannot hold the archive. The exact wait, its deadline and its local-storage check belong to the Exomem change `publish-cloud-import-limits`. Before every larger local claim request, cellctl checks room and retains the last accepted request when it cannot grow. That includes cleanup and later ordinary reconciliation after a failed import. Desired `storage_gib` stays raised; no claim shrinks. Unknown room waits, while known insufficient room fails the import. The local cutover check must prove this before local import growth ships.

The raise changes the cell's render digest, so it restarts the cell pod once. Home shows that wait as the cell preparing the import, not as a fault.

Home and the status reply show the wait from two derived fields on the import:

- `required_storage_bytes` is `required_storage_gib` in bytes, or null.
- `storage_ready` is true when the cell's observed capacity covers `required_storage_bytes` and its storage receipt shows no resize pending. That is the same receipt that paid storage trusts: `observed_storage_capacity_bytes`, with `observed_storage_generation` equal to the cell's generation.

No new observed state exists. `key_ready` keeps its meaning.

### D6. Refusals

The three codes join the closed set of import protocol codes. Their error envelope gains an optional `limit`:

- `IMPORT_TOO_MANY_FILES`: `{unit: "files", value: max_members, requested: declared_files}`.
- `IMPORT_STORAGE_LIMIT`: `{unit: "bytes", value: the cap in bytes, requested: the unscaled empty-vault lower bound}`.
- `IMPORT_PARTS_LIMIT`: `{unit: "bytes", value: max_parts × part_bytes, requested: ciphertext_bytes}`.

`limit` holds numbers and a unit from a closed set. It carries no content from the import. A client that does not know `limit` still parses the envelope.

### D7. Replies

`GET /api/exomem/cloud/imports` and the create reply gain a top-level `limits`, the cell's published object or null. Each import gains `required_storage_bytes`, `storage_ready`, `staged_files` and `staged_bytes`. The zod schemas stay non-strict, so older clients ignore them.

### D8. Home

Home runs the shared function in its preflight, beside the checks from S1. It shows the member count against `max_members`, the storage need against the cap, and "grows to about N GB" when the need exceeds the current size. It refuses to start where admission would refuse. The vault warning from S1 now subtracts `reserve_bytes` from the free space.

With no published limits, Home says "limits not published; the cell checks during import". It substitutes no constant.

Home's wait for `key_ready` has no bound of its own. It follows the import's observed state, and it keeps polling at least as long as `import_growth_deadline_seconds`, which it reads from the limits. The CLI waits 7200 seconds per state, so the 60-minute default growth deadline expires first.

### D9. Staged and adopted counts

Cellctl writes `staged_files` and `staged_bytes` when the import Job succeeds, from the report that the Job already emits. Home shows them instead of the declared counts. An import without them shows "not recorded".

Filing happens later, after C5 reports `done`, so the Job cannot supply the adopted count. Home calls `adoption_studio(action="status", path="_Imports/<import id>")` through the existing owner channel. The scoped status returns `adopted_files`, counted by distinct original path across successful outcomes in all matching runs. Repeated and overlapping runs count each original once. Compact rows still carry `source_root` for grouping; Home never sums their totals. An incomplete status, or an older cell without the aggregate, leaves the adopted count unknown. This stays in P7.

### D10. C4 and C6

Substrate branches on no storage-class name and holds no copy of the cap, the reserve or the space factor. The new codes and the `unit` values are a closed protocol set in the browser's existing `STOPS` table, each with a fixed reason. The `import_limits` keys are a schema, not a vocabulary. C4 is absent from these paths, and no older instance was found.

## Risks / Trade-offs

- **Entitlement.** The plan's `storageBytes` limit is not enforced anywhere, so growth on demand lets a vault of any plan reach the cap. Paid storage then builds on the grown size. The operator deferred the choice to cap growth at the entitlement, or to exclude import growth from the paid baseline.
- **An abandoned import keeps its grown volume.** A claim cannot shrink. The cap bounds the cost.
- **The raise restarts the cell pod once.** It changes the render digest that the pod template carries. The wait tolerates the restart.
- **Hetzner online expansion has no production record.** Every cell class allows it, but nobody has raised a live volume. The Exomem rehearsal raises one real volume and records the capacity, the claim's conditions and any pod restart. The restart that the raise causes lets an expansion that completes only at mount time finish, so the wait holds in either mode.
- **A stale `used_bytes` reading.** Admission refuses only what cannot fit in an empty vault. The cell's per-member check stays authoritative.

## Migration Plan

Roll out outside the 02:00–05:00 UTC backup window.

1. Deploy migration 0079 and the grants. Undo: leave the columns. Older code ignores them.
2. Roll out the Exomem controller and image through the ordinary cell rollout. Undo: return to the previous controller. The operator can set `import_limits` to NULL to stop growth.
3. Deploy the admission code and the Home flow. Undo: roll the deployment back. Volumes that grew stay grown, which is harmless.
4. Release the CLI. Undo: pin the earlier CLI. Its fallback works against older servers.

## Proof Plan

The workflow that changes is an owner importing a folder. One check proves it: Home starts an import that needs growth against a disposable PostgreSQL database and a stub controller, then reaches `key_ready` with the larger `storage_gib`.

Disposable PostgreSQL tests cover grants, trigger immutability, the update from a controller that omits the new columns, growth, replay, rollback on a conflict, each refusal, unpublished limits and a paid cell above the cap. Component tests cover the Home states. Chrome DevTools inspects the dialog at desktop and phone widths in both themes. Strict OpenSpec validation precedes review.
