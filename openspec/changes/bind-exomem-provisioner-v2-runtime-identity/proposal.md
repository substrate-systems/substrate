## Why

Substrate already snapshots the selected Exomem candidate and runtime contract, but its provisioner client always emits v1 and does not persist the outer wire protocol. Enabling a richer request from a process-wide flag would let retries change header/body identity after a restart, while current health wording incorrectly treats candidate compatibility as something a cell reports.

## What Changes

- Add strict provisioner v1/v2 serializers and parsers on the existing `/cells/<action>` routes while preserving exact v1 wire bytes.
- Persist one immutable provisioner-wire-protocol discriminator on every lifecycle operation, backfilled/defaulted to v1 and selected before first issuance.
- Before v2 codecs can be issued, permit one bounded strict-v1 compatibility
  path for an exact marketplace-reviewer assignment: flat ready health remains
  identity-less, all runtime observations remain NULL, and the resulting route
  cannot be promotion evidence. Migration `0039` stores the immutable v1
  discriminator and fails closed on any other value until the dual-protocol
  migration widens it.
- Keep v2 issuance default-off; only explicit normalized `true` selects v2 for newly created operations, while every retry uses stored state.
- Snapshot and build the v2 six-field `runtimeTarget` from existing migration 0036 columns for every cell-scoped lifecycle action, while explicit export-reference and tenant-destroy v2 actions remain target-free; compare health only against returned `runtimeIdentity`.
- Keep candidate compatibility, package/archive locks, plugin provenance, and OAuth bindings in the existing candidate and staged-client catalogs rather than the provisioner wire.
- Update the active Hosted OAuth/canary specification and design wording so runtime observation and package lineage have one authority each.
- Roll out through D1's verified legacy-v1 catalog and immutable expand lock, disabled v2 consumer deployment, stored v2 issuance, v1 drain, and the immutable contract lock.

## Capabilities

### New Capabilities

- `exomem-provisioner-runtime-identity`: Durable dual-protocol issuance, strict runtime-target serialization and observation, authority separation, and expand/contract rollout for Hosted Exomem lifecycle operations.

### Modified Capabilities

None.

## Impact

- `src/lib/exomem-hosted/provisioner.ts`, reconciler and lifecycle-store boundaries, candidate catalog binding, focused tests, migration `0039`, environment contracts, runbooks, and the active `add-exomem-hosted-mcp-oauth` artifacts.
- Depends on the paired Exomem provisioner v2 implementation and one reviewed deployment lock. It does not change Hosted runtime protocol `1`, private `/private/exomem/v1/...` routes, candidate/package schema ownership, or existing migration 0036 target columns.
- Database migration is additive and side-effect-free; rollout remains v1 until the explicit issuance flag is enabled after the dual-serving provisioner is live.
