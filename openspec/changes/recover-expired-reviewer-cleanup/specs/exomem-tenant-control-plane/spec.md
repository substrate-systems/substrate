## MODIFIED Requirements

### Requirement: Exomem deletion is complete, product scoped, and externally verified

Deleting Exomem SHALL normally require fresh owner confirmation, revoke Exomem sessions and transfers, suspend routing, seal the cell, apply final-export policy, destroy tenant compute, storage, backup objects, and encryption keys through the provisioner, remove the active binding, and mark Exomem state deleted. It MUST NOT delete shared identity or Endstate product data.

An authenticated operator MAY authorize the same deletion transition without owner confirmation only for one caller-pinned marketplace-reviewer provision or restore operation that is waiting or failed-retryable in mandatory candidate cleanup after its exact reviewer assignment expired, or after the existing exact fail-assignment transition made that reviewer assignment terminal `failed` with `ended_at` while preserving its immutable expiry, and all reviewer access authority is unusable. The authorization and transition SHALL be atomic under the exclusive cohort lock, SHALL increment the tenant fence, SHALL revoke the full Hosted/reviewer/OAuth authority set, SHALL supersede lower-fence work, SHALL enqueue the normal target-free tenant DESTROY, and SHALL persist a content-free principal-bound audit receipt linking source and delete operations. It MUST fail closed for a customer tenant, bound cell, live reviewer authority, eligible assignment, active lease, ambiguous cell or operation, stale expected fence, or any other lifecycle state. The operator action MUST NOT edit or reopen a provider operation, release capacity, manufacture destructive proof, or mark deletion complete.

#### Scenario: Confirmed deletion completes

- **WHEN** an owner consumes a valid fresh deletion confirmation and every destructive checkpoint is externally verified
- **THEN** the tenant becomes deleted, no Exomem route or transfer remains usable, and only minimum content-free audit proof remains

#### Scenario: Expired or terminal failed reviewer cleanup is recovered

- **WHEN** an authenticated operator pins the exact cleanup operation and current fence for a reviewer-purpose tenant whose sole unbound candidate targets an expired reviewer assignment, or its exact terminal failed assignment with `ended_at` and unchanged immutable expiry, and has no usable reviewer authority
- **THEN** one atomic transaction blocks the tenant OAuth account; revokes Hosted sessions, access tokens, transfers, invites, reviewer credentials and bootstrap authority, OAuth transactions, codes, grants, families, and access tokens; gates entitlement and exports; increments the tenant fence; terminalizes older unfinished work as `DELETION_SUPERSEDED`; enqueues one normal target-free delete operation; and writes a principal-bound source/result audit receipt
- **AND** only provider-verified higher-fence DESTROY can release capacity and complete deletion

#### Scenario: Exact recovery preflight is content free

- **WHEN** an authenticated operator preflights one exact cleanup operation and expected fence
- **THEN** the service evaluates the same eligibility boundary without mutation and returns only eligibility or stable refusal plus request metadata

#### Scenario: Recovery eligibility differs

- **WHEN** the selected tenant is not reviewer-purpose, has a bound or ambiguous cell, retains live reviewer authority, targets an eligible or mismatched assignment, has a live lease, or no longer matches the caller-pinned fence
- **THEN** operator recovery refuses without changing tenant, cell, operation, authority, entitlement, export, or capacity state

#### Scenario: Operator recovery is replayed

- **WHEN** the same authenticated recovery request is retried after its atomic transition committed
- **THEN** a separate replay branch requires the same source operation to be `failed_terminal/DELETION_SUPERSEDED` at the old fence, the tenant to be deletion-pending at exactly the next fence, and one derived-key target-free delete at that next fence
- **AND** it returns the same deletion operation without incrementing the fence again or creating another destructive operation

#### Scenario: Reviewer authority races recovery

- **WHEN** reviewer or OAuth authority issuance overlaps operator recovery
- **THEN** shared/exclusive cohort locking serializes the issuer with recovery and no usable authority can commit after the recovery gate

#### Scenario: Storage destruction is still pending

- **WHEN** compute is stopped but volume, backup, or tenant-key destruction has not been verified
- **THEN** the operation remains pending or retryable
- **AND** Home and APIs do not claim deletion is complete

#### Scenario: User also has Endstate data

- **WHEN** that user deletes Exomem
- **THEN** their shared identity and Endstate credentials, subscriptions, and backups remain unchanged
