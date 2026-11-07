# Tasks

## 1. Gateway authority and byte routing

- [x] 1.1 Add signed origin proof and the canonical Cloud envelope with existing Ed25519 machinery. Verify cross-language decoding, audience separation, expiry and descriptor bounds.
- [x] 1.2 Reuse complete OAuth admission and revocation predicates for delegated origins. Verify real database cases for family revocation, blocked tenants and current client admission.
- [x] 1.3 Add the fixed streaming upload route and preserve existing MCP/transfer handling. Verify refusal before body reads, fixed routing, write-state checks, cancellation and identity isolation.
- [x] 1.4 Keep issuance disabled by default and document its configuration and undo. Verify unchanged default routing and selection of only compatible sandbox cells.

## 2. Compatible cell and CLI integration

- [x] 2.1 Integrate the final `capture-agent-files` source contract in the paired Exomem worktree. Verify personal tickets and current/legacy original bindings remain valid.
- [x] 2.2 Verify fresh gateway origin in the Cloud principal and private upload receiver. Verify complete ticket binding, replay refusal, streaming limits and hash failure without Source custody.
- [x] 2.3 Add Cloud envelope support to the existing CLI handoff path. Verify the actual terminal-postfiltered descriptor uploads exact bytes without another credential.

## 3. Integrated proof and delivery

- [ ] 3.1 Exercise MCP handoff, CLI upload, held handle, Source capture and exact original recovery in an isolated sandbox. Verify revocation before body reads and a substituted capsule/ticket race.
  Evidence: 19 of 19 sandbox checks; the stored original under `Knowledge Base/Sources/` is byte-identical to the uploaded bytes. Open: Cloud has no agent-facing exact-original recovery. A Cloud cell refuses `transfer_artifact` downloads and serves no `/download` route. This sandbox exercised no recovery path.
  Gateway route (add-cloud-media-store 5.2): `GET /download` is built in `handleCloudDownloadRequest`, with gateway unit evidence for 401 before cell contact, a path-bound `download` proof, `Range` and 206 passthrough, and no redirect following. It stays unticked: the cell route, the CLI, the sandbox run and the ingress rule (platform chart, 900 s read timeout, outside this repository) have no evidence yet.
- [x] 3.2 Complete independent exact-content security review, scoped corrections, verification, builds and required CI for both source batches. Record the reviewed heads and unverified live steps.
  Evidence: APPROVE with no blocking findings on Exomem 945964e3c and Substrate bccb2f5, required CI green on both heads. Live activation (cell key rendering, chart values, ingress rule, upload timeout) is unverified and stays with the release owner.
- [ ] 3.3 Deliver the compatible source through ordinary publication while issuance stays disabled. Verify containing artifacts and keep production activation separate.
- [ ] 3.4 Synchronize and archive this change only after its non-optional delivery tasks have evidence. Verify strict OpenSpec validation before and after closure.
