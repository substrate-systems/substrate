## Why

"Start with your email" answers every request with the same page: "If this address can get an email from us, it's on its way." Several cases queue no email at all. A person with an operator invitation but no account falls into the waitlist branch. A person already on the waitlist gets nothing when they ask again. A request over the per-address limit is dropped. The person waits for an email that never comes, and the page cannot tell them why.

Emails other than the owner sign-in link also wait for the minute-by-minute delivery job, and waitlist emails go last. A person who asks for an email expects it within seconds.

## What Changes

- Every accepted start request queues exactly one email that states the outcome for that address:
  - an owner gets a sign-in link (unchanged);
  - an address with a live, unused invitation gets a notice that its invitation is waiting, with the date it was sent and the date it expires. The notice carries no new link, so the invitation link already delivered keeps working;
  - a waiting person who asks again gets a short "you are still on the waitlist" note, at most one per 15 minutes per waitlist entry, and keeps their place;
  - a person with a live start link gets it again (unchanged);
  - a new address gets a waitlist place or a start link (unchanged).
- The request dispatches the email it queued right after its transaction commits. The delivery job stays as the fallback.
- The per-address limit becomes visible. It is taken before any branch, so it is the same for every address and reveals nothing about accounts. The page says the address was emailed several times this hour and when to try again.
- The page states "We sent an email to <address>. It says what happens next." The status, body shape and response-time floor stay identical for every account state.
- **Supersedes** the `launch-exomem-cloud-web` clause "A person who asks again while waiting ... MUST NOT receive a second waitlist email".

## Capabilities

### Modified Capabilities

- `exomem-hosted-access`: sign-in requests always produce an outcome email, dispatched at once; the per-address limit is visible.

## Impact

- `src/lib/exomem-hosted/access.ts`, `self-serve-admission.ts`, `email-outbox.ts`, `access-recovery.ts`
- `src/app/api/exomem/access/start/route.ts` and the recovery resend route
- `src/lib/email-templates/exomem-access` (two new emails)
- `src/app/exomem/_journey/copy.ts`, `start-flow.tsx`
- A migration that adds the two kinds to `exomem_email_outbox_kind_check`
- `docs/runbooks/exomem-cloud-operations.md`, "Start admission"
