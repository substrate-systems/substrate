# Design

## Context

A user note is a short title and one plain sentence per user-visible change, written in each Evermatter pull request (`user-notes/`). The release build assigns each note to the first release that contains it. The cell image carries the notes of the 20 newest releases that have notes (`KEEP_RELEASES`), and Home reads them from the owner's cell.

Evermatter releases two to three times a day: 96 releases in October 2026 and 66 in November up to the 26th. Most releases now carry notes, about five notes a day on main in late November. So a month holds about 100 notes, and the 20-release file covers about a week.

Substrate records each cell's running release (`running_release`, which can be null). Fleet emails go through the outbox. The delivery job drains 20 rows a minute (`MAX_EMAILS_PER_TICK`), and `service-notice-fanout.ts` queues a fleet notice 200 rows per pass. The product's load target is 10,000 tenants (`docs/runbooks/exomem-cloud-operations.md`). Substrate has no model provider integration today.

## Decisions

### D0. One authored note feeds three places

The title and sentence that the pull request's author writes are the only text about a change that a person reads. Three outputs read them and add nothing of their own:

- Home's What's new lists each title, which opens its sentence.
- Each Evermatter GitHub release starts with a "What's new" section: each note's title, then its sentence, above the technical changelog. A release with no note gets no section.
- The monthly email lists the month's most noticeable changes, each as its title and sentence. A note without a title shows its sentence alone. The email ends with a link to Evermatter's public release list (`https://github.com/substrate-systems/evermatter/releases`), where every release's page starts with its "What's new" section, so an owner can see every change, not only the picked ones.

A reword of a note file reaches Home after the owner's next rollout and every later digest. A published release page, its assets and sent emails stay as they were.

Alternative: a separate summary written for the email or the release page. Rejected: two texts about one change drift apart.

### D1. Each release publishes its own notes, and the digest reads the whole month

Each Evermatter release attaches `release-notes.json`, which holds only that release's notes: version, date, and each note's title and sentence. A month's releases come from the GitHub releases list, paginated. The digest fetches each release's asset with a timeout and validates it against the notes schema.

Every release attaches the file, also a release with no notes, so a missing file always means notes missing, never no notes. The file uses the notes schema with at most one entry, its own release; a release without notes has an empty `releases` list. Evermatter's change defines that shape, and Substrate's validator reads the same one. Evermatter's part makes the asset a required step of every release, writes the release-page section once, and is its own OpenSpec change in that repository.

A month's selection waits until every release of the month has its file. The route tries again each day, reading the GitHub API with a read-only token and keeping each fetched file with the month's record, since a release asset never changes. The approval page names each release still missing; the operator can accept the month without it. A month with a missing release never sends without that acceptance. The first month a digest can cover is the first full month after Evermatter's change ships, because older releases carry no file.

Alternatives: the 20-release file inside the image (rejected: it covers about a week), and asking each cell (rejected: 10,000 calls a month, and a stopped cell answers nothing).

### D2. A model ranks; the operator approves until a measurement says otherwise

Which change an owner notices most is a judgement that no field in the notes holds. Once a month, one model call receives the month's notes, each identified by release version and position. Through a structured-output schema it returns at most 6 identifiers, ranked. It returns none when fewer than 3 notes would interest a typical owner. The email shows each picked note's own text, so the model cannot change what a change does.

This is Substrate's first model call. It runs with a timeout and one retry. On an outage the month waits, and the next day's run tries again.

The operator approves each month's selection for the first three months (D6). Before the page shows the model's ranking, it asks the operator to pick up to 6 notes from the month's list. That blind pick is the answer key, so the key never comes from the model's output. After three months, a real-model check compares the model's picks with the three blind picks. Later months send without approval only when, in each of the three months, the model's picks hold at least two thirds of the operator's picks; otherwise approval stays.

Alternative: an author-set flag per note. Rejected: it adds a field to every pull request, and the authors are agents that cannot judge what owners notice across a month.

### D3. Each owner gets only what their cell runs

Each owner's email keeps only the selected notes from releases at or below their cell's running release. An owner left with fewer than 3 gets no email that month. So does an owner whose running release is unknown, or whose cell is stopped, paused or deleted.

### D4. A daily route, a bounded fan-out and the lowest send priority

The route runs every day and is safe to repeat. On each run it:

1. builds the previous month's selection, if none exists yet;
2. stops while that selection waits for approval;
3. queues the month's digests 200 rows per pass, as `service-notice-fanout.ts` does.

The dedupe key is `whats-new-digest:<YYYY-MM>:<tenant>`. A missed day heals on the next run.

The `whats_new_digest` kind gets a new lowest send priority, below every existing kind and below the health canary's kinds. So invites, payment and deletion emails, maintenance notices and the canary never wait behind a digest. At the load target the queue sends about 8 hours of digests at the drain rate, all of it behind other mail.

### D5. One setting; only a POST unsubscribes

The setting is a column on the tenant's account record. Home's account section changes it. The email carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) with a signed, single-purpose token; the mail client's one-click POST turns the setting off. The link in the email body opens a page with a button that sends the same POST. A GET request never changes the setting, so link scanners cannot unsubscribe anyone. `sendTransactionalEmail` gains the two headers.

### D6. The operator approves the selection on an approval page

An operator page first takes the operator's blind pick (D2), then shows the model's selection, the notes left out, any release whose notes are missing, and the rendered email in light and dark. Approving it lets the next daily run queue the month. The first three months wait for this approval; later months follow D2's measurement.

## Risks

- A poor pick reaches every owner. Mitigation: the operator approves the first three months; the text is always the reviewed note.
- An owner who never asked for email may mark it as spam. Mitigation: the monthly cap, the skip rule, one-click unsubscribe, and the default in the open question.
- Brevo volume at the load target, about 10,000 extra emails a month, is not yet checked against the plan.

## Decided

- The email's design comes from a Claude Design commission, before the build.
- The setting's default. Existing owners were never offered an opt-out for product-update email when they signed up, and the account database is in the EU, where a "soft opt-in" needs that offer. So the migration sets the setting off for existing owners, and Home invites each of them once. The operator turns it on for the existing owners who have asked for the email. New owners get the opt-out at signup, the privacy page names the email, and the setting starts on for them. Every owner can turn it off on Home (D5).
