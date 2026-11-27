# Design

## Context

A user note is a short title and one plain sentence per user-visible change, written in each Evermatter pull request (`user-notes/`). The release build assigns each note to the first release that contains it. The cell image carries the notes of the 20 newest releases that have notes (`KEEP_RELEASES`), and Home reads them from the owner's cell.

Evermatter releases two to three times a day: 96 releases in October 2026 and 66 in November up to the 26th. Most releases now carry notes: 25 notes merged on main from 26 to 27 November. So a month holds about 100 to 250 notes, and the 20-release file covers about a week.

Substrate records each cell's running release (`running_release`, which can be null). Fleet emails go through the outbox. The delivery job drains 20 rows a minute (`MAX_EMAILS_PER_TICK`), and `service-notice-fanout.ts` queues a fleet notice 200 rows per pass. The product's load target is 10,000 tenants (`docs/runbooks/exomem-cloud-operations.md`). Substrate has no model provider integration today.

## Decisions

### D0. One authored note feeds three places

The title and sentence that the pull request's author writes are the only text about a change that a person reads. Three outputs read them and add nothing of their own:

- Home's What's new lists each title, which opens its sentence.
- Each Evermatter GitHub release starts with a "What's new" section: each note's title, then its sentence, above the technical changelog. A release with no note gets no section.
- The monthly email lists the month's most noticeable changes, each as its title and sentence. A note without a title shows its sentence alone. The email ends with a link to Evermatter's public release list (`https://github.com/substrate-systems/evermatter/releases`), where every release's page starts with its "What's new" section, so an owner can see every change, not only the picked ones.

A reword of a note file reaches Home after the owner's next rollout. A published release page, its notes file and sent emails stay as they were, so a digest always shows the text its release shipped.

Alternative: a separate summary written for the email or the release page. Rejected: two texts about one change drift apart.

### D1. Each release publishes its own notes, and the digest reads the whole month

Each Evermatter release attaches `release-notes.json`, which holds only that release's notes: a schema version, the release version and date, and each note's title and sentence. A release belongs to the month of its publish date in UTC. A month's releases come from the GitHub releases list, paginated. The digest fetches each release's asset with a timeout and validates it against the notes schema.

Every release attaches the file, also a release with no notes, so a missing file always means notes missing, never no notes. The file uses the notes schema with at most one entry, its own release; a release without notes has an empty `releases` list. Evermatter's change defines that shape, and Substrate's validator reads the same one. Evermatter's part makes the asset a required step of every release, writes the release-page section once, and is its own OpenSpec change in that repository.

A month's selection waits until every release of the month has its file. The route tries again each day, reading the GitHub API with a read-only token and keeping each fetched file with the month's record, since a release asset never changes. The approval page names each release still missing; the operator can accept the month without it. A month with a missing release never sends without that acceptance. Evermatter's change attaches the file to every release published since the start of the previous UTC month, so it heals the releases that came before it. The first month a digest can cover is therefore the month before the one in which that change ships; an older month has releases with no file, and a month that reaches the daily route without them waits and names them. The change is still in review in Evermatter. The first month is a configuration value (`EXOMEM_WHATS_NEW_FIRST_MONTH`): the daily route builds nothing before it, or while it is unset, and the approval page says so.

Alternatives: the 20-release file inside the image (rejected: it covers about a week), and asking each cell (rejected: 10,000 calls a month, and a stopped cell answers nothing).

### D2. A model ranks; the operator approves until they lift approval on a measurement

Which change an owner notices most is a judgement that no field in the notes holds. Once a month, one model call receives the month's notes, each identified by release version and position. Through a structured-output schema it returns at most 6 identifiers, ranked. It returns none when fewer than 3 notes would interest a typical owner. The email shows each picked note's own text, so the model cannot change what a change does.

This is Substrate's first model call. It runs with a timeout and one retry. On an outage the month waits, and the next day's run tries again.

Every month needs the operator's approval (D6) until the operator lifts it. Before the page shows the model's ranking, it asks the operator to pick 3 to 6 notes from the month's list, or none to skip the month. A pick of none skips the month at once, and the model's ranking is still recorded for the measurement. That blind pick is the answer key, so the key never comes from the model's output.

A month counts toward the measurement when it has a recorded blind pick and a model ranking under one model and prompt, whatever the operator then decided: approved, edited, skipped, stopped or lapsed. Its score depends on the two picks:

- Exactly one side picked none: the month scores 0. The model and the operator disagree on whether to send.
- Both picked none: the month is quiet and does not count.
- Otherwise: the notes in both picks divided by the larger of the two pick counts, so a model that pads to 6 notes loses.

A ranking's identity is the model name from configuration, the model that the API reports on its answer, and the prompt version. The prompt version is a hash of the system prompt, the output schema and the note line format, so no number is kept by hand. A change to any part of the identity restarts the count, so the three months are never used to tune it. The three months read are the first three counted under one identity, so a later month cannot lift the verdict. After three counted months, the approval page shows each month's score. When every score is at least two thirds, the page offers the operator a switch to send later months without approval; the page records the scores, the identity and the operator's choice. A later counted month under the same identity that scores below two thirds withdraws the offer, and the page says so. Nothing lifts approval without that switch, and the operator can turn approval back on at any time. Three months at two thirds is the operator's accepted risk, not a confidence-bounded measurement: it can pass a model that is only moderately good. The recorded switch holds for the identity it was measured under, compared on the identity of each month's own ranking: after a change to any part, the next month needs approval again.

Alternative: an author-set flag per note. Rejected: it adds a field to every pull request, and the authors are agents that cannot judge what owners notice across a month.

### D3. Each owner gets only what their cell runs

Each owner's email keeps only the selected notes from releases at or below their cell's running release. An owner left with fewer than 3 gets no email that month. So does an owner whose running release is unknown, or whose cell is stopped, paused or deleted.

### D4. A daily route, a bounded fan-out and the lowest send priority

The route runs every day and is safe to repeat. On each run it:

1. builds the previous month's selection, if none exists yet, and lapses any earlier month that still waits (D6);
2. stops while that selection waits for approval.

The route has a time budget: `maxDuration` is 60 seconds, the ceiling of the Vercel Hobby plan that this project runs on. Each call to GitHub or the model gets the time the budget leaves, a call the budget cannot cover is not started, and the run stops with the month still waiting. The next daily run resumes from the month's record, so the platform never kills the run between two writes.

A month is ready to queue the moment the operator approves or edits it, with its final ordered selection stored. With the operator's switch on (D2), a built selection waits 24 hours as "ready, sends after <time>" before the fan-out starts, so the operator has a window to stop it. The per-minute delivery job then queues a ready month's digests 200 rows per tick, as `service-notice-fanout.ts` does for service notices, so 10,000 owners queue in 50 minutes. The operator can stop a month that is ready to queue or queued (D6): the month is skipped, the job queues no more of it, and a digest still waiting in the outbox is cancelled when it would send.

The dedupe key is `whats-new-digest:<YYYY-MM>:<tenant>`. A missed day heals on the next run.

Each tick reads one page of eligible owners in tenant id order, after a cursor kept with the month, in one statement with their running release. An owner with fewer than 3 notes gets no row. A page of fewer than 200 owners ends the pass: the month becomes `queued`, so later ticks do not scan it. Every owner's eligibility (setting on, live account, not a reviewer, a running and ready cell) is one SQL definition that the queue pass and the send-time check both read.

The `whats_new_digest` kind gets a new lowest send priority, below every existing kind and below the health canary's kinds. So invites, payment and deletion emails, maintenance notices and the canary never wait behind a digest. The outbox claim has three tiers: every other kind in the order it always had, then the kinds claimed last (the canary's among them), then the digest. At the load target the queue sends about 8 hours of digests at the drain rate, all of it behind other mail.

Each outbox row stores its send tier, set at insert from the kind's definition (0 for every other kind, 1 for the kinds claimed last, 2 for the digest). An index on the tier, `not_before` and `created_at` serves the claim's `ORDER BY`, so the claim reads the first ready row and stops. A queue of 10,000 pending digests costs a claim no more than an empty queue does. A claim ordered by a `CASE` over the kind could not use an index and would sort every pending row each minute.

### D5. One setting; only a POST unsubscribes

The setting is a column on the tenant's account record. Home's account section changes it. The email carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) with a signed, single-purpose token; the mail client's one-click POST turns the setting off. The link in the email body opens a page with a button that sends the same POST. A GET request never changes the setting, so link scanners cannot unsubscribe anyone. `sendTransactionalEmail` gains the two headers. The token is a MAC over the tenant and the purpose, under a signing key of its own that only this email uses, with no expiry. The header's address carries the token in its query, as a mail client posts to the address as given. The link in the body carries it in the fragment. The key rotates as the runbook's other keys do: the new key is the current one, the old one is set as `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS`, links signed by either verify during the overlap, and only the current key signs.

RFC 8058 requires that a message with a one-click unsubscribe carries a valid DKIM signature that covers `List-Unsubscribe` and `List-Unsubscribe-Post`; a mailbox provider ignores the one-click otherwise. Brevo's API reference accepts custom headers in a request's `headers` object and calls them "non-standard", and it does not say whether Brevo signs them or whether it adds its own `List-Unsubscribe`. So the first real message decides: task 4.1 reads that message's `DKIM-Signature` `h=` list and checks that both headers are in it.

### D6. The operator approves the selection on an approval page

An operator page first takes the operator's blind pick (D2), then shows the model's selection, the notes left out, any release whose notes are missing, and the rendered email in light and dark. The operator then takes one of three actions:

- **Approve** the selection as shown.
- **Edit** it: remove notes, add notes from the month's list, or reorder them, within 3 to 6; the text of a note never changes. The edited selection is approved.
- **Skip** the month: no owner receives a digest for it.

The operator can also **Stop** a month that is ready to queue or queued: the month becomes skipped, and a digest still waiting in the outbox is cancelled when it would send (the send-time check reads the month's state). A digest that Brevo already accepted cannot be recalled.

An approved month is queued by the per-minute delivery job (D4). A month still waiting when the next month's record is created (that month's first daily run) lapses: it is marked "lapsed, not approved" on the page, and no digest for it is ever sent, so owners never get two months at once. Every month needs this approval until the operator lifts it under D2.

## Risks

- A poor pick reaches every owner. Mitigation: the operator approves, edits or skips every month until they lift approval; the text is always the reviewed note. After the switch, a built selection waits 24 hours and the operator can stop it at any time before the digests send. A stop cancels digests that still wait in the outbox, not ones that Brevo already accepted.
- The measurement is three months at two thirds, not a confidence-bounded test. It is the operator's accepted risk for lifting approval, and a later counted month that scores lower withdraws the offer.
- An owner who never asked for email may mark it as spam. Mitigation: the monthly cap, the skip rule, one-click unsubscribe, and the default in the open question.
- Brevo volume at the load target, about 10,000 extra emails a month, is not yet checked against the plan.

## Decided

- The email's design comes from a Claude Design commission (task 0.2). The first send uses that final design: task 0.2 gates the first send (task 4.1), not the build. The build ships a provisional template that follows the existing Evermatter emails, and the final design replaces only the renderer module's markup.
- The setting's default. Substrate is an EU company emailing customers mostly in the EU, so EU e-privacy rules apply, and their "soft opt-in" needs an opt-out offered when the address was collected. Existing owners were never offered one for product-update email. So the migration sets the setting off for existing owners, and Home invites each of them once, until they turn it on or dismiss the invitation. The operator turns it on for an existing owner who asked for the email, with an audited operator action on that tenant. New owners see the opt-out at signup, and the privacy page names the email: the setting starts on unless they opt out. Only a client that showed the switch may opt an owner in, so a signup request that does not state the choice starts the setting off. Every owner can turn it off on Home (D5).
