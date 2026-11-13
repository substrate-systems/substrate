## Why

"Start with your email" answers every request with the same page: "If this address can get an email from us, it's on its way." Several cases queue no email at all. A person with an operator invitation but no account falls into the waitlist branch. A person already on the waitlist gets nothing when they ask again. A request over the per-address limit is dropped. The person waits for an email that never comes, and the page cannot tell them why.

Emails other than the owner sign-in link also wait for the minute-by-minute delivery job, and waitlist emails go last. A person who asks for an email expects it within seconds.

## What Changes

- Every accepted start request ends with an email that states the outcome for that address. It queues one, except that a repeat inside the same fixed 15-minute window finds the email already queued:
  - an owner gets a sign-in link (unchanged);
  - an address with a live, unused invitation gets its invitation again under a fresh link, with the date the invitation expires. The new link replaces every earlier link for that invitation, so a person who lost the invitation email can still start. The invitation's expiry, kind and place in capacity do not change, and a stranger can replace the link at most once per fixed 15-minute window. While an email that carries the invitation's current link is being sent, the request replaces nothing and queues nothing, because that email is the answer;
  - a waiting person who asks again gets a short "you are still on the waitlist" note, at most one per fixed 15-minute window per waitlist entry, and keeps their place;
  - a person with a live start link gets it again (unchanged);
  - a new address gets a waitlist place or a start link (unchanged).
- The request dispatches the email it queued right after its transaction commits. The delivery job stays as the fallback.
- A refused request becomes visible. The answer names the limit (network, browser or address); none depends on the account, so it reveals nothing about accounts. The page says that this request sent no email, why, and when to try again in words. No limit says that the address was emailed.
- The page states "We sent an email to <address>. It says what happens next." The status, body shape and response-time floor stay identical for every account state.
- An address that a browser accepts but the server cannot use gets `400 invalid_email` after the bot check, and the form asks the person to check it. It no longer says that an email was sent.
- Each email becomes observable. The outbox stores the provider's message id; a Brevo webhook stores delivery and bounce events; an operator report shows counts and latency per email kind, with delivery shown as unknown until the provider reports; and the email health proof fails when a queued email stalls.
- A sign-in canary keeps the outcome proven without a person. The email health proof starts a sign-in for a configured address every 30 minutes, sends it inside the run and judges the previous canary: accepted within a minute of its due time and reported delivered within ten minutes. The canary never takes a Cloud place, and the delivery report keeps it out of its per-kind numbers.
- A failed bot check says that no email was sent.
- **Supersedes** the `launch-exomem-cloud-web` clause "A person who asks again while waiting ... MUST NOT receive a second waitlist email".

## Capabilities

### Modified Capabilities

- `exomem-hosted-access`: sign-in requests always produce an outcome email, dispatched at once; a refused request says that it sent nothing.

## Impact

- `src/lib/exomem-hosted/access.ts`, `self-serve-admission.ts`, `email-outbox.ts`, `access-recovery.ts`
- `src/app/api/exomem/access/start/route.ts` and the recovery resend route
- `src/lib/email-templates/exomem-access` (two new emails)
- `src/app/exomem/_journey/copy.ts`, `start-flow.tsx`
- A migration that adds the two kinds to `exomem_email_outbox_kind_check`
- A migration that adds `provider_message_id` to both outboxes, `due_at` to the email outbox and the table `exomem_email_provider_events`
- `src/app/api/webhooks/brevo`, `src/app/api/exomem/admin/email-delivery`, `functional-health.ts`
- `email-health-proof.ts` and `health-canary.ts` (the canary), `self-serve-admission.ts` (promotion skips it)
- `docs/runbooks/exomem-cloud-operations.md`, "Start admission" and "Email delivery"
