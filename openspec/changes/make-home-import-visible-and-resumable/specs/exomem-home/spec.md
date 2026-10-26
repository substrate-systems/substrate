## ADDED Requirements

### Requirement: Home checks a folder import before it creates one

Before Home creates an import, the dialog SHALL show the selection's file count and bytes beside each limit it can measure. It SHALL show the exact encrypted size, the browser's free space for this site, the vault's free space with the age of that reading, and the upload-part ceiling.
Home SHALL refuse to start when the browser reports less free space than the exact encrypted size. A vault reading below the selection's bytes SHALL produce a warning only, because the reading can be stale.
By default, the selection SHALL leave out hidden items and the items that the folder's own `.gitignore` files exclude. The dialog SHALL show the files and bytes left out for each reason and SHALL let the owner bring each reason's items back.
Home SHALL NOT enforce the cell's member, path or name limits; the cell keeps enforcing them.

#### Scenario: The encrypted copy cannot fit in the browser

- **WHEN** the browser's free space is smaller than the exact encrypted size of the selection
- **THEN** the dialog shows both measured values and offers no start
- **AND** no import is created

#### Scenario: The vault reading shows too little free space

- **WHEN** the last vault reading has less free space than the selection's bytes
- **THEN** the dialog warns with the free bytes and the age of the reading
- **AND** the owner can still start the import

#### Scenario: The folder holds hidden and gitignored items

- **WHEN** the owner chooses a folder with hidden items and items that its `.gitignore` files exclude
- **THEN** the dialog shows the files and bytes left out for each reason
- **AND** turning a reason on adds its items to the selection and to the declared totals

### Requirement: Home measures import progress from the work

While Home encrypts a folder, it SHALL show the files packed, the plaintext bytes read and the ciphertext bytes written against exact totals. While it checks a kept copy or uploads, it SHALL show the bytes done against the total. Closing the dialog SHALL NOT stop the work; the Home row SHALL show the same measured progress.

#### Scenario: The owner closes the dialog during encryption

- **WHEN** the owner closes the dialog while the folder is encrypting
- **THEN** encryption continues
- **AND** the Home row shows the files packed out of the total

#### Scenario: Encryption finishes

- **WHEN** the last file is packed
- **THEN** the shown files, plaintext bytes and ciphertext bytes equal their totals

### Requirement: Home shows every stop of an import

A paused import SHALL show that it is paused and how to resume it. A failed import SHALL show a content-free reason, its code and the import ID, with the route that can still finish it: resume, choose the folder again, cancel, or check its status. The text SHALL NOT contain a file name, a path or a browser error message. While Home encrypts or uploads, leaving the page SHALL ask for confirmation.

#### Scenario: The owner pauses an upload

- **WHEN** the owner pauses an import during upload
- **THEN** the dialog says that the import is paused and offers to resume it

#### Scenario: Storage refuses a part

- **WHEN** storage answers a part upload with an error
- **THEN** the dialog shows a reason without file content, its code and the import ID
- **AND** it offers to resume or cancel the import

#### Scenario: The owner reloads during an upload

- **WHEN** the owner reloads Home while an import is encrypting or uploading
- **THEN** the browser asks the owner to confirm leaving the page

### Requirement: Home continues an open import after the page reloads

Home SHALL keep an import's ciphertext under that import's ID. When Home finds an open import that waits for an upload, it SHALL say so on the Home row and in the dialog.
Before the import has an upload report, Home SHALL continue it from the same folder chosen again, only when the selection matches the declared file count and bytes.
After the import has an upload report, Home SHALL continue it from the kept ciphertext only when that file's size and SHA-256 match the report. It SHALL then repeat the idempotent `prepare-upload` and send the parts.

#### Scenario: A reload interrupts encryption

- **WHEN** an import has no upload report and the owner chooses the same folder again after a reload
- **THEN** Home encrypts it again and completes the same import

#### Scenario: The owner chooses a different folder to continue

- **WHEN** the chosen folder's file count or bytes differ from the open import's declaration
- **THEN** Home shows both totals and offers no way to continue with that selection

#### Scenario: A reload interrupts the upload

- **WHEN** an import has an upload report and this browser kept a matching ciphertext
- **THEN** Home checks the kept file and completes the same import

#### Scenario: The kept ciphertext does not match the report

- **WHEN** the kept file's size or SHA-256 differs from the import's report
- **THEN** Home refuses to upload it and offers cancellation
- **AND** it sends no `prepare-upload` or part request

### Requirement: Home shows the space that staged originals take

When an adopt import has staged its files, Home SHALL show the staged files and bytes beside the vault's last reading and its age. It SHALL say that filing makes separate copies, and it SHALL offer the existing removal of the staged originals.

#### Scenario: An import has staged its files

- **WHEN** an adopt import reaches `done`
- **THEN** the dialog shows the staged files and bytes beside the vault reading
- **AND** it offers to remove the staged originals
