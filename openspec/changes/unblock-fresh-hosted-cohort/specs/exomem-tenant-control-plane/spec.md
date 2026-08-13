## MODIFIED Requirements

### Requirement: Promotion authority is based on fresh server-derived strict runtime health

Before Hosted cohort promotion, the control plane SHALL derive strict outer-v2 health for every current routable cell using only its persisted succeeded/bound provision or restore operation and persisted cell runtime inputs. The operation fence SHALL equal the current tenant fence, and its exact candidate, assignment, assignment generation, release, protocol, gateway, command, schema, and compatibility target SHALL equal the active assignment tuple. It SHALL compare the returned health with the persisted target, provider reference, verified credential digest, fence, worker policy, and strict readiness identity. It SHALL fail closed on missing or malformed persisted inputs, non-v2 or non-bound operations, timeout/error, or mismatched health.

#### Scenario: Stale route authority is refreshed by healthy cells

- **WHEN** the caller supplies the current routable-set digest and every current routable cell returns matching strict outer-v2 health
- **THEN** under the cohort advisory lock the control plane records only those exact cell and route observations, refreshes the profile authority, and performs the existing atomic promotion eligibility checks in the same transaction
- **AND** any failed check after the observations are written rolls them back with the transaction
- **AND** the final eligibility check locks and revalidates each bound tenant, succeeded operation, and active assignment against the current tenant fence and exact immutable target tuple

#### Scenario: Routes change while health is being probed

- **WHEN** the routable route set changes after the server derives the pre-probe snapshot
- **THEN** the cohort-locked update fails closed unless the current route set equals both the caller digest and the pre-probe snapshot
- **AND** it does not update promotion authority or promote the cohort
