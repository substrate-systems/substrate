# Proposal

## Why

A sign-in link currently works only in the browser that requested it. Users need to finish sign-in from their email app or another device.

## What Changes

- Keep the requesting browser's challenge proof as the fast path.
- Ask other browsers to confirm the account email before atomic redemption.
- Authenticate only the completing browser and keep OAuth continuation bound to the requesting browser.
- Preserve single use, expiry, account privacy, recovery and explicit confirmation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-access`: Allow cross-browser sign-in after the server checks the expected account email.

## Impact

The magic-link redemption API, atomic database query and sign-in journey change. Existing session storage and email delivery remain in use. No migration or provider change is needed.
