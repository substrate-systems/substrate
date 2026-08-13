## Context

Reviewer bootstrap consumption correctly disables and blocks future registration of its OAuth client. The bootstrap outcome is still the authoritative proof that a particular reviewer tenant, candidate, assignment, and generation was created. Promotion currently only verifies that an earlier route observation is less than five minutes old.

## Design

### Fresh sibling reviewer credentials

The consumed-bootstrap predicate remains anchored to the exact outcome tenant, candidate, assignment, and generation. It stops requiring the selected staged client and OAuth client to be the bootstrap client. Instead, the selected client must be configured for the selected stage and have no bootstrap-authority history. A freshly registered staged client remains disabled until its internal-canary credential supplies the exact pre-promotion authorization lineage; requiring it to be enabled before that credential would make the staged flow circular. Existing stage state, expiry, candidate, platform, assignment state, account-block, credential-rotation, and OAuth-lineage constraints remain unchanged. Each platform/client remains independently unique, so exact Claude and OpenAI siblings can coexist.

Consumption terminalizes the one-shot bootstrap stage along with disabling its client. That releases its platform slot for a genuinely fresh sibling stage while preserving the bootstrap history fence; it does not make the bootstrap stage or client reusable.

### Promotion runtime refresh

Before the promotion transaction, the server loads only currently bound/active routes whose bound running tenant and active assignment have a succeeded, bound outer-v2 provision or restore operation matching the route target and current tenant fence. The assignment's immutable release, protocol, gateway, command, schema, and compatibility tuple must equal that operation target. It constructs the provisioner health request solely from the persisted cell, provider reference, verified credential/digest, fence, worker policy, and operation target. It reuses the reconciler strict readiness comparison, including liveness, readiness, runtime identity, and admissions checks. Missing/incomplete state, health errors, malformed responses, and mismatches fail closed.

After all probes pass, the existing cohort-locked promotion transaction re-reads the route set. It requires the re-read set to match both the caller's digest and the pre-probe snapshot. Only then does it update those exact cell observations and route observations, refresh profile authority, and perform the existing promotion compare-and-swap before the same transaction commits. The final eligibility query locks and rechecks each bound tenant, succeeded operation, and active assignment against the same fence and immutable tuple. Any later failed eligibility check rolls back those writes. A locked terminal replay for the exact candidate, artifacts, and evidence returns `already_live` without relying on transient authority freshness. No public input gains a runtime identity, credential, provider reference, or target selector.

## Testing

Regression coverage proves sibling credentials succeed only for the exact consumed outcome while bootstrap-history clients stay rejected. Promotion coverage proves a stale authority becomes fresh after strict v2 probes, and rejects missing persisted targets, non-v2/bound operations, malformed or mismatched health, and route changes during probing. The paired acceptance flow uses distinct fresh Claude and OpenAI promotion clients.
