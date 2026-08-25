## 1. Payment-First Paid Invites

- [ ] 1.1 Reuse the existing pool lock and invite fields to prevent outstanding delivered paid operator invites from oversubscribing alpha capacity
- [ ] 1.2 Make paid invite redemption retain its existing owner, tenant, entitlement, session, and capacity transaction while omitting the initial operation; keep complimentary redemption unchanged

## 2. Existing Checkout and Activation

- [ ] 2.1 Selectively restore the existing empty-body checkout route, billing summary, and Home checkout action for an awaiting-payment Paddle owner while public admission remains `410`
- [ ] 2.2 Extend the existing Paddle event-store transaction to insert and attach one normal `initial-provision` operation on authoritative active or trialing projection
- [ ] 2.3 Cover created/activated ordering, duplicate and stale events, missing allocation/target rollback, checkout recovery, and Endstate isolation

## 3. Thin Operator Page

- [ ] 3.1 Build `/exomem/operator` over the existing capacity and invitation APIs, retaining the pasted bearer only in page memory and defaulting invitations to paid
- [ ] 3.2 Cover bearer non-persistence, noindex/no-store behavior, paid and complimentary actions, capacity refusal, and rendered desktop/narrow/focus/error states

## 4. Release Proof

- [ ] 4.1 Update the Hosted alpha runbook for the existing €5 Paddle configuration gate, historical self-serve invite check, payment-before-provisioning proof, and rollback
- [ ] 4.2 Run focused unit, route, PostgreSQL integration, webhook, security, static, and Chrome DevTools verification
- [ ] 4.3 Prove one Paddle sandbox invitation from redemption through payment to exactly one provisioning operation, then repeat as one controlled production invitation
