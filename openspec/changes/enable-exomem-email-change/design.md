## Context and decisions

The account dialog changes the address for sign-in links and future receipts. It preserves notes, connected apps and browser sessions.
Exomem currently resolves email through a user table shared with other products. Exomem needs its own identity authority.

### Product identity

Create `exomem_users` with the existing identity fields and unchanged UUIDs. Copy every identity referenced by an Exomem foreign key, including historical rows.
Live identities require an email. A deleted identity retains its UUID and dates as a tombstone, with email and verification time set to NULL.
Backfill fully deleted Exomem accounts as tombstones, rather than copying personal data that the completed deletion contract does not retain.
Switch every Exomem email read, identity upsert and reviewer authorization function to that authority.
Preserve the UUIDs in tenants, sessions, access tokens, invitations, transfer grants, OAuth grants, account blocks and reviewer credentials.
Other products keep their existing identities. A freed address may create another Exomem account after the final switch.
After full deletion, a new valid invitation to the erased address creates an independent identity and tenant.
An operator ban remains attached to the old principal and tenant; it does not follow an erased address.
The old credentials stay blocked. Live identities still retain their admission blocks. Store no address fingerprint to reconnect tombstones.

### Compatible releases

Release A adds and backfills the identity table while retaining the eight shared-user foreign keys.
Its admissions write the shared user and matching Exomem identity. A temporary tenant trigger copies a missing identity for older in-flight admissions.
For legacy re-admission, it may restore a deleted NULL-email tombstone only when the same tenant owner moves from fully deleted to nondeleted.
The trigger reads the shared identity bound by that admission. It never overwrites an active identity or restores one during deletion.
The migration also installs a deferred deletion bridge before releasing its tenant-table lock.
It scrubs the product identity at commit when the same tenant owner remains fully deleted, preserving older code's notice and address-based cleanup.
The deferred function rechecks current state, so deletion followed by re-admission in one transaction does not scrub a restored identity.
The theme migration separately clears the new preference when older code completes deletion.
Release A reads Exomem identity first. Its compatibility fallback never attaches a shared user whose Exomem identity has another address.
A newly verified invitation may restore a deleted tombstone needed by the shared foreign keys, but never overwrite a live canonical identity.

Release B follows protection and draining of deployments older than A. It repoints the eight foreign keys and creates new identities only in `exomem_users`.
Release B enables email changes. The temporary admission and deletion bridges remain through the rollback window, then a cleanup task removes them.
Rollback returns to A without reverting the identity schema or restoring shared-email authentication.

The split prevents an older deployment from authenticating a previous address after it changes. Its cost is a second release and temporary admission compatibility.
The delivery owner performs these steps; no extra human approval is required for ordinary release work.

### Email-change lifecycle

An owner starts a change through `POST /api/exomem/account/email-change` with normal session and CSRF checks. Reviewers cannot start one.
One pending request per tenant records the original address, proposed address, two token digests and a fifteen-minute expiry.
Confirmation and cancellation check expiry against fresh statement time after acquiring the tenant lock.
A new request supersedes its predecessor. Proposed addresses are not reserved; canonical email uniqueness is checked when confirmation commits.
The request transaction enqueues emails 16 and 16b with fixed recipients. Ordinary lifecycle mail resolves the current owner at delivery.

Confirmation and cancellation use `/confirm` and `/cancel` POST routes below the same API path. Link landing GET requests perform no mutation.
Link results reuse the existing journey layout, headings, notices and actions for confirmation, cancellation, expired links and failures.
The result pages introduce no separate layout. Confirmation and cancellation require an explicit action before their POST request.
Both operations lock the same request. Cancellation before confirmation prevents it; cancellation after confirmation never restores an old identity.
Confirmation checks expiry, the original identity and email uniqueness. It updates the email and invalidates old sign-in links through the existing generation.
Active sessions and OAuth grants stay valid. Collision responses are generic, and matching addresses never merge accounts.
Deletion cancels pending changes and scrubs their personal data through the existing deletion workflow.
The B migration owns an immediate tenant-status trigger that deletes email-change records and receipt-contact projections on `deletion_pending` or `deleted`.
This preserves cleanup when application code rolls back to A. The trigger leaves the principal and outbox alone.
Every change email carries its tenant identifier, so the existing terminal outbox scrub removes both fixed recipients before the deletion notice.
Request, confirmation and receipt workers lock the tenant first and recheck eligibility. Late completions update only an existing matching lease and version.
They never recreate purged rows. Immediate cleanup preserves fresh records created after re-admission, including within one transaction.
After capturing any fixed-recipient deletion notice, deletion also clears the Exomem identity's email and verification time in the scrub transaction.
The shared identity remains unchanged. Tombstones preserve foreign-key history without retaining another permanent copy of a deleted account's address.

### Receipt address

After confirmation, synchronize the existing Paddle customer in its configured environment. The shared customer's future receipts may follow the new address.
Never merge customers or rebind a subscription as part of this feature. Existing completed invoices remain unchanged.
Reuse the current provider transport and reconciliation lease pattern. Each attempt reads the latest confirmed address and customer binding.
A provider readback must match before the state becomes synchronized. Temporary failures remain pending and retry.
Permanent uniqueness or permission failures remain visible as conflict or failed states. They never undo the confirmed sign-in address.
Keep the known receipt address visible. Recovery permits another confirmed address change or the existing billing and support actions.

Use one receipt-contact projection per tenant, with a fresh UUID revision on every confirmation and no duplicate desired email.
Create its intent even before a customer is bound. The worker reads the current canonical address and proven entitlement binding.
Preserve an in-flight lease across confirmation; completion changes only the existing exact revision, lease and binding.
Perform provider calls outside database transactions, with a fresh claim check before PATCH and an independent GET afterward.
Targeted six-hour rechecks of existing pending or synchronized projections repair delayed provider writes; they scan no unrelated customers.
Permanent conflicts and failures stay frozen until another confirmed address. Last verified receipt addresses include their observation time.

### Proof and release

Verify migration compatibility, database-role grants, old-address isolation, confirmation/cancellation races and unchanged sessions against PostgreSQL.
Verify email delivery and provider synchronization at their boundaries with external sends and payments blocked.
Review the exact integrated diff independently before each release. Run the required full CI because identity reads span the Exomem application.
Inspect the approved account dialog in Chrome at desktop and phone widths, both themes, then perform read-only production verification.
