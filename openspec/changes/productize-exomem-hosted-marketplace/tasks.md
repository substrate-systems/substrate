## 1. Public Product Contract

- [x] 1.1 Add failing tests that the public Exomem page distinguishes self-hosted from invite-only Hosted, removes the hosted end-to-end-encryption/future-service claims, and contains no guessed marketplace URL
- [x] 1.2 Update `/exomem` with the truthful Hosted private-alpha and install/sign-in/use journey while preserving the existing self-hosted product surface
- [x] 1.3 Add failing sitemap and route-content tests for stable Exomem privacy, terms, support, and setup URLs

## 2. Policy, Support, and Setup Surfaces

- [x] 2.1 Implement product-specific privacy and terms pages from the actual Hosted data/security boundary with revision dates; keep owner/legal approval as an external launch gate
- [x] 2.2 Implement public support and setup pages, including client-specific one-login guidance and custom instructions only as a labelled fallback
- [x] 2.3 Add every new canonical route to the sitemap and verify public rendering without authentication

## 3. OpenAI Domain Proof

- [x] 3.1 Add failing tests for exact plain-text response, no-store behavior, request-input ignoring, and fail-closed missing/blank/newline/oversized challenge values
- [x] 3.2 Implement `/.well-known/openai-apps-challenge` using only the request-time `OPENAI_APPS_CHALLENGE` deployment value without logging it
- [x] 3.3 Document safe issue, configuration, rotation, verification, and removal of the provider challenge value

## 4. OAuth and MCP Public Front Door

- [x] 4.1 Lock the reproduced `PUBLIC_BASE_URL_INVALID` production failure in deployment/runbook checks and add failing tests for database-free metadata, exact Origin rejection, and database-free missing/malformed authorization challenges
- [x] 4.2 Add the fail-closed Origin guard and reorder the existing durable IP limiter after bearer-shape validation while preserving it before token lookup and every existing valid-token check
- [x] 4.3 Add production-preflight coverage for attacker-Origin rejection and run the existing Hosted OAuth, MCP, paired-acceptance, privacy, rate-limit, and sensitive-text regressions

## 5. Redacted Production Readiness

- [x] 5.1 Add failing tests for successful public probes, redirects/mismatches/timeouts, secret redaction, and optional authenticated initialization/tool discovery
- [x] 5.2 Implement a deterministic marketplace preflight command that writes only route status, safe protocol/tool metadata, and contract digests
- [x] 5.3 Update the Hosted alpha runbook with canonical deployment checks, production probing, evidence handoff to Exomem, and incident/rollback steps

## 6. Verification and Delivery

- [x] 6.1 Run strict OpenSpec validation, focused tests, full unit tests, TypeScript checking, lint/format checks, and the production build
- [x] 6.2 Obtain an independent security/code review and address actionable findings
- [x] 6.3 Obtain an independent verifier pass over the public pages, challenge route, OAuth/MCP front door, and redacted probe
- [x] 6.4 Commit the intended Substrate scope, integrate current remote main, push the feature branch, and open a ready pull request with verification evidence

## 7. External Launch Handoff

The code change ends when tasks 1–6 are complete. Owner/legal approval, Production configuration and edge rules, canonical deployment, provider-issued domain proof, reviewer-token preflight, and evidence handoff remain operator-controlled launch work in the Hosted runbook; repository tests never mark them complete.
