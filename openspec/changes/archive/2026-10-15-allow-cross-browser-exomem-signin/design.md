# Design

## Context

See proposal.md for motivation. The current redemption requires a token and an HttpOnly browser challenge. One PostgreSQL transaction creates the session and consumes the token.

## Goals / Non-Goals

Keep that transaction and the current challenge fast path. Add email confirmation without a token inspection endpoint, schema change or new session store. OAuth client and PKCE bindings stay unchanged.

## Decisions

- Accept an optional expected email and normalize it with the existing access utility. An explicitly supplied email must match the authoritative user address, even when the challenge matches.
- Without an email, attempt the current challenge path. Any unsuccessful attempt asks for email with the same response, independent of token validity. A proven recovery receipt can still explain expiry or use.
- Compare the expected email inside the locked redemption query, before session insertion or consumption. Keep all existing token, generation, delivery and tenant predicates.
- Return an internal challenge-match fact from redemption. Only that proof permits the current browser's OAuth continuation. Clear unrelated continuation cookies after cross-browser success.
- Reuse the existing journey frame, email field and actions. Navigation only captures the fragment; an explicit action submits redemption.

## Risks / Trade-offs

- A leaked link plus its account email can authenticate elsewhere. Email confirmation checks account intent; it is not another authentication factor.
- A wrong email must leave the link usable. A generic failure lets the person correct it without exposing the target address.
- A stale continuation in the completing browser could target another app. Cross-browser success clears it and goes to Home.

## Migration Plan

Deploy the server and client together through the ordinary release. No database migration is needed. Reverting the batch restores browser-only redemption.
