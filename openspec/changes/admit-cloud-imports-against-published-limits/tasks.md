The packets P1 to P7 below match the paired Exomem change `publish-cloud-import-limits`. This file holds the Substrate packets P1, P4, P5 and P7. Tasks marked **Control-plane review** change C5 or the controller contract, so the Cloud control-plane owner reviews them.

## 1. C5 columns, grants and trigger (P1) — Control-plane review

- [ ] 1.1 Add migration 0079 with `import_limits`, `required_storage_gib`, `staged_files` and `staged_bytes`, their CHECKs, and the `CREATE OR REPLACE` of `exomem_cloud_imports_touch` for immutability. Add the grants, each guarded on its column, to `scripts/exomem-cloud-grants.sql`. Add the C5 types to `cloud-import-contract.ts`. Verify: disposable PostgreSQL tests for each grant, for each immutability rule and for both-or-neither staged counts.
- [ ] 1.2 Prove that an update from a controller that omits the new columns still passes the trigger. Verify: one integration case that updates `observed_state` and `part_urls` under the cellctl role, and the deployed cellctl's own tests run against the 0079 ref.
- [ ] 1.3 Deliver P1 as its own pull request. Verify: the pull request records the grants and the trigger test output for the control-plane owner.

## 2. Admission, refusals and replies (P4)

- [ ] 2.1 Add the pure function to `cloud-import-contract.ts`: parse limits, compute the need and clamped `required_storage_gib`, and build each refusal's `limit`. Verify: cases for unpublished or invalid limits, unknown usage, the capacity ratio, growth clamped below need, and a cell above the cap.
- [ ] 2.2 Run the admission steps in `cloud-imports.ts` and add `limit` to the error envelope in `errors.ts`. Verify: PostgreSQL integration tests for growth with `GREATEST`, replay with no check and no growth, rollback on an open-slot conflict, each refusal, and unpublished limits.
- [ ] 2.3 Refuse `IMPORT_PARTS_LIMIT` on the first prepare-upload report only. Verify: an integration case for the first report, and one for a replay that returns the stored import.
- [ ] 2.4 Add `limits`, `required_storage_bytes`, `storage_ready`, `staged_files` and `staged_bytes` to the import routes and zod schemas. Verify: a schema test that parses a reply without the new fields, and an integration case for `storage_ready` while the claim is smaller than required.

## 3. Home preflight and states (P4)

- [ ] 3.1 Run the shared function in the Home preflight: member count, storage need against the cap, the grows-to notice, the reserve in the vault warning, and the unpublished-limits message. Verify: component tests for each state in the Home requirement.
- [ ] 3.2 Show the wait for growth, read the key-ready bound from `import_growth_deadline_seconds`, and map the three refusal codes and both growth failures to fixed reasons in the `STOPS` table. Verify: component tests; the Home dialog works in Chrome at desktop and phone widths in both themes against a synthetic API.
- [ ] 3.3 Show the staged counts from the Job's report and "not recorded" for older imports. Verify: a component test with and without counts.

## 4. Browser follow-ups (P5)

The follow-ups from the first Home import change live in `make-home-import-visible-and-resumable`, tasks 3.1 to 3.4. They ship with P4 in one Substrate pull request. Verify: that change's upload test shows a reload resuming from the next part.

## 5. Adopted count (P7)

- [ ] 5.1 Call `adoption_studio(action="status")` through `cloud-home-mcp.ts`, sum `counts.applied` over the runs under the import's staged folder, and show the result. Show "unknown" when the call fails or the rows lack `source_root`. Verify: a Home test against a stub status reply, with and without `source_root`.
- [ ] 5.2 Wait for the Exomem change to add `source_root` to the status rows (its task 4.1). Verify: Home shows the adopted count against a cell that runs that version.

## 6. Delivery

- [ ] 6.1 Complete independent review of the integrated pull requests, with the C4 verdict, and the required checks.
- [ ] 6.2 Roll out in this order, outside the 02:00–05:00 UTC window: 1. migration 0079 and grants; 2. the Exomem controller and image; 3. P4 and P5; 4. the CLI. Undo: leave the columns; return to the previous controller and set `import_limits` to NULL; roll the Substrate deployment back, because grown volumes stay grown; pin the earlier CLI.
- [ ] 6.3 Archive `add-cloud-vault-import` and `make-home-import-visible-and-resumable` first. Then synchronize this change into the canonical specs and archive it with `openspec archive`. Verify: `openspec validate --all --strict` passes before and after the archive.
