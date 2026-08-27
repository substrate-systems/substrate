## ADDED Requirements

### Requirement: Hosted gateway contracts are bound to the selected release profile

The gateway SHALL select a hosted contract by the authoritative cell observation's exact source release and profile, SHALL derive its command surface from the signed Exomem registry artifact for that tuple, and SHALL construct private agent routes from that validated profile. It MUST NOT accept a caller-selected profile, relabel a retained legacy artifact, or supplement the registry with a local command allowlist.

#### Scenario: A v4 cell exposes the stable 25-tool surface

- **WHEN** a routable cell records Exomem `0.63.1`, profile `hosted-alpha-agent-v4`, and the checked v4 contract digests
- **THEN** Claude and OpenAI tool discovery each return the same 25 registry commands in the publisher-defined order
- **AND** hosted private contract and command requests use the `hosted-alpha-agent-v4` agent route

#### Scenario: Caller attempts to select a retained profile

- **WHEN** a public MCP request includes a release, profile, candidate, assignment, or artifact selector
- **THEN** the gateway rejects the selector before private forwarding
- **AND** it does not route through a retained v1 contract

#### Scenario: Runtime advertises a mismatched profile

- **WHEN** the authoritative observation selects v4 but the private cell contract advertises v1 or different digests
- **THEN** the gateway fails closed with a protocol mismatch
- **AND** no command is forwarded

### Requirement: Stable v4 artifacts remain registry exact across supported clients

The 0.63.1 Hosted candidate SHALL carry checked Claude and OpenAI package and archive locks for `hosted-alpha-agent-v4`. The imported agent contract, both client artifacts, and the full private gateway contract MUST describe one identical ordered set of exactly 25 commands.

#### Scenario: Generated artifacts agree

- **WHEN** the exact 0.63.1 commit is imported
- **THEN** compatibility, Claude, OpenAI, and gateway fixture validation succeeds only if all four surfaces describe the same 25 commands

#### Scenario: Artifact is incomplete or mixed-profile

- **WHEN** any artifact has a different profile, command count, command order, schema digest, compatibility digest, package digest, or archive digest
- **THEN** generation or import fails before a candidate becomes promotable
