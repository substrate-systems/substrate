## 1. One definition

- [x] 1.1 Define `awaitsFirstPayment`, `hasConnectableEffectiveState` and `canConnect` in `entitlements.ts`
- [x] 1.2 Bind both state lists as parameters in the consent gate SQL
- [x] 1.3 Show `checkout_pending` as awaiting payment on Home

## 2. Consent page

- [x] 2.1 Compute the step on the server; render the signed-out view for unknown states and storage errors
- [x] 2.2 Lead the signed-out view with Sign in, then the invitation; put reviewer access in a disclosure
- [x] 2.3 Add Subscribe with in-page checkout, the grace notice, and the ended, paused and suspended stops

## 3. Admission, checkout and refusals

- [x] 3.1 Admit a paid OAuth invite without a grant or code, leaving the transaction open
- [x] 3.2 Return a settled checkout to the consent page while its OAuth transaction is live
- [x] 3.3 Redirect a refused or expired Connect to the consent page

## 4. Proof

- [x] 4.1 PostgreSQL: a pre-payment owner gets no grant; a paid OAuth invite mints no code and leaves the transaction open; settle returns to the consent page only with a live transaction
- [x] 4.2 Unit: step table, section order, refused Connect redirect, `checkout_pending` status
- [ ] 4.3 Production: walk the friend path end to end with a paid invite and a 100% discount code
