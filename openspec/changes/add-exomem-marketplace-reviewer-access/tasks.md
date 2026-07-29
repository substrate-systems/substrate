## 1. Persist a Narrow Reviewer Binding

- [x] 1.1 Add failing migration and store tests for provider-scoped credential digests, Argon2id hashes, fixture version/digest, immutable reviewer-purpose invitations/tenants, expiry/revocation, and nullable reviewer attribution on sessions, OAuth transactions, and grants
- [x] 1.2 Add additive migration `0035` with one active credential per provider, immutable account-purpose propagation, and indexes/constraints for active lookup, provider binding, expiry, and revocation
- [x] 1.3 Implement store operations that validate an existing usable reviewer-purpose owner/tenant, create or rotate credentials atomically, bind only matching-provider OAuth transactions, create only attributed sessions, expose sanitized status, and revoke the derived session/OAuth graph idempotently

## 2. Implement Credential Security

- [x] 2.1 Add failing unit tests for generated entropy, normalization/digests, Argon2id hashing, dummy verification, expiry, rotation, feature-flag parsing, and secret-free results
- [x] 2.2 Implement the reviewer-access service with bounded Argon2id parameters, generated opaque credentials, constant-shape verification, and default-disabled configuration
- [x] 2.3 Add durable pre-KDF IP and keyed-username rate-limit rules and test fail-closed behavior when the limiter is unavailable

## 3. Wire Operator and OAuth Review Flows

- [x] 3.1 Add failing route tests for authenticated operator create/rotate/status/revoke responses and their one-time plaintext boundary
- [x] 3.2 Implement the operator reviewer-access API using existing operator authentication, durable limits, generic audit events, and no credential logging
- [x] 3.3 Add failing public-route and authorization-page tests for same-origin JSON, active matching-provider OAuth continuation, atomic transaction/session attribution, default-off rendering, generic failures, successful pre-bound session creation, and zero provisioning side effects
- [x] 3.4 Implement the reviewer sign-in route and authorization-screen form so successful authentication returns to the existing explicit OAuth confirmation flow

## 4. Revocation, Operations, and Regression Safety

- [x] 4.1 Add integration coverage that rotation, revocation, and credential expiry invalidate attributed sessions, pending authorization state, codes, grants, token families, refresh tokens, and access tokens without account blocking or tenant deletion
- [x] 4.2 Update ordinary invitation/OAuth/session queries so reviewer purpose is immutable, provider and credential bindings propagate, and every attributed access path fails after credential expiry while ordinary null-attribution behavior remains unchanged
- [x] 4.3 Extend sensitive-text and observability tests so submitted credentials, username digests, tenant/user IDs, fixture content, and failure details cannot enter public responses or logs
- [x] 4.4 Update the Hosted runbook with reviewer-purpose invitation/tenant preparation, governed fixture seeding, credential issue/share/rotate/revoke, feature enablement, provider review, incident response, and rollback

## 5. Verification and Delivery

- [x] 5.1 Run migration dry-run and disposable-Postgres upgrade/integration coverage plus focused reviewer, OAuth, session, rate-limit, observability, and marketplace tests
- [x] 5.2 Run strict OpenSpec validation, full tests, TypeScript checking, lint, format, and production build
- [x] 5.3 Obtain independent security review and end-to-end verification, then address actionable findings
- [ ] 5.4 Commit only the intended Substrate scope, integrate current remote main, push, and open a ready pull request with verification evidence

Provisioning/seeding the live reviewer tenant, configuring the feature flag, sharing credentials in provider portals, and completing clean provider-client evidence remain operator-controlled deployment work; repository tests never mark those live actions complete.
