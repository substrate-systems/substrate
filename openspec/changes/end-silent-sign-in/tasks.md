## 1. Outcome email for every accepted request

- [x] 1.1 Route an address with a live, unused, non-self-serve invitation and no tenant to an `invitation_waiting` email, before the waitlist branch
- [x] 1.2 Queue a `waitlist_still_waiting` email when a waiting person asks again, deduped per entry per 15-minute bucket
- [x] 1.3 Add both kinds to the outbox, their templates and the kind check constraint

## 2. Immediate dispatch

- [x] 2.1 Dispatch one outbox row by id under the existing lease, re-check, render and retry code
- [x] 2.2 Dispatch each start-admission row after its transaction commits; keep the delivery job as fallback

## 3. Visible per-address limit and page copy

- [x] 3.1 Report the per-address limit as `retryLimited` with its retry time, same status, body shape and time floor
- [x] 3.2 Sent state: "We sent an email to <address>. It says what happens next."; limited state names the try-again time

## 4. Docs and delivery

- [x] 4.1 Update the runbook's "Start admission" section
- [ ] 4.2 Production check: the invited address gets the invitation-waiting email, an owner gets a sign-in link, both measured request-to-delivered
