## MODIFIED Requirements

### Requirement: Invite redemption is email bound, atomic, and idempotent

Redeeming a valid invite SHALL atomically consume it, resolve or create the Exomem identity for its bound email, resolve exactly one tenant, project entitlement and create a product session.
The caller MUST NOT replace the bound email or choose a tenant. Exomem identity MUST remain independent of other products.

#### Scenario: New invitee redeems a valid invite

- **WHEN** a person accepts the displayed bound email and redeems a valid unused invite before expiry
- **THEN** the system creates or resolves one Exomem identity, tenant, entitlement and product session
- **AND** retries converge without creating a second tenant

#### Scenario: A previous address receives another invitation

- **WHEN** an address previously belonged to an Exomem identity that has confirmed another address
- **THEN** redemption never attaches the old address to that identity or its tenant
- **AND** after the identity switch it may create an independent Exomem identity

#### Scenario: Consumed or expired invite is replayed

- **WHEN** a consumed, revoked, malformed or expired invite token is presented
- **THEN** redemption fails with a stable non-enumerating error
- **AND** no session, tenant, entitlement or provisioning operation is created

#### Scenario: Caller attempts to replace the invite email

- **WHEN** a redemption request includes an email different from the invite's bound email
- **THEN** the supplied email is ignored or rejected
- **AND** no identity or tenant is created for the supplied address
