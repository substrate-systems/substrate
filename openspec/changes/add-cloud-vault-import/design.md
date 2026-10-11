## Context

See proposal.md. Existing Cloud OAuth lookup, browser sessions, SQL transactions, and column grants supply the needed authority seams. C5 connects Substrate and cellctl without carrying import bytes.

## Goals / Non-Goals

The batch establishes C5 and its authenticated API. It does not build the browser uploader, controller Jobs, or an operator restore endpoint.

## Decisions

### C5 schema and authority

`exomem_cloud_imports` has these columns. Nullable columns default to NULL; request state defaults to `requested`.

| Column | PostgreSQL type | Writer |
| --- | --- | --- |
| import_id | uuid PRIMARY KEY DEFAULT gen_random_uuid() | Substrate INSERT |
| cell_id | text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE RESTRICT | Substrate INSERT |
| kind | text NOT NULL: adopt, restore, archive_members | Substrate INSERT |
| declared_bytes, declared_files | bigint NOT NULL, nonnegative | Substrate INSERT |
| requested_state | text NOT NULL: requested, uploaded, cancelled, discard_requested | Substrate |
| part_etags | jsonb nullable array of {part_number: integer, etag: string} | Substrate |
| ciphertext_sha256 | text nullable, 64 lowercase hexadecimal characters | Substrate |
| ciphertext_bytes | bigint nullable, nonnegative | Substrate |
| recipient, upload_id | text nullable | cellctl |
| part_urls | jsonb nullable array of {part_number: integer, url: string, part_size_bytes: integer} | cellctl |
| urls_expire_at | timestamptz nullable | cellctl |
| observed_state | text nullable: key_ready, importing, cleanup_running, cleanup_stopping, cleanup_discard_stopping, cleanup_pending, done, failed, expired, discarded | cellctl |
| error_code | text nullable | cellctl |
| created_at, updated_at | timestamptz NOT NULL DEFAULT now() | database |

Substrate and cellctl can read C5. Neither receives table-wide DML. The gateway receives no C5 privileges. The grants script revokes default grants before applying column grants and tolerates pre-C5 upgrades. The cell hold CHECK adds `import`.

A partial unique index permits one open import per cell. NULL, `key_ready`, `importing`, `cleanup_running`, `cleanup_stopping`, `cleanup_discard_stopping`, and `cleanup_pending` observations are open. A `discard_requested` row also remains open until its observation is `discarded`, including an older row with a terminal import outcome. A trigger freezes accepted request/report fields and maintains updated_at. This prevents a concurrent retry from substituting the authenticated upload tuple. Cancellation records intent; only cellctl reports terminal state. Cell deletion waits for explicit lifecycle cleanup.

### Bounded cleanup holds

`cleanup_running` fixes the work outcome before idempotent cleanup. `cleanup_stopping` records successful keep-adoption cleanup. `cleanup_discard_stopping` records successful full discard and transport cleanup while Jobs and Pods drain.

The controller locks C1 then C5 and reads current state and intent. Late full-discard intent rearms ordinary cleanup with a fresh bounded C1 hold in that transaction. Only completed full discard can publish discarded status and release the hold. Terminal publication and release remain atomic.

`cleanup_pending` reports failed or deferred cleanup explicitly and preserves `error_code` as the original import outcome. The controller uses `updated_at` for retry backoff. Cleanup failure never becomes successful import or successful discard status.

Each cleanup attempt uses the persisted C1 `hold_started_at` and a bounded deadline. Controller configuration defaults to a two-minute cleanup attempt and one hour between retries. On failure or expiry, the controller removes the import's Job controllers and Pods. It confirms that both are absent before releasing the hold. Cleanup then remains pending between attempts, so a failed Job cannot keep the runtime stopped forever.

Lifecycle deletion takes precedence over import work. Hold release restores only the current desired lifecycle; a stopped cell retains zero replicas. A new import cannot compete with pending cleanup. Discarding an older import claims the same open slot and returns 409 when another import already owns it.

### API and authentication

All endpoints are under `/api/exomem/cloud/imports`:

- `POST /` accepts `{import_id?, kind, declared_bytes, declared_files}`. Public kinds are `adopt` and `archive_members`.
- `GET /` returns `{import: latest-owned-import|null}`.
- `GET /:importId` returns owned status.
- `POST /:importId/prepare-upload` accepts `{ciphertext_sha256, ciphertext_bytes}` after encryption.
- `POST /:importId/complete` accepts `{part_etags, ciphertext_sha256, ciphertext_bytes}`.
- `POST /:importId/cancel` and `POST /:importId/discard` need no body.

Single-row successes return `{import: {...}}`. The response includes request fields, report digest/size, recipient, upload URLs, expiration, observed state, error code, and timestamps. SQL NULL observed state becomes `pending`. It omits upload_id and ETags. Responses use `no-store` and `no-referrer`.

An Authorization header exclusively selects bearer authentication. The existing lookup verifies the configured Cloud resource and both write/read scopes. Failure never falls back to cookies. Without that header, browser sessions retain their existing mutation CSRF checks. Every operation joins the verified tenant and user to its non-deleted C1 cell. Starts and completions require running desired state; status and cancellation remain available during suspension. A row lock serializes mutation decisions and lifecycle writes.

Preparation freezes the authenticated digest and size while requested_state remains requested. The controller then signs the exact part count and reports each part size. Initial key_ready can carry only the recipient. C5 inserts and request/report changes notify the existing cell channel with cell_id.

Completion requires a live `key_ready` transport and the issued part-number set. S3 fixes part numbers to 1..10000. Counters use safe nonnegative JSON integers. SHA-256 input normalizes to lowercase, and ETags remain opaque strings. Exact retries of an accepted tuple succeed, even after transport cleanup; a conflicting tuple returns 409. Validation errors return 400, absent owned rows return 404, and denied lifecycle writes return 403. The HTTP request ceiling is 2 MiB.

### CLI admission

Seed the ordinary pinned `exomem-cloud-cli` client with `http://127.0.0.1/callback`. The existing loopback rule permits ephemeral ports. Compute its redirect digest from JSONB text. Keep platform/config identity NULL. `ON CONFLICT DO NOTHING` preserves operator disablement.

## Risks / Trade-offs

The C5 access split adds one migration and one service module to maintain. Reusing session, OAuth, SQL, and error helpers keeps this boundary small. Refusing unready transport prevents false completion; legitimate clients retry after polling. Lifecycle refusal prevents writes to suspended cells and costs callers a retry after reactivation. Neither needs human approval.

## Migration Plan

1. Deploy the additive migrations and grants, including migration 0061, then verify the API boundary.
2. Deploy cellctl consumers after C5 exists, then verify import Jobs.
3. Deploy the browser flow after the transport works, then verify its upload workflow.

Rollback disables new client requests while retaining C5 records and controller cleanup. Dropping the table is not a rollback step. Migration 0060 remains immutable. Migration 0061 extends the observation CHECK and open-slot index without new columns or grants. Existing conflicting open intents must be reconciled before that index can be created; the migration does not rewrite outcomes.

## Proof Plan

Disposable PostgreSQL tests exercise real role grants, migration upgrades, tenant isolation, authentication, CSRF, lifecycle enforcement, completion retries, and concurrent writers. Existing migration tests cover pre-C5 grants. Scoped tests, typecheck, lint, build, and strict OpenSpec validation precede independent review. The delivery owner runs full-suite verification and completes release.

### Cleanup rollback boundary

Deploy migration 0061 before the controller uses the new observations. Keep the new controller while records use `cleanup_discard_stopping`; older readers do not reliably understand that open state.
