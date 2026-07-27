## Why

Wave 1 made acquisition observable through pageviews, download intent, and resolved download requests. The revenue and product-signal half of the Endstate funnel was still dark: checkout failures, Paddle outcomes, scheduled-job health, and supported-app searches existed only in browser or provider logs.

The missing events could not be reconstructed after launch traffic had passed. They also crossed reliability-sensitive paths, so analytics had to remain a bounded, best-effort observer.

## What Changes

- Capture checkout intent, completion, failure stage, and retry paths in the browser.
- Carry PostHog's anonymous browser `distinct_id` into Paddle `customData`, then use it for server-side subscription and supporter-purchase events when present.
- Keep analytics anonymous. Do not add `identify()`, person profiles, account ids, emails, licence ids, or machine ids to PostHog.
- Capture subscription transitions, recognition-only supporter purchases, cron outcomes, and aggregate update checks on the server.
- Capture debounced supported-app searches, including the zero-result signal.
- Keep session replay disabled and prevent autocapture on pages that render claim tokens or account email.
- Preserve the installed product's published no-telemetry boundary.

The legacy `/api/license/webhook` URL remains only as a Paddle compatibility endpoint for supporter purchases. It issues no licence or entitlement key, and its analytics event is `supporter_purchased`.

## Capabilities

### New Capabilities

- `conversion-analytics`: Observe the web acquisition-to-purchase funnel and operational outcomes without identifying people, weakening privacy boundaries, or degrading the flows being measured.

### Modified Capabilities

<!-- None. This adds observation without changing product or billing behaviour. -->

## Impact

**Code**

- Shared client and server event taxonomy and bounded capture helpers.
- Paddle checkout and webhook seams.
- Endstate claim handoff and supported-app search surfaces.
- Cron and updater routes.
- PostHog provider privacy configuration.

**Risk surface**

Billing, webhooks, and authenticated pages. Analytics failures must never change their outcome, and secret-bearing text must not reach automatic capture.

**Dependencies**

None new. `posthog-js` and `posthog-node` were already installed.
