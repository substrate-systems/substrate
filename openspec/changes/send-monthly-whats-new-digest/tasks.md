## 0. Decisions before the build

- [ ] 0.1 The operator approves this proposal and answers the open question in `design.md`.
- [ ] 0.2 A Claude Design artifact holds the digest email, in the Evermatter email design, light and dark.
- [ ] 0.3 Brevo's plan covers about 10,000 extra emails a month at the load target.

## 1. Notes source

- [ ] 1.1 Evermatter (its own OpenSpec change): every release attaches `release-notes.json` with only its own notes, an empty list when it has none, as a required release step; its GitHub release page starts with a "What's new" section, written once per release.
- [ ] 1.2 The daily route lists the month's releases with a read-only GitHub token, fetches and validates each release's notes with a timeout, keeps each fetched file with the month's record, and waits while any release's notes are missing.

## 2. Selection

- [ ] 2.1 The model provider integration and the monthly call with a structured-output schema that returns ranked note identifiers (release version and position), and the 3-change bar.
- [ ] 2.2 The operator approval page: the operator's blind pick first, then the selection, the notes left out, the missing releases with an accept-without action, and the rendered email.
- [ ] 2.3 After three approved months, a real-model check against the operator's blind picks: later months send without approval only if the model's 6 hold at least 4 of the operator's 6 in each month.

## 3. Sending

- [ ] 3.1 Migration: the owner's digest setting, and each month's selection with its approval.
- [ ] 3.2 The `whats_new_digest` outbox kind at the lowest send priority, queued in bounded passes, with its send-time re-check and the template from the design artifact.
- [ ] 3.3 `List-Unsubscribe` and `List-Unsubscribe-Post` in `sendTransactionalEmail`; the POST-only unsubscribe route and its page; the Home setting.
- [ ] 3.4 The privacy page names the monthly update email.
- [ ] 3.5 The setting's default as the operator answers: the migration default for existing owners and, if the recommendation holds, the one Home invitation and the signup opt-out for new owners.

## 4. Acceptance

- [ ] 4.1 The first month's email, approved by the operator, reaches owners once, after every other queued email; a one-click unsubscribe turns the setting off.
