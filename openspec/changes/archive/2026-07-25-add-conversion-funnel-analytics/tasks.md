## 1. Analytics substrate

- [x] 1.1 Keep client and server event names in one browser-safe taxonomy module.
- [x] 1.2 Guard client capture until PostHog initialises.
- [x] 1.3 Bound server delivery, swallow analytics failures, and disable PostHog person-profile processing centrally.
- [x] 1.4 Expose the anonymous browser `distinct_id` for boundary threading.
- [x] 1.5 Remove the unused `identify` and reset lifecycle; no person model is introduced.

## 2. Checkout funnel

- [x] 2.1 Capture checkout intent, completion, SDK-init failure, open failure, and retry.
- [x] 2.2 Thread the anonymous `distinct_id` into Paddle `customData` when available.
- [x] 2.3 Keep checkout behaviour unchanged when analytics is blocked or unavailable.

## 3. Server-side outcomes

- [x] 3.1 Capture subscription lifecycle transitions after persistence.
- [x] 3.2 Capture recognition-only supporter purchases as `supporter_purchased`.
- [x] 3.3 Attribute supporter and subscription outcomes to the threaded anonymous id when available.
- [x] 3.4 Capture cron outcomes after authentication.
- [x] 3.5 Capture aggregate updater outcomes without a caller or machine identifier.
- [x] 3.6 Keep the legacy `/api/license/webhook` path only as a Paddle compatibility URL; no licence machinery remains behind it.

## 4. Web product signals

- [x] 4.1 Capture the web-side claim handoff and claim-code copy without altering the deep link or copied value.
- [x] 4.2 Capture debounced supported-app searches and a distinct zero-result event.
- [x] 4.3 Verify initial render does not emit a search event.

## 5. Privacy and telemetry boundary

- [x] 5.1 Keep all private Exomem routes behind the PostHog `before_send` filter.
- [x] 5.2 Disable autocapture on `/account` and `/endstate/claim/[token]` while preserving deliberate funnel events.
- [x] 5.3 Keep session replay disabled.
- [x] 5.4 Pin that the installed product receives no analytics identifier and update checks contain no persistent per-install identity.

## 6. Verification and closure

- [x] 6.1 Add contracts for analytics failure isolation, privacy filtering, anonymous threading, event naming, and the no-telemetry boundary.
- [x] 6.2 Run the test suite, lint, production build, and strict OpenSpec validation.
- [x] 6.3 Archive the completed change into the main `conversion-analytics` capability.

## Operational follow-ups

These are deployment checks, not repository implementation tasks: exercise Paddle sandbox against a deployed preview, confirm the preview PostHog host points at the correct region, and review PostHog event volume before ever considering session replay.
