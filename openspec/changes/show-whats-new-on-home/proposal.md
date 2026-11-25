# Proposal

## Why

An Exomem Cloud owner's cell upgrades often, and Home never says what changed. The owner misses improvements they would use. The release notes now ship inside each cell image in plain words (Evermatter change `tell-users-whats-new`), so Home can show them with no manual work.

## What Changes

- Home reads the cell's `whats_new` bootstrap section through the gateway, beside levels and activity.
- Home shows a "What's new" section with the notes of releases the owner has not dismissed, newest first, and a "Got it" button.
- Substrate keeps, per tenant, the version the owner dismissed at. Before the first dismissal, Home shows only releases after the cell was created, so a new owner sees nothing old.
- A cell image without the section, an unreachable cell or a release with no notes shows no section and no error.

Out of scope: email about updates, and notes for Substrate's own changes.

## Capabilities

### Modified Capabilities

- `exomem-home`: show the cell's release notes since the owner's last dismissal.

## Impact

- `src/lib/exomem-hosted/cloud-home-mcp.ts`: one more cell read, schema-checked.
- One migration: a nullable dismissed-version column on the tenant record.
- One owner-authenticated route that records a dismissal.
- Home client: the What's new section.
