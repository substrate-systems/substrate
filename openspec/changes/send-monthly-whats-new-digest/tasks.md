## 0. Decisions before the build

- [x] 0.1 The operator approves this proposal and decides the setting's default (`design.md`, Decided).
- [ ] 0.2 A Claude Design artifact holds the digest email, in the Evermatter email design, light and dark. It gates the first send (4.1), not the build.
- [ ] 0.3 Brevo's plan covers about 10,000 extra emails a month at the load target.

## 1. Notes source

- [ ] 1.1 Evermatter (its own OpenSpec change): every release attaches `release-notes.json` with only its own notes, with an empty `releases` list when it has none, as a required release step; its GitHub release page starts with a "What's new" section, written once per release.
- [x] 1.2 The daily route lists the month's releases with a read-only GitHub token, fetches and validates each release's notes with a timeout, keeps each fetched file with the month's record, and waits while any release's notes are missing.

## 2. Selection

- [x] 2.1 The model provider integration and the monthly call with a structured-output schema that returns ranked note identifiers (release version and position), and the 3-change bar.
- [x] 2.2 The operator approval page: the operator's blind pick first (a pick of none skips the month), then the selection, the notes left out, the missing releases with an accept-without action, and the rendered email; approve, edit, skip and stop; lapsed months.
- [x] 2.3 After three counted months (a blind pick and a ranking, whatever the operator decided) under one model identity and prompt hash, the approval page shows each month's score over the larger pick count, offers the recorded switch to send without approval only when every score is at least two thirds, and withdraws the offer when a later counted month scores lower.

## 3. Sending

- [x] 3.1 Migration: the owner's digest setting, and each month's selection with its approval.
- [x] 3.2 The `whats_new_digest` outbox kind at a new lowest send priority, stored as a send tier on the row with an index the claim reads, queued 200 rows per tick by the per-minute delivery job after the month's send time (24 hours after a switch-on build), with its send-time re-check and the provisional template (the design artifact of 0.2 replaces it before the first send).
- [x] 3.3 `List-Unsubscribe` and `List-Unsubscribe-Post` in `sendTransactionalEmail`; the POST-only unsubscribe route, its page and its key rotation (`..._PREVIOUS`); the Home setting.
- [x] 3.4 The privacy page names the monthly update email.
- [x] 3.5 The setting's default: off for existing owners with the Home invitation, on for a new owner whose signup showed the switch and left it on (a request without the choice starts off), and the audited operator action that turns it on for an existing owner who asked.

## 4. Acceptance

- [ ] 4.1 The first month's email, in the final design of 0.2 and approved by the operator, reaches owners once, after every other queued email; a one-click unsubscribe turns the setting off; the received test message's DKIM-Signature `h=` list covers `List-Unsubscribe` and `List-Unsubscribe-Post`, and Brevo adds no second `List-Unsubscribe`.
