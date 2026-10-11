## 1. C5 foundation

- [x] 1.1 Add C5, import holds, split grants, and CLI admission; verify real PostgreSQL grants, replay, and pre-C5 upgrade tests.

- [x] 1.2 Extend C5 with cleanup_running, cleanup_stopping, cleanup_pending, and exclusive discard intent through migration 0061; verify upgrade, grants, API status, and open-slot exclusion against PostgreSQL.

## 2. Tenant API

- [x] 2.1 Add shared principal resolution and tenant-bound import operations; verify authentication, isolation, lifecycle, idempotency, and concurrency through API tests.

## 3. Delivery boundary

- [x] 3.1 Run scoped tests, typecheck, lint, build, and strict OpenSpec validation; record exact results for independent review.
- [ ] 3.2 Complete independent review, full-suite checks, migration deployment, and OpenSpec closure in the integrated delivery.
