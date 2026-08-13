## 1. Reviewer bootstrap lineage

- [x] 1.1 Add regression coverage for exact fresh sibling Claude/OpenAI credentials and rejected bootstrap-history clients.
- [x] 1.2 Relax the consumed-bootstrap credential gate only for fresh exact sibling stages/clients.

## 2. Promotion runtime authority

- [x] 2.1 Add failing promotion runtime tests for strict persisted v2 health refresh and fail-closed route changes/errors.
- [x] 2.2 Extract/reuse persisted v2 target request construction and strict readiness comparison for promotion health probes.
- [x] 2.3 Refresh exact route/cell observations and profile authority under the cohort lock before existing promotion checks.

## 3. Operational proof

- [x] 3.1 Extend the paired acceptance and task-local PostgreSQL integration coverage.
- [x] 3.2 Update the Hosted alpha runbook for fresh sibling paired promotion clients and promotion-time health refresh.
- [x] 3.3 Run focused tests, PostgreSQL integration, full tests, typecheck, lint, build, strict OpenSpec validation, and inspect the diff.
