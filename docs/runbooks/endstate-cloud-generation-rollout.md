# Endstate Cloud generation-visibility rollout

This is a one-way operational sequence for migration `0040`. It protects old
engines during the transition without trusting historical R2 metadata forever.
Do not run any command here against a production database until the release
owner has reviewed the counts and R2 credentials.

## Release A: migrate and bridge

1. Deploy the migration-compatible Release-A application and apply `0040`
   through the normal migration runner as one release. While it is pending,
   the runner and Vercel build require the exact release-owner confirmation
   `CONFIRM_ENDSTATE_CLOUD_RELEASE_A=yes`. Do not run the migration
   under a long-lived pre-0040 application binary: that binary cannot read the
   policy predicate. Do not set a policy flag: the migration inserts the
   singleton policy with `strict_generation_visibility=false` and records its
   cutoff timestamp.
2. Confirm old/no-header writes still create pending rows. They must be
   reconciled by the server; a post-cutoff row must never inherit historical
   bridge visibility.
3. Existing pre-cutoff rows remain temporarily available under the bridge. This
   preserves customer history while it is checked; it is not evidence that the
   encrypted R2 object set is complete.

## Backfill and quarantine

The reconciliation command HEAD-checks the manifest and every encrypted chunk
at its recorded length. HEAD establishes presence and length only; pull still
enforces SHA-256 and AEAD integrity.

```powershell
# Non-mutating audit, newest versions first. This is the default.
npm run reconcile:legacy-generations -- --limit=250

# Apply only after reviewing the dry-run output. Re-run in bounded batches.
npm run reconcile:legacy-generations -- --apply --limit=250
```

Successful rows become published. Definitively missing or wrong-length rows are
quarantined immediately and never remain a valid restore target; transport
uncertainty retains a retryable attempt and error, so poison rows cannot
head-of-line block later history. Investigate or repair failed object sets,
then re-run the command. The regular
backup GC performs the same bounded reconciliation for ordinary old-client
writes; it does not turn on strict visibility.

## Staging checksum gate for modern uploads

Before enabling a 2.1 engine against the managed service, run this against a
disposable staging R2 bucket and test account. It is a release gate, not a unit
test substitute:

1. Create a modern (`clientCommitRequired`) version and inspect its presigned
   PUT request: it must require `If-None-Match: *`, the base64
   `x-amz-checksum-sha256` ciphertext checksum, and
   `x-amz-meta-endstate-sha256` with the expected hex ciphertext hash.
2. Upload each exact ciphertext object, call commit, and confirm R2
   `HeadObject` returns the expected `endstate-sha256` metadata and content
   length. If the provider returns a checksum with checksum mode enabled, it
   must match too; provider checksum availability is not assumed.
3. Retry a PUT after intentionally discarding its successful response. The
   conditional request must return 412 without overwriting the object; then
   commit must still succeed.
4. Upload same-length different ciphertext to a fresh pending version and
   confirm commit rejects it.

Do not claim this gate has run from local unit tests. R2 checksum support and
presigned-header behaviour are provider integration evidence.

## Create-operation replay rollout

The replay preflight stays undiscoverable until a compatible engine build has
been staged. Do not enable it just because the server code is deployed.

1. Confirm OIDC discovery omits `endstate_extensions.backup_api_capabilities`
   before the rollout. This is the safe default.
2. In staging, set `ENDSTATE_VERSION_CREATE_OPERATION_REPLAY_V1=true`, fetch
   discovery, and confirm it advertises exactly
   `version-create-operation-replay-v1`.
3. Exercise one pending replay with the identical header operation ID and
   payload: it must return the original version ID and fresh checksum- and
   metadata-bound PUT URLs. Exercise a committed replay: it must return 200,
   `alreadyCommitted: true`, and no upload URLs. A changed payload must return
   409 without changing the stored version.
4. During a controlled GC reclaim lease, retry the same create and commit
   requests. Both must be retryable and must mint or publish nothing. Clear or
   let the lease complete before retrying normally.
5. Only after those staging checks and the engine release decision, set the
   flag in the managed environment. Roll back discovery by removing the flag;
   existing pending rows remain protected by the replay and GC fences.

The replay migration creates a durable operation tombstone outside
`backup_versions`. It is deliberately retained after normal version pruning:
do not drop or truncate it during a rollback, or delayed clients could create a
second generation with an already-committed operation identity. Rolling back
the application means removing the discovery flag and deploying a
migration-compatible build; the schema is forward-only. Before any future
tombstone-retention policy is introduced, it needs an explicit protocol change
that defines how old operation IDs remain non-reusable.

## Strict cutover

Only after the command reports no pending pre-cutoff rows, run:

```powershell
$env:CONFIRM_STRICT_GENERATION_VISIBILITY = 'yes'
npm run cutover:strict-generation-visibility
```

The database locks the singleton policy and rechecks the pre-cutoff pending
count atomically. If any remain, the command refuses and leaves bridge mode
unchanged. It is safe to repeat after resolution; a successful repeat reports
that strict mode is already enabled.

After strict cutover, deploy the follow-on application release. Keep the
policy-aware predicate in that release: strict mode is a database state, not
an assumption baked into a binary. The required order is **Release A →
backfill → strict cutover → follow-on application release**.

## Rollback boundary

Before strict cutover, rolling back the Release-A application is possible only
if the migration-compatible application remains deployed; do not deploy a
pre-0040 binary against rows that rely on pending/publication fields. After
strict cutover, do **not** roll back to a pre-bridge release: it has no policy
predicate and can expose rows that the current contract keeps hidden. Roll
forward with a corrective Release-A-compatible build instead. Migration 0040
is never run by Vercel build without the explicit Release-A confirmation;
reconciliation and strict cutover are never automatic.
