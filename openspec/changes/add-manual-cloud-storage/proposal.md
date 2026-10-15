# Manual Cloud storage

Owners need the approved storage control to buy more room without starting another subscription.
The new contract separates consent, payment, requested capacity and observed capacity across the billing and cell boundaries.
Existing Paddle transport, account authorization, PostgreSQL transactions and controller reconciliation provide the underlying services.
The application adds only the operation record and integration that those services do not provide.

## Scope

- Preview a provider-priced recurring addition and preserve every existing subscription item.
- Confirm once, recover interrupted updates, and offer inline payment-method recovery after a declined card.
- Preserve purchased capacity through subscription events and observe the matching volume before reporting success.
- Follow the supplied Home storage panel and shared components.

Automatic purchases, shrinking, removal and changes to rollout ownership remain outside this delivery.
