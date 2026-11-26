## ADDED Requirements

### Requirement: A cell records its observed vault and media storage figures

The cell row SHALL hold four nullable columns: the vault bytes in use, the media bytes in use, the media allowance and the time they were read. A figure SHALL NOT be set without that time, and no figure SHALL be negative. Only cellctl SHALL write them, and `used_bytes` SHALL keep its meaning of whole-volume use. A cell without a media store SHALL have all four NULL.

#### Scenario: A figure without a read time

- **WHEN** a write sets a storage figure and leaves the read time NULL
- **THEN** PostgreSQL rejects it

#### Scenario: Only cellctl writes the figures

- **WHEN** the application role writes these columns, or the gateway reads or writes them
- **THEN** PostgreSQL refuses it, including after a blanket grant and a migration rerun
- **AND** the application role still reads them for Home
