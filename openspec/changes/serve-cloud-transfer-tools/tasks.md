## 1. Control plane and gateway

- [x] 1.1 Resolve the owner principal once for imports and exports, accept the Cloud bearer on the export routes, and add `archive_sha256` to the ready export display; verify tenant isolation, wrong-resource and single-scope refusal, and session CSRF against PostgreSQL.
- [x] 1.2 Serve `observe_transfer` and `transfer_memory` from the gateway behind the flag, before the cell gate, with the caller's bearer only; verify with a stand-in cell and web API, and with the official MCP client.
- [x] 1.3 Generate the tool names, actions, input property names, required lists and defaults from Exomem's Cloud-only tool schema fixture, tie the argument schemas to them at compile time, and check them in the weekly drift job.
- [x] 1.4 Add the `#your-data` anchor to Home and the runbook row for the flag.

## 2. Delivery boundary

- [x] 2.1 Run scoped tests, typecheck, lint, the gateway bundle check and strict OpenSpec validation; record exact results for independent review.
- [ ] 2.2 Complete independent review and current-head CI in the integrated delivery.
- [ ] 2.3 Re-run the sync script against the merged Exomem fixture so the generated module names an Exomem commit, then confirm the weekly drift job passes.

## 3. Release acceptance

- [ ] 3.1 Enable the flag and the Exomem chart flag in a rehearsal environment, run the cross-stack journey (import status, handoff, cancel and export through the gateway, including a held cell), then enable in production. Owners: Cloud programme and deployment.
