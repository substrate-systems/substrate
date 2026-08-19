## ADDED Requirements

### Requirement: A permanently inadmissible tenant delete can be superseded by a target-free one

An authenticated operator MAY supersede one caller-pinned tenant delete that admission can never accept, and the replacement SHALL be a target-free delete carrying `cell_id`, `expected_previous_cell_id`, and every `target_*` column NULL so that no `runtimeTarget` is presented to the provisioner. The supersession SHALL be atomic under the exclusive cohort lock, SHALL advance the tenant fence exactly once, SHALL terminalize the pinned operation as `DELETION_SUPERSEDED`, SHALL end any preparing or active rollout assignment for that tenant, and SHALL persist a content-free principal-bound audit receipt linking the superseded and replacement operations. It MUST fail closed unless the pinned operation is a `delete` that is `failed_terminal` with `PROVISIONER_REJECTED` at checkpoint `local-gated`, carries a cell and a target candidate on wire protocol v2, is unleased and completed, and sits at the caller-pinned fence which the tenant also holds; and unless the tenant is reviewer-purpose, deletion-pending, desired-deleted, not yet deleted, and has exactly one live cell with no other unfinished operation. It MUST NOT call the provider, alter capacity, or mark any deletion complete.

#### Scenario: A stranded delete is superseded

- **WHEN** an authenticated operator pins a reviewer-purpose tenant's delete that is terminal with `PROVISIONER_REJECTED` at `local-gated`, at the tenant's current fence
- **THEN** one atomic transaction advances the tenant fence by one, marks the pinned operation `failed_terminal` with `DELETION_SUPERSEDED`, ends any live assignment, enqueues one delete at the new fence whose cell and every target column are NULL, and writes principal-bound receipts for both the supersession and the replacement
- **AND** the provider is not called and capacity is unchanged

#### Scenario: The replacement is admissible where the original was not

- **WHEN** the replacement operation is dispatched by the ordinary reconciler
- **THEN** it presents no `runtimeTarget`, so deployment-lock admission has nothing to compare and cannot reject it for a mismatched runtime
- **AND** the tenant destroy still marks every cell of the tenant deleted and clears its routable observation

#### Scenario: Supersession preflight is content free

- **WHEN** an authenticated operator preflights the same pinned operation and expected fence
- **THEN** the service evaluates the same eligibility boundary without mutation and returns only eligibility plus request metadata

#### Scenario: An operation that reached the provider is refused

- **WHEN** the pinned operation sits at any checkpoint past `local-gated`, or is terminal for a reason other than `PROVISIONER_REJECTED`
- **THEN** supersession refuses, because provider-side destruction may already have begun and the control plane cannot establish otherwise on its own

#### Scenario: Supersession eligibility differs

- **WHEN** the tenant is not deletion-pending, holds more than one live cell, has another unfinished operation, or no longer matches the caller-pinned fence
- **THEN** supersession refuses without changing tenant, cell, operation, assignment, audit, or capacity state

#### Scenario: Supersession is replayed

- **WHEN** the same authenticated request is retried after its transition committed
- **THEN** a separate replay branch requires the pinned operation to be `failed_terminal` with `DELETION_SUPERSEDED` and its derived-key replacement to exist
- **AND** it returns the same replacement operation without advancing the fence again or enqueueing another delete
