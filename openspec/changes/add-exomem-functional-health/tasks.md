# Tasks

## 1. Proof storage and readers

- [ ] 1.1 Add migration0070 and typed proof storage; verify latest-failure and late-attempt behavior against isolated PostgreSQL.
- [ ] 1.2 Add public control/email and gateway readers; verify bounded unavailable responses, privacy and unchanged pod probes.
- [ ] 1.3 Document freshness and checked scope in the existing operations runbook; verify the described responses match execution.

## 2. Scheduled checks

- [ ] 2.1 Add protected control and email checks through existing adapters; verify authorization and provider acceptance with isolated boundaries.
- [ ] 2.2 Bundle the memory runner; prove a nonce survives a dedicated synthetic cell write/read and fails on a mismatched read.
- [ ] 2.3 Extend the scheduler source contract and deployment packet; verify schedule synchronization and render the public health rewrite.

## 3. Delivery and observation

- [ ] 3.1 Review the exact integrated health diff independently; resolve findings and pass scoped checks and completion CI.
- [ ] 3.2 Merge and release control changes; verify exact production public reads without running unsolicited synthetic writes.
- [ ] 3.3 Deliver the gateway and platform packet to the existing rollout owner; verify actual scheduled proofs after its approved window.
- [ ] 3.4 Publish the external Upptime configuration; verify hostname, assets, actual observations and unavailable states in Chrome.
