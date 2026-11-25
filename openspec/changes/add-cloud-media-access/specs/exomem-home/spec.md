## ADDED Requirements

### Requirement: Home shows the vault and media storage figures honestly

When a cell reports a read time for its media storage, Home SHALL show "Vault storage" against the volume and "Media storage" against the allowance, each with its own share. A figure that the cell could not read SHALL show as unknown, never as zero. When the cell reports none, Home SHALL show the single whole-volume figure as before. The full-disk notices SHALL follow the vault figure when there is one.

#### Scenario: Both figures are known

- **WHEN** the status read returns both figures
- **THEN** Home shows each as used of limit in gigabytes, with the time they were read

#### Scenario: One figure is unknown

- **WHEN** the media figure is NULL beside a read vault figure
- **THEN** Home shows the media figure as unknown and the vault figure as read

#### Scenario: The cell has no media store

- **WHEN** all four columns are NULL
- **THEN** Home shows the whole-volume figure exactly as before
