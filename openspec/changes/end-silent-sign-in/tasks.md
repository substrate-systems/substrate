## 1. Outcome email for every accepted request

- [x] 1.1 Route an address with a live, unused, non-self-serve invitation and no tenant to an `invitation_waiting` email, before the waitlist branch
- [x] 1.2 Queue a `waitlist_still_waiting` email when a waiting person asks again, deduped per entry per fixed 15-minute window
- [x] 1.3 Add both kinds to the outbox, their templates and the kind check constraint
- [x] 1.4 Give an invited address a fresh invitation link: replace the invitation's token in the transaction that queues the email, only when a new email is queued, keeping its expiry, kind and entitlement
- [x] 1.5 Make the invitation-waiting email carry that link and say that it replaces earlier invitation links; cancel an email whose link was replaced again before it was sent
- [x] 1.6 Carry the fresh link in a friend invitation's reminder that is still queued
- [x] 1.7 Replace nothing and queue nothing while an email with the invitation's current link is under a running send lease; lock the invitation's unsent emails, then the invitation, the order of a send's settlement, so a claim and a replacement cannot interleave and a settlement cannot deadlock with a request
- [x] 1.8 Cancel, not fail, an invitation-waiting email queued before it carried a link

## 2. Immediate dispatch

- [x] 2.1 Dispatch one outbox row by id under the existing lease, re-check, render and retry code
- [x] 2.2 Dispatch each start-admission row after its transaction commits; keep the delivery job as fallback

## 3. Visible per-address limit and page copy

- [x] 3.1 Report the limit that refused a request as `limitedBy` (ip, browser or address) with its retry time, same status, body keys and time floor
- [x] 3.2 Sent state: "We sent an email to <address>. It says what happens next."; each limited state says that this request sent nothing and gives the wait in words

## 4. Docs and delivery

- [x] 4.1 Update the runbook's "Start admission" section
- [ ] 4.2 Production check: the invited address gets the invitation-waiting email with a link that opens the invitation, an owner gets a sign-in link, both measured request-to-delivered

## 5. Email delivery is observable

- [x] 5.1 Store the provider's message id (angle brackets removed) on both outboxes when the provider accepts a send, and the first due time of each email
- [x] 5.2 Receive Brevo's transactional events at `POST /api/webhooks/brevo` with a constant-time bearer check; store the closed event set, once per message, event and time, and no address, subject, reason or IP; delete rows after 30 days
- [x] 5.3 Emit content-free events on acceptance (kind, attempts, queue time), on failure and cancel (kind, error code), and when a request limit refuses a start request (which limit)
- [x] 5.4 Add `GET /api/exomem/admin/email-delivery` with per-kind counts, queue and delivery latency, and honest unknowns
- [x] 5.5 Fail the email health proof for a stalled or recently failed queued email; read the overdue time from `EXOMEM_HEALTH_EMAIL_OVERDUE_SECONDS`
- [x] 5.6 Runbook: webhook registration, the delivery report, the health proof and the measured delivery times
- [ ] 5.7 Production: set `BREVO_WEBHOOK_TOKEN`, register the webhook, then read the report and record request-to-delivered for the invited address and an owner

## 6. Malformed address

- [x] 6.1 The start route answers `400 invalid_email` after the bot check for an address the server cannot use; the form shows a "Check the address" error
