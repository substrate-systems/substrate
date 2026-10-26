# Tasks

## 1. Gateway authority and byte routing

- [ ] 1.1 Add signed origin proof and the canonical Cloud envelope with existing Ed25519 machinery. Verify cross-language decoding, audience separation, expiry and descriptor bounds.
- [ ] 1.2 Reuse complete OAuth admission and revocation predicates for delegated origins. Verify real database cases for family revocation, blocked tenants and current client admission.
- [ ] 1.3 Add the fixed streaming upload route and preserve existing MCP/transfer handling. Verify refusal before body reads, fixed routing, write-state checks, cancellation and identity isolation.
- [ ] 1.4 Keep issuance disabled by default and document its configuration and undo. Verify unchanged default routing and selection of only compatible sandbox cells.

## 2. Compatible cell and CLI integration

- [ ] 2.1 Integrate the final `capture-agent-files` source contract in the paired Exomem worktree. Verify personal tickets and current/legacy original bindings remain valid.
- [ ] 2.2 Verify fresh gateway origin in the Cloud principal and private upload receiver. Verify complete ticket binding, replay refusal, streaming limits and hash failure without Source custody.
- [ ] 2.3 Add Cloud envelope support to the existing CLI handoff path. Verify the actual terminal-postfiltered descriptor uploads exact bytes without another credential.

## 3. Integrated proof and delivery

- [ ] 3.1 Exercise MCP handoff, CLI upload, held handle, Source capture and exact original recovery in an isolated sandbox. Verify revocation before body reads and a substituted capsule/ticket race.
- [ ] 3.2 Complete independent exact-content security review, scoped corrections, verification, builds and required CI for both source batches. Record the reviewed heads and unverified live steps.
- [ ] 3.3 Deliver the compatible source through ordinary publication while issuance stays disabled. Verify containing artifacts and keep production activation separate.
- [ ] 3.4 Synchronize and archive this change only after its non-optional delivery tasks have evidence. Verify strict OpenSpec validation before and after closure.
