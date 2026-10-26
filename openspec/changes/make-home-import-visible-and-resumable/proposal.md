# Make the Home import visible and resumable

## Why

A large folder import in Home can stop without a message. The dialog shows no measured progress while it encrypts. Close, Esc, a remount or a reload aborts the work, and the dialog hides that abort. After a reload, the browser has lost the import ID and its ciphertext file name, so the open import can only be cancelled. An import from 2026-10-25 stayed at `key_ready` with no report until it expired.

## What changes

- Show a preflight before the import exists: the files and bytes to import, the exact encrypted size, the browser's free space, and the vault's free space with its age.
- Leave out hidden items and the items that the folder's own `.gitignore` files exclude, show the totals for each reason, and let the owner bring them back.
- Measure encryption progress from the work itself: files, plaintext bytes and ciphertext bytes against exact totals.
- Show a pause as a pause and a failure as a content-free reason with the import ID and the next route. Close keeps the work running; leaving the page asks first.
- Name the browser's ciphertext by the import ID, so a reloaded page continues the same import: before its report from the same folder chosen again, after its report from the kept copy once it matches the report.
- Keep each account's copies in a browser folder of its own. Remove a copy only when no tab holds its import and a fresh read shows that the import has ended. Show other accounts' copies with their size and an explicit discard action.
- Show the space that staged originals take beside the vault reading, with the existing removal action.

## Capabilities

### Modified Capabilities

- `exomem-home`: Add preflight, measured progress, visible stops, resume, and staged-space requirements for the Home import.

## Impact

The change is in the website's Home import dialog and its browser modules. The C5 import states, the age X25519 envelope, idempotent creation and upload reports, ordered part ETags and content-free error codes stay as they are. It adds the maintained `ignore` package to read `.gitignore` rules. Member, path, name and upload-window limits stay with the cell until a published limits contract exists.
