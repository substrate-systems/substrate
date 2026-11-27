## 0. Decisions before the build

- [ ] 0.1 The operator approves this proposal and answers the open questions in `design.md`.
- [ ] 0.2 A Claude Design artifact holds the digest email, in the Evermatter email design, light and dark.

## 1. Notes source

- [ ] 1.1 Evermatter: each release attaches its notes file as a release asset.
- [ ] 1.2 Evermatter: each GitHub release with notes starts with a "What's new" section of each note's title and sentence, built from the same notes file.
- [ ] 1.3 The cron route fetches and validates the newest notes file, with a timeout.

## 2. Selection

- [ ] 2.1 The monthly model call with a structured-output schema that returns ranked note identifiers, and the 3-change bar.
- [ ] 2.2 A real-model check on past months' notes picks the model.

## 3. Sending

- [ ] 3.1 Migration: the owner's digest setting and the month's recorded selection.
- [ ] 3.2 The `whats_new_digest` outbox kind with its send-time re-check, and the template from the design artifact.
- [ ] 3.3 The one-click unsubscribe route and page, and the Home setting.
- [ ] 3.4 The operator approval gate for the first month.

## 4. Acceptance

- [ ] 4.1 The first month's email, rendered and approved by the operator, reaches owners once; the unsubscribe link turns the setting off.
