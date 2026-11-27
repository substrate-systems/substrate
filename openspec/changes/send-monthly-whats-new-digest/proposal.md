# Proposal

## Why

Evermatter Cloud ships several releases a week. Home's "What's new" section shows the changes only to an owner who opens Home, and the assistant mentions them once in the next chat. An owner who rarely opens Home misses improvements they would use. A short monthly email reaches them without adding work per release.

## What Changes

- Each change's user note (a short title and one sentence, written in its pull request) is the one text about it. Home, each Evermatter GitHub release and this email all show that same title and sentence.
- Once a month, the system picks the 3 to 6 changes from that month's user notes that an owner is most likely to notice. Each one shows as its title and sentence. When fewer than 3 changes clear that bar, the month gets no email.
- The system queues one digest email per eligible owner through the existing email outbox. The email lists only changes that the owner's cell already runs, links to Home for the rest, and carries a one-click unsubscribe.
- Owners get a "Monthly update email" setting on Home, on by default. The unsubscribe link and the setting change the same value. Reviewer accounts never get the email.
- Nothing is sent before the operator approves the first month's email. After that, each month sends by itself.

Out of scope: an email per release, a digest of Substrate's own changes, and translated emails.

## Capabilities

### New Capabilities

- `exomem-whats-new-digest`: the monthly update email, its selection, its send rules and its opt-out.

### Modified Capabilities

- `exomem-home`: the owner's "Monthly update email" setting.

## Impact

- Evermatter: each release publishes its notes file as a release asset, so the digest reads notes without asking any cell, and starts its GitHub release text with a "What's new" section built from the same notes.
- One migration: the owner's digest setting and the month each digest covers.
- A monthly cron route, one email kind in the outbox registry, one template, and a one-click unsubscribe route.
- One model call per month to pick and rank the changes.
