## 1. Deployment Safety

- [x] 1.1 Add red-first tests and a deployment gate that verifies an enabled Exomem Paddle product/price is active, linked, EUR 500, and monthly in the explicit environment without logging identifiers
- [x] 1.2 Extend the Vercel migration gate with red-first tests so only the exact explicitly enabled staging branch may migrate the named isolated staging database/schema boundary, preserving current production and ordinary-preview behavior
- [x] 1.3 Wire the catalog gate into Vercel builds and expose explicit operator check commands

## 2. Permanent Staging Operations

- [x] 2.1 Document the exact same-project Vercel branch/domain/variable contract, isolated Postgres setup, Paddle Sandbox webhook/catalog setup, one-slot capacity seed, rollback, and redaction rules
- [ ] 2.2 Create the isolated staging database/schema boundary, Paddle Sandbox €5 catalog/webhook resources, branch-scoped Vercel configuration, stable staging domain, and deployment without changing production values

## 3. Acceptance and Release

- [ ] 3.1 Run focused tests, strict OpenSpec validation, lint/type/build checks, and rendered staging inspection
- [ ] 3.2 Prove paid invitation → Sandbox checkout → duplicate/stale webhook handling → exactly one provision operation/cell → capture/fresh-chat recall → Sandbox portal, then clean the staging fixture
- [ ] 3.3 Run the read-only Live €5 catalog gate, remove or cancel the abandoned live draft transaction, and record redacted release evidence before inviting another person
