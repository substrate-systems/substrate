## Context

Wave 1 established the `/ingest` proxy, guarded client capture, and a server helper that flushes inside an 800 ms bound. Wave 2 extends that substrate across Paddle, cron routes, the updater endpoint, and product-signal surfaces.

The final implementation deliberately has no person identity model. PostHog's anonymous browser id is sufficient to join a website visit to a Paddle checkout. Introducing an account- or product-scoped identity would create permanent merges without a trustworthy cross-product identifier, and a claim token is a credential rather than an identity.

## Goals / Non-Goals

**Goals:**

- Observe every checkout outcome, including failure and retry paths.
- Join browser and Paddle events when an anonymous id is available.
- Record subscription, supporter-purchase, cron, updater, and app-search signals.
- Preserve billing and webhook behaviour when PostHog is missing, slow, or failing.
- Keep private Exomem routes and sensitive rendered text out of automatic capture.
- Preserve Endstate's local-product no-telemetry commitment.

**Non-Goals:**

- PostHog `identify()`, person profiles, account properties, or cross-product identity.
- Licence activation analytics; the lifetime licence model and activation endpoints are retired.
- Any telemetry or persistent identifier in the installed CLI or GUI.
- Enabling session replay.
- Building PostHog dashboards in this repository.

## Decisions

### Anonymous session continuity, not person identity

The browser's PostHog `distinct_id` is threaded into Paddle `customData`. Subscription and supporter webhooks reuse it when present; otherwise server captures use the existing unresolved-event convention. No call to `identify()` exists, and no account id, email, Paddle customer id, licence id, or machine id becomes a PostHog identity. Every server event forces `$process_person_profile: false`, including events with an explicit anonymous `distinctId`, because the Node SDK otherwise processes a person profile for them.

This gives the funnel the correlation it actually needs—visit → checkout → provider outcome—without inventing a permanent identity model. The `endstate://` deep link is explicitly excluded because the installed product sends no telemetry that could complete a join.

### The supporter webhook keeps its external URL only

Paddle may still be configured to call `/api/license/webhook`, so renaming the route would create an external cutover risk. The handler is now a recognition-only supporter flow: no licence generation, activation, deactivation, or entitlement key. Internal taxonomy and notification copy call it a supporter purchase.

### Captures follow business effects and cannot fail acknowledgements

Webhook order is signature verification → state or notification work → capture → acknowledgement. `captureServer` swallows delivery failures and races flush against an 800 ms timeout. Client capture is guarded and no-ops before PostHog initialises.

### The local product remains outside the analytics boundary

The website may observe its own controls and requests. The installed CLI and GUI receive no analytics id and gain no persistent per-install identifier. `/updates/latest.json` records only an aggregate request outcome, using the fixed unresolved server identity rather than caller data.

### Sensitive routes keep deliberate events but reject autocapture

Private Exomem routes are dropped at the `before_send` filter. `/account` and `/endstate/claim/[token]` keep pageviews and audited deliberate events, while `autocapture.url_ignorelist` blocks automatic text capture on those routes. Session replay remains disabled; if reconsidered, those routes must be block-listed rather than relying on input masking.

### Region configuration is operational, not inferred

Analytics-enabled deployments must set the project key and the matching PostHog host. Environments with no key intentionally no-op. Preview and production configuration are managed in Vercel; local development does not need analytics credentials.

## Risks / Trade-offs

**Anonymous ids rotate or disappear** → Some purchases remain unresolved when storage is cleared or the SDK is blocked. That is an honest limitation and preferable to fabricating a person.

**Analytics delays a provider response** → Server flush is bounded and failures are swallowed; tests pin that invariant.

**A compatibility route looks like a live licence system** → Comments, event names, and the archived spec state that `/api/license/webhook` is only an externally configured supporter endpoint. The retirement contract tests keep licence generation and activation absent.

**Automatic capture records sensitive text** → Private routes are filtered, sensitive public/authenticated routes ignore autocapture, and replay stays disabled.

## Verification

- Focused contracts cover anonymous id threading, taxonomy, failure isolation, sensitive-route filtering, no desktop identifier, and aggregate updater capture.
- Repository verification is `npm test`, `npm run lint`, `npm run build`, and strict OpenSpec validation.
- Paddle sandbox replay and PostHog volume review remain operational checks, not unfinished repository implementation.

## Open Questions

None. The identity question was resolved on 2026-07-26: remain anonymous and do not introduce a person model.
