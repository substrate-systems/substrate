## ADDED Requirements

### Requirement: Home checks a folder import before it creates one

Before Home creates an import, the dialog SHALL show the selection's file count and bytes beside each limit it can measure. It SHALL show the exact encrypted size, the browser's free space for this site, and the vault's free space with the age of that reading. When other accounts' kept copies use this browser's space, it SHALL show their files and bytes and offer to discard them.
Home SHALL refuse to start when the browser reports less free space than the exact encrypted size. A vault reading below the selection's bytes SHALL produce a warning only, because the reading can be stale.
By default, the selection SHALL leave out hidden items and the items that the folder's own `.gitignore` files exclude. The dialog SHALL show the files and bytes left out for each reason and SHALL let the owner bring each reason's items back. When a `.gitignore` file is too large to read as rules, the dialog SHALL say that its rules are not applied.
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

#### Scenario: A script error occurs during an upload

- **WHEN** the page's own code raises an error that is not a network failure
- **THEN** the dialog shows the generic stop reason and the import ID
- **AND** it does not say that the connection dropped

#### Scenario: Storage refuses a part

- **WHEN** storage answers a part upload with an error
- **THEN** the dialog shows a reason without file content, its code and the import ID
- **AND** it offers to resume or cancel the import

#### Scenario: The owner reloads during an upload

- **WHEN** the owner reloads Home while an import is encrypting or uploading
- **THEN** the browser asks the owner to confirm leaving the page

### Requirement: Home continues an open import after the page reloads

Home SHALL keep an import's ciphertext under that import's ID, in a browser folder of the account's own. It SHALL remove one of the account's kept copies only while no tab holds that import and a fresh status read shows that the import is absent or no longer waits for an upload. It SHALL remove another account's copies only on the owner's explicit request, and never while a tab holds their import. When Home finds an open import that waits for an upload, it SHALL say so on the Home row and in the dialog.
Before the import has an upload report, Home SHALL continue it from the same folder chosen again, only when the selection matches the declared file count and bytes.
After the import has an upload report, Home SHALL continue it from the kept ciphertext only when that file's size and SHA-256 match the report. It SHALL then repeat the idempotent `prepare-upload` and send the parts. After storage confirms a part, Home SHALL record the part's number and ETag in this browser, beside the kept copy and bound to the import and the ciphertext's SHA-256. A resumed upload SHALL send only the parts that Home has not recorded for that import and ciphertext.

#### Scenario: A reload interrupts encryption

- **WHEN** an import has no upload report and the owner chooses the same folder again after a reload
- **THEN** Home encrypts it again and completes the same import

#### Scenario: The owner chooses a different folder to continue

- **WHEN** the chosen folder's file count or bytes differ from the open import's declaration
- **THEN** Home shows both totals and offers no way to continue with that selection

#### Scenario: A reload interrupts the upload

- **WHEN** an import has an upload report and this browser kept a matching ciphertext
- **THEN** Home checks the kept file and completes the same import

#### Scenario: A reload interrupts the upload after some parts

- **WHEN** storage confirmed some parts of an import and the owner reloads Home
- **THEN** Home sends the next part that it has not recorded
- **AND** it sends no part that it recorded

#### Scenario: The recorded parts belong to other ciphertext

- **WHEN** the recorded parts name a SHA-256 that differs from the import's report
- **THEN** Home ignores them and refuses the copy as in the mismatch case

#### Scenario: A stale page prepares a new folder while another tab keeps an open import's copy

- **WHEN** a page that has not seen an open import measures a new folder, and this account's folder holds that import's copy
- **THEN** the copy stays, because a fresh read shows the import still waits for its upload

#### Scenario: Another account's copy uses this browser's space

- **WHEN** another account's kept copy is in this browser
- **THEN** the preflight shows its files and bytes and keeps it until the owner discards it
- **AND** a discard skips a copy whose import a tab holds

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
