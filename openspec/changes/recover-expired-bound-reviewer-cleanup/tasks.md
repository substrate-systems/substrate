## 1. Eligibility and Refusal Coverage

- [x] 1.1 Add red-first unit coverage for the exact succeeded/bound reviewer state, exact replay, and refusal of customer, stale-fence, restore, non-ready, mismatched, multi-cell, live-assignment/bootstrap-authority, and conflicting-operation states
- [x] 1.2 Add PostgreSQL integration coverage proving the successful-bound recovery transaction gates authority and enqueues exactly one higher-fence target-free delete without rewriting the successful source
- [x] 1.3 Prove the existing request shape remains `{sourceOperationId, expectedFence}` and rejects tenant, cell, and volume selectors

## 2. Recovery Implementation

- [x] 2.1 Extend preflight eligibility with the exact successful-bound reviewer branch while preserving the existing unbound cleanup path
- [x] 2.2 Extend atomic recovery and replay with the same predicates, unchanged successful-source truth, exclusive locking, one-step fence advance, and one derived delete
- [x] 2.3 Update the Hosted alpha runbook with fail-assignment, preflight, recovery, reconcile, and externally verified destruction steps

## 3. Verification and Delivery

- [x] 3.1 Run focused tests, type checking, linting, formatting, and strict OpenSpec validation
- [x] 3.2 Obtain independent security and code review of the trust-boundary change and address substantive findings
- [ ] 3.3 Commit, update from remote main, push, open and merge the ready PR, then confirm production deployment
- [ ] 3.4 Recover the disposable reviewer tenant through the deployed path and verify authority, routing, provider resources, and capacity are gone before restarting promotion
