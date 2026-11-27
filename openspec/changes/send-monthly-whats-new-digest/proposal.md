# Proposal

## Why

Evermatter Cloud ships two to three releases a day, about 100 user-visible changes a month. Home's "What's new" shows them only to an owner who opens Home, and the assistant mentions them once in the next chat. An owner who rarely opens Home misses improvements they would use. A short monthly email of the most noticeable changes reaches them without work per release.

## What Changes

- Each change's user note (a short title and one sentence, written in its pull request) is the one text about it. Home, each Evermatter GitHub release and this email all show that same title and sentence.
- Once a month, a model ranks the month's notes and picks the 3 to 6 changes an owner is most likely to notice. Each one shows as its title and sentence. When fewer than 3 clear that bar, the month gets no email.
- The operator approves each month's pick on an approval page for the first three months. Those approvals become the answer key for a real-model check, which decides whether later months send without approval.
- One digest email per eligible owner goes through the existing email outbox, at the lowest send priority. It lists only changes that the owner's cell already runs, links to Home for the rest, and carries a one-click unsubscribe.
- Owners get a "Monthly update email" setting on Home. The unsubscribe and the setting change the same value. Reviewer accounts never get the email.

Out of scope: an email per release, a digest of Substrate's own changes, and translated emails.

## Capabilities

### New Capabilities

- `exomem-whats-new-digest`: the monthly update email, its selection, its send rules and its opt-out.

### Modified Capabilities

- `exomem-home`: the owner's "Monthly update email" setting.

## Impact

- Evermatter, as its own OpenSpec change: each release attaches `release-notes.json` with only its own notes, and its GitHub release page starts with a "What's new" section from the same notes.
- Substrate's first model provider integration: a key, a timeout, one retry and a structured-output schema, for one call a month.
- A migration: the owner's digest setting, and each month's selection with its approval.
- A daily route, one email kind at a new lowest send priority, one template, the unsubscribe route and page, and the operator approval page.
- `sendTransactionalEmail` gains the `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- The privacy page names the monthly update email.
