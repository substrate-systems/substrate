## ADDED Requirements

### Requirement: The client population check is constant-cost and exact

The check that a client may take a slot in its population partition SHALL cost the same at any number of clients. It SHALL read a count of the partition's unretired clients that every write to the clients keeps current, not count the clients. Concurrent registrations SHALL never take a partition past its bound. The count SHALL be recounted exactly at least once an hour, and the sweep SHALL report any difference it corrected.

#### Scenario: Two connectors race for the last slot

- **WHEN** two connector registrations arrive while their partition has one free slot
- **THEN** one registration takes the slot and the other is refused
- **AND** the partition reports itself full, not past full

#### Scenario: Every write keeps the count

- **WHEN** registrations, revivals, moves between partitions, retirements and deletions run concurrently
- **THEN** each partition's count equals an exact count of its unretired clients

#### Scenario: The check at the load target

- **WHEN** a partition holds 500,000 unretired clients
- **THEN** a registration's partition check and the operator headroom report each take under one millisecond of database time

#### Scenario: A count that drifted is corrected

- **WHEN** a write bypassed the counting triggers
- **THEN** the next hourly recount sets the exact count and the sweep reports the drift it corrected
