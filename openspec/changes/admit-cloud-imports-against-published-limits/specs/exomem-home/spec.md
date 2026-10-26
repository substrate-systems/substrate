## MODIFIED Requirements

### Requirement: Home checks a folder import before it creates one

Before Home creates an import, the dialog SHALL show the selection's file count and bytes beside each limit it can measure. It SHALL show the exact encrypted size, the browser's free space for this site, and the vault's free space with the age of that reading. When other accounts' kept copies use this browser's space, it SHALL show their files and bytes and offer to discard them.
When the cell has published its import limits, the dialog SHALL also show the selection's member count against the published maximum, counting each folder as a member. It SHALL show the storage that the import needs against the published cap, computed by the function that admission uses. When the import needs more than the vault's current size, the dialog SHALL say that the vault's storage grows to about that size.
Home SHALL refuse to start in three cases: the browser reports less free space than the exact encrypted size, the member count exceeds the published maximum, or the unscaled empty-vault lower bound exceeds the published cap. A vault reading whose free space, less the published reserve, is below the selection's bytes SHALL produce a warning only, because the reading can be stale.
When the cell has published no limits, the dialog SHALL say that limits are not published and that the cell checks during the import. It SHALL NOT substitute a built-in value for a limit.
By default, the selection SHALL leave out hidden items and the items that the folder's own `.gitignore` files exclude. The dialog SHALL show the files and bytes left out for each reason and SHALL let the owner bring each reason's items back. When a `.gitignore` file is too large to read as rules, the dialog SHALL say that its rules are not applied.
Home SHALL NOT enforce the cell's path or name limits; the cell keeps enforcing them.

#### Scenario: The encrypted copy cannot fit in the browser

- **WHEN** the browser's free space is smaller than the exact encrypted size of the selection
- **THEN** the dialog shows both measured values and offers no start
- **AND** no import is created

#### Scenario: The vault reading shows too little free space

- **WHEN** the last vault reading has free space, less the published reserve, below the selection's bytes
- **THEN** the dialog warns with the free bytes, the reserve and the age of the reading
- **AND** the owner can still start the import

#### Scenario: The folder holds hidden and gitignored items

- **WHEN** the owner chooses a folder with hidden items and items that its `.gitignore` files exclude
- **THEN** the dialog shows the files and bytes left out for each reason
- **AND** turning a reason on adds its items to the selection and to the declared totals

#### Scenario: The folder has more members than the cell accepts

- **WHEN** the selection's files and folders exceed the published maximum
- **THEN** the dialog shows both numbers and offers no start
- **AND** no import is created

#### Scenario: The import needs more storage than the vault has

- **WHEN** the need is above the vault's current size and within the published cap
- **THEN** the dialog says that the vault's storage grows to about the needed size
- **AND** the owner can start the import

#### Scenario: The import cannot fit within the cap

- **WHEN** the unscaled empty-vault lower bound is above the published cap
- **THEN** the dialog shows the need and the cap and offers no start

#### Scenario: The cell has published no limits

- **WHEN** the cell's limits are unpublished
- **THEN** the dialog says that limits are not published and that the cell checks during the import
- **AND** it shows no member or storage limit

## ADDED Requirements

### Requirement: Home shows the wait while the vault's storage grows

When an import waits for the vault's storage to grow, Home SHALL say that the storage is growing to about the required size, in the dialog and on the Home row. Home SHALL keep reading the import until it reports `key_ready`, fails or ends. Home SHALL NOT stop waiting before the published `import_growth_deadline_seconds`. It SHALL read that bound from the published limits, never from a constant. When the import fails with `IMPORT_STORAGE_UNAVAILABLE` or `IMPORT_STORAGE_NO_ROOM`, Home SHALL show a content-free reason with the code and the import ID.

#### Scenario: The volume is growing

- **WHEN** an import has `required_storage_bytes` and `storage_ready` is false
- **THEN** Home says the vault's storage is growing to about that size
- **AND** it does not show the import as stalled

#### Scenario: The volume does not grow

- **WHEN** the import fails with `IMPORT_STORAGE_UNAVAILABLE`
- **THEN** Home shows the reason, the code and the import ID, and offers to start a new import

### Requirement: Home shows each admission refusal with its limit

When creation or prepare-upload returns `IMPORT_TOO_MANY_FILES`, `IMPORT_STORAGE_LIMIT` or `IMPORT_PARTS_LIMIT`, Home SHALL map the code to a fixed reason and a next step. It SHALL show the typed `limit` value and the requested amount. The text SHALL NOT contain a file name or a path.

#### Scenario: The server refuses what the preflight allowed

- **WHEN** admission returns `IMPORT_TOO_MANY_FILES` because the preflight used a stale limit
- **THEN** Home shows the reason with the limit and the requested count
- **AND** it offers to choose a smaller folder

### Requirement: Home shows the files an import staged and the files filed from them

Home SHALL show an import's staged files and bytes from the counts that the import Job reported to C5. It SHALL say so when an import has no recorded counts, and it SHALL NOT show the declared counts in their place. Home SHALL read the adopted count from the scoped Adoption Studio status through the existing owner channel. The status SHALL count distinct original paths with successful filing outcomes beneath the import's staged folder, across all runs. Repeated and overlapping runs SHALL count an original once. Home SHALL NOT sum per-run totals. When the status is unavailable, incomplete or lacks `adopted_files`, Home SHALL show the adopted count as unknown, never as zero.

#### Scenario: An import has staged its files

- **WHEN** an adopt import reaches `done` with recorded staged counts
- **THEN** Home shows the staged files and bytes from the Job's report

#### Scenario: An older import has no recorded counts

- **WHEN** an import finished before the counts existed
- **THEN** Home says the staged counts are not recorded and shows no declared count as staged

#### Scenario: Some staged files are filed

- **WHEN** the scoped status reports complete adopted counts for the staged folder
- **THEN** Home shows its distinct-original count

#### Scenario: The same original appears in several runs

- **WHEN** repeated or overlapping runs successfully file the same staged original
- **THEN** the adopted count includes that original once

#### Scenario: Adoption Studio cannot be read

- **WHEN** the status call fails, is incomplete, or carries no `adopted_files`
- **THEN** Home shows the adopted count as unknown
