## 1. Recovery boundary

- [ ] 1.1 Add red-first SQL-shape and real-PostgreSQL tests for exact eligibility, refusal, replay, audit, and no-provider local-finalizer completion
- [ ] 1.2 Implement shared preflight and cohort-locked one-shot recovery for the exact terminal reviewer delete

## 2. Operator contract

- [ ] 2.1 Add authenticated contracts-route actions with exact body validation and content-free responses
- [ ] 2.2 Add route tests for authentication, malformed selectors, refusal, enqueue, and replay

## 3. Operations and delivery

- [ ] 3.1 Document the terminal-delete replay and exact postconditions in the Hosted runbook
- [ ] 3.2 Run PostgreSQL, unit, type, lint, build, and strict OpenSpec verification
- [ ] 3.3 Obtain independent security/correctness review, commit, publish a ready PR, and deploy only after green CI
