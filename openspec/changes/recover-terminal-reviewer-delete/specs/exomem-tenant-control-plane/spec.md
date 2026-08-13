## ADDED Requirements

### Requirement: Provider-proven terminal reviewer deletion can finish locally

The control plane SHALL permit an authenticated operator to replay only the local finalizer of one exact reviewer-purpose delete whose persisted checkpoint `destroyed` is the authoritative provider-destruction proof but terminalized after a local finalizer failure. Recovery MUST preserve the delete operation identity, fence, idempotency key, and checkpoint; MUST NOT call the provider, create a new delete, release capacity directly, or manufacture proof; and MUST be atomic, audited, content free, and serialized under the Hosted cohort lock.

#### Scenario: Exact terminal delete is recovered

- **WHEN** the operator pins the exact delete operation and current fence and every terminal-delete, tenant, source, expired-assignment, sole-unbound-cell, uncertain-allocation, bootstrap-lineage, no-conflict, and no-live-authority predicate matches
- **THEN** one transaction schedules the same operation once at checkpoint `destroyed`, clears only terminal retry metadata and leases, and writes a principal-bound audit receipt
- **AND** the next bounded reconcile executes the current local finalizer without another provider call

#### Scenario: Recovery preflight is content free

- **WHEN** an authenticated operator preflights an exact delete operation and expected fence
- **THEN** the service evaluates the same eligibility predicate without mutation and returns only eligibility plus request metadata

#### Scenario: Terminal delete shape differs

- **WHEN** the operation is not the exact target-free `failed_terminal/LIFECYCLE_MAX_ATTEMPTS/destroyed` delete, its source-derived identity or prior audit is absent, the fence is stale, the tenant is not the exact reviewer deletion state, the cell or allocation graph differs, bootstrap lineage cannot be proven, or live/conflicting authority exists
- **THEN** recovery refuses without changing operation, tenant, cell, authority, provider evidence, or capacity state

#### Scenario: Recovery request is replayed

- **WHEN** the exact authenticated request is repeated after the delete was scheduled or completed
- **THEN** the service returns a bounded replay outcome without reopening the row again, altering the fence, or creating another operation

#### Scenario: Current finalizer completes recovered deletion

- **WHEN** bounded reconcile claims the recovered operation at checkpoint `destroyed`
- **THEN** it retains the exact consumed bootstrap invite and revoked outcome session, scrubs all other tenant authority and resource references, marks the tenant and all cells deleted, releases uncertain capacity through the checked ledger transition, and marks the same delete `succeeded/destroyed`
