## REMOVED Requirements

### Requirement: Gateway command behavior is derived from Exomem's versioned registry

**Reason**: Exomem Hosted is retired. The Cloud gateway is a pass-through that never fetches or compares a contract.

**Migration**: None. The cell validates its own commands; see `exomem-cloud-control-plane`.

### Requirement: Hosted transfer grants are short lived and tenant bound

**Reason**: Exomem Hosted is retired, and Substrate no longer issues upload or download grants.

**Migration**: None. Files reach a Cloud cell through the assistant connected to it.
