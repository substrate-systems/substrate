# Design

## Context

User notes are one plain sentence per user-visible change, written in each Evermatter pull request (`user-notes/`). The release build assigns them to releases and bakes the notes file into the cell image (Evermatter change `tell-users-whats-new`). Home reads them from the owner's cell. Substrate records each cell's running release (`running_release`) and already sends fleet emails through the outbox with one dedupe key per fact (`exomem-service-notices`).

The product's load target is 10,000 tenants (`docs/runbooks/exomem-cloud-operations.md`). A month can hold 20 to 60 notes when several releases ship each week.

## Decisions

### D1. The digest reads the published notes file, not the cells

Each Evermatter release attaches the same notes file it bakes into the image as a release asset. The cron route fetches the newest release's asset once, with a timeout, and validates it against the notes schema (`release_notes_format`). Asking 10,000 cells for their notes would add 10,000 calls a month and would fail for every cell that is stopped.

Alternative: read notes from each owner's cell. Rejected for the cost above.

### D2. A model picks and shortens; a structured schema reads its answer

Which change an owner notices most is a judgement that no field in the notes holds. Once a month, one model call receives that month's notes and returns, through a structured-output schema, at most 6 selected notes, each with a headline of at most 70 characters. It returns an empty selection when fewer than 3 notes would interest a typical owner. Notes stay the source text; a headline that names a term the note does not contain is rejected.

Alternatives: an author-set rank in each note file (rejected: every author rates their own change high, and it adds a field to every pull request), and an operator pick each month (rejected: manual work each month).

The choice of model follows the measurement rules: the cheapest model that passes a real-model check on past months' notes. One call a month costs well under one cent.

### D3. Each owner gets only what their cell runs

The selection is per month and fleet-wide. Each owner's email keeps only the selected notes from releases at or below their cell's running release. An owner left with fewer than 3 gets no email that month. An owner whose cell is stopped, paused or deleted gets none.

### D4. Sending uses the outbox, once per owner and month

The cron route queues one `whats_new_digest` row per eligible owner, with the dedupe key `whats-new-digest:<YYYY-MM>:<tenant>`. The outbox's existing re-check at send time drops a row whose owner turned the setting off since it was queued. The route runs on the 2nd of each month, so releases on the last day of the month are included.

### D5. One setting, two ways to change it

The setting is a column on the tenant's account record, on by default. Home's account section changes it. The email's unsubscribe link carries a signed, single-purpose token and changes the same column with one POST (RFC 8058 `List-Unsubscribe-Post`). The link opens a page that confirms it and offers to turn it back on.

### D6. The first month waits for the operator

Until the operator approves, the route builds the month's selection and stops before queueing. The operator sees the selection and a rendered email, then approves. Later months send without approval.

## Risks

- A wrong or exaggerated headline reaches every owner. Mitigation: D6 for the first month, and the headline check in D2.
- An owner who never asked for email may mark it as spam. Mitigation: the monthly cap, the skip rule, and a one-click unsubscribe in every email.

## Open questions for the operator

- On by default for every paying owner, or off until the owner turns it on?
- The draft email's design comes from a Claude Design commission before the build.
