## Why

An app can drop its own stored login without the server ending the sign-in. Home then keeps saying "signed in", and the sign-out email waits until the idle window lapses, which can take up to 30 days. The owner sees nothing wrong while the app has stopped reaching their Exomem.

## What Changes

- A signed-in app row whose last recorded use is three days old or more reads "not used since `<date>`" and "reconnect it in the app if that's unexpected", in place of "used `<date>`".
- Quiet is measured in elapsed time, not calendar days, so a weekend gap does not trigger it.
- A row without a recorded last use makes no quiet claim. Signed-out and unknown rows keep their copy.
- Display only: nothing is signed out and no email is sent. The list query is unchanged.

## Capabilities

### Modified Capabilities

- `exomem-home`: app rows name a signed-in app that has gone quiet.

## Impact

- `src/app/exomem/home/home-view.ts` (`appMeta`) and its unit tests. No API, schema or query change.
