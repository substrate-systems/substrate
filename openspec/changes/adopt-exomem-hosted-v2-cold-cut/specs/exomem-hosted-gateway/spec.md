## MODIFIED Requirements

### Requirement: Private forwarding authenticates and binds the single active v2 route

Private forwarding SHALL, after the cold-cut fence, zero-state audit, verified
release import, and v2-only process admission succeed, resolve the one
verified v2 route only after authoritative tenant/cell mapping. Callers SHALL
not select a profile or private route. The published public MCP URL remains
stable, but it resolves only the active v2 catalog. The gateway schema
projection SHALL be derived only after exact runtime self-digest verification
and SHALL remain release-independent. While maintenance is active, forwarding
is denied except for the one pinned fresh reviewer-canary MCP bearer issued by
the matching canary OAuth lineage; that exception is bounded to its canonical
resource, new tuple, one-window expiry, and smoke operation.

#### Scenario: Authoritative v2 forwarding succeeds
- **GIVEN** the fence has been released after the fresh authenticated smoke
- **WHEN** an authenticated request maps to an active v2 cell
- **THEN** forwarding uses the registered v2 route and release-independent projected schema
- **AND** it does not inspect caller-selected routing fields

#### Scenario: Caller supplies a profile, route, or old mapping
- **WHEN** a request supplies a profile/private route or resolves to an old v1 mapping
- **THEN** the gateway rejects it before forwarding

#### Scenario: Cut verification has not completed
- **WHEN** the maintenance fence is active or exact release/self-digest verification is incomplete
- **THEN** private forwarding does not reach a runtime unless it is the exact reviewer-canary smoke bearer
- **AND** public writes remain rejected

#### Scenario: The reviewer-canary bearer reaches the v2 runtime during maintenance
- **GIVEN** the canary bearer was minted from the one fresh bootstrap/client OAuth lineage for the verified tuple
- **WHEN** it calls the canonical MCP resource before its one-window expiry
- **THEN** the gateway forwards only that smoke request to the registered v2 route
- **AND** refresh, old bearers, profile selectors, and all other requests remain denied
