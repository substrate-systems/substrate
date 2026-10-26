## 1. Home import

- [x] 1.1 Measure encryption progress and the exact encrypted size, and show them in the dialog and the Home row.
- [x] 1.2 Show pauses and failures with content-free reasons, the import ID and the next route; keep work running on Close and confirm before leaving.
- [x] 1.3 Name the ciphertext by import ID and continue an open import after a reload, before and after its upload report.
- [x] 1.4 Add the preflight with left-out items, browser space, vault space and other accounts' kept copies.
- [x] 1.5 Keep each account's copies in its own browser folder, and remove a copy only when its import is free and has ended.
- [x] 1.6 Show the staged originals' space beside the vault reading with the removal action.
- [x] 1.7 Verify the dialog in Chrome at desktop and phone widths in both themes against a synthetic API.

## 2. Delivery

- [ ] 2.1 Complete independent review and required checks.
- [ ] 2.2 Run the large-folder browser acceptance after review.
- [ ] 2.3 Release and verify, then archive this change.

## 3. Follow-ups before the review closes

Complete these before the independent review in 2.1 closes, so that it reviews the final change. They ship in the same pull request as `admit-cloud-imports-against-published-limits`.

- [ ] 3.1 Persist the part receipts. Write each part's number and ETag beside the kept copy after a 2xx answer, key the record by import ID and ciphertext SHA-256, and send only unrecorded parts after a reload. Remove a receipt with its copy. Verify: an upload test in which a reload after some parts resumes at the next part and sends no recorded part, and a receipt with another SHA-256 is ignored.
- [ ] 3.2 Move the TypeError to `CONNECTION` mapping from `cloud-import-stop.ts` to the fetch call sites, and map any other TypeError to `STOPPED`. Verify: a test in which a fetch TypeError stops with `CONNECTION` and a TypeError from our own code stops with `STOPPED`.
- [ ] 3.3 Take the import's Web Lock after the status read in the sweep, and hold it only while the copy is removed. Verify: a sweep test in which a tab that resumes during a slow status read is not refused with `OTHER_TAB`, and a copy of an import that still waits for an upload stays.
- [ ] 3.4 Replace the `.gitignore` size cap's comment in `cloud-import-selection.ts` with its own reason, browser memory, and remove "keep in step" with the CLI. Verify: the comment names the memory bound, and the existing selection tests pass.

