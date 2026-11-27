## 0. Decisions before the build

- [x] 0.1 The operator approves this proposal and decides the setting's default (`design.md`, Decided).
- [ ] 0.2 A Claude Design artifact holds the digest email, in the Evermatter email design, light and dark.
- [ ] 0.3 Brevo's plan covers about 10,000 extra emails a month at the load target.

## 1. Notes source

- [ ] 1.1 Evermatter (its own OpenSpec change): every release attaches `release-notes.json` with only its own notes, with an empty `releases` list when it has none, as a required release step; its GitHub release page starts with a "What's new" section, written once per release.
- [x] 1.2 The daily route lists the month's releases with a read-only GitHub token, fetches and validates each release's notes with a timeout, keeps each fetched file with the month's record, and waits while any release's notes are missing.

## 2. Selection

- [x] 2.1 The model provider integration and the monthly call with a structured-output schema that returns ranked note identifiers (release version and position), and the 3-change bar.
- [x] 2.2 The operator approval page: the operator's blind pick first, then the selection, the notes left out, the missing releases with an accept-without action, and the rendered email; approve, edit and skip; lapsed months.
- [x] 2.3 After three approved months with the model and prompt unchanged, the approval page shows each month's share of the operator's blind picks, and offers the recorded switch to send without approval only when every share is at least two thirds.

## 3. Sending

- [ ] 3.1 Migration: the owner's digest setting, and each month's selection with its approval.
- [ ] 3.2 The `whats_new_digest` outbox kind at a new lowest send priority, queued 200 rows per tick by the per-minute delivery job, with its send-time re-check and the template from the design artifact.
- [ ] 3.3 `List-Unsubscribe` and `List-Unsubscribe-Post` in `sendTransactionalEmail`; the POST-only unsubscribe route and its page; the Home setting.
- [ ] 3.4 The privacy page names the monthly update email.
- [ ] 3.5 The setting's default: off for existing owners with the Home invitation, on for new owners unless they opt out at signup, and the audited operator action that turns it on for an existing owner who asked.

## 4. Acceptance

- [ ] 4.1 The first month's email, approved by the operator, reaches owners once, after every other queued email; a one-click unsubscribe turns the setting off.
