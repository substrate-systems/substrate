## 1. C5 foundation

- [x] 1.1 Add C5, import holds, split grants, and CLI admission; verify real PostgreSQL grants, replay, and pre-C5 upgrade tests.

- [x] 1.2 Extend C5 with cleanup_running, cleanup_stopping, cleanup_discard_stopping, cleanup_pending, and exclusive discard intent through migration 0061; verify upgrade, grants, API status, and open-slot exclusion against PostgreSQL.

## 2. Tenant API

- [x] 2.1 Add shared principal resolution and tenant-bound import operations; verify authentication, isolation, lifecycle, idempotency, and concurrency through API tests.

## 3. Delivery boundary

- [x] 3.1 Run scoped tests, typecheck, lint, build, and strict OpenSpec validation; record exact results for independent review.
- [ ] 3.2 Complete independent review, full-suite checks, migration deployment, and OpenSpec closure in the integrated delivery.

## 4. Home browser delivery

- [ ] 4.1 Stream browser-selected files through maintained TAR and age libraries; prove Unicode and empty files survive the cell reader.
- [ ] 4.2 Upload the exact ciphertext parts and retain accepted ETags for retries; prove storage receives no session credentials or plaintext.
- [ ] 4.3 Add Home selection, progress, observed status, cancellation, and discard using the existing design system.
- [ ] 4.4 Verify the rendered workflow, interrupted upload, sign-in expiry, and failed cleanup without production writes.
- [ ] 4.5 Complete independent review, current-head CI, and source delivery; retain actual deployment and tenant import as separate evidence.
- [ ] 4.6 Bind the review handoff to the completed staged import, retain a manual clipboard fallback, and verify reload and pending-removal behavior.

## 5. Managed-vault migration dependency

Exact identity and history transfer remains a separate obligation. It does not block the content-first adoption delivery above.

- [ ] 5.1 Resolve populated-destination conflicts and store admission through the canonical portability owners before adding migration apply.
- [ ] 5.2 Bind preview and application to the source archive and destination canonical head; prove recovery retains both sides and later writes.
- [ ] 5.3 Verify the complete managed-vault workflow before describing document adoption as migration or enabling a Home migration action.
