## 1. Service credentials

- [ ] 1.1 Add the migration for the service credential table: id, tenant, principal with its format check, unique secret digest, creation and revocation times, and a partial index on live credentials per tenant and principal.
- [ ] 1.2 Add issue, list and revoke functions. Issue locks the tenant row and refuses a third live credential with `SERVICE_CREDENTIAL_LIMIT`. Revoke is idempotent.
- [ ] 1.3 Add the service lookup by digest with the OAuth lookup's tenant, owner-block and cell predicates, returning the pass-through's access shape (design D3).
- [ ] 1.4 Add `/api/exomem/admin/service-credentials` with POST, GET and DELETE behind the admin bearer. The secret appears only in the POST response and in no log.

## 2. Gateway

- [ ] 2.1 Dispatch the bearer by prefix: `exs_` goes only to the service lookup, any other bearer only to the OAuth lookup. Apply design D4's limits.
- [ ] 2.2 Add the authenticated `GET /.well-known/exomem-cell` route (design D6).

## 3. Proof and delivery

- [ ] 3.1 Cover the requirements' scenarios with tests against real PostgreSQL where the code queries it.
- [ ] 3.2 Add the runbook section: issue, rotate, revoke, and the owner-authority caveat until Exomem's service-principal stage.
- [ ] 3.3 After the gateway image is published and the platform chart runs it, drill issue, rotation and revocation against a disposable Cloud tenant, and record the result.
