## 1. Signed-in download

- [x] 1.1 Add the download ticket, the gateway ticket branch and the app route. Verify: the gateway ticket tests and the route integration test against PostgreSQL pass, including no session, tenant isolation, revocation, a stopped cell, cross-site refusal and admission, Range playback, a ticket that outlives its family check, and a full media pool that leaves MCP free.

## 2. Storage figures

- [x] 2.1 Add migration 0095, its guarded cellctl grant and the status read. Verify: the grants and Home status tests against PostgreSQL pass, including the CHECK refusals.
- [x] 2.2 Show Vault storage and Media storage in Home. Verify: the Home view tests pass and the rendered card shows both figures, one unknown figure, and today's single figure.

## 3. Privacy copy

- [x] 3.1 State the media store, its standard-mode custody and the automatic purge of stored originals on the privacy page. Verify: the marketplace surface test passes and the page names no tenant-held or operator-unreadable claim and no manual deletion step.

## 4. Delivery

- [ ] 4.1 Complete independent review, the full test, typecheck and lint run, migration deployment and archive of this change. Verify: current-head CI is green and the migration applied.
- [ ] 4.2 Redact the `ticket` query parameter from the ingress access log of the gateway's address, in the platform repository that owns the ingress. Verify: a download through the ingress leaves no ticket in the ingress access log.
- [ ] 4.3 Follow-up change: a same-origin player page that plays and seeks a stored original in the browser. A top-level link only downloads it. Verify: the follow-up change names its own proof.
