# Design

## Billing

The server derives the owner, tenant, subscription and provider environment from the existing session and account records.
It reads the configured storage price from Paddle. Structured price metadata supplies bytes per unit and offered pack quantities.
The provider supplies quantity limits, billing interval, tax and money. Description text never determines capacity.
The server preserves the complete subscription item list and changes only the configured storage item's quantity.

One operation stores the baseline subscription fingerprint, target items, preview, added bytes and target volume size.
Only one unfinished operation may exist for a subscription. A transaction claims its update before the provider call.
The update uses `prorated_immediately` and `prevent_change`; no invented provider idempotency header is used.
An ambiguous response stays unknown until provider evidence resolves it. Polling never blindly repeats a charge.
A changed account, subscription or higher price requires a new preview before a charge.

Payment-method recovery uses the subscription's dedicated update-payment-method transaction.
Its origin and owner binding differ from a subscription checkout. A browser event cannot authorize storage.
Provider-confirmed payment and matching target items precede the desired capacity write.

## Capacity

Migration 0071 adds the durable operation, paid entitlement floor and controller observation fields.
The operation starts from the larger requested, previously grown and observed volume sizes, then adds the purchased bytes rounded up to GiB.
The existing `storage_gib` desired field carries that target and participates in the generation trigger.
The controller preserves the existing local growth floor and separate opt-in automatic growth contract.
It observes the bound claim's UID, resource version and status capacity, with the cell generation that capacity satisfies.
Neither a requested size nor a Ready pod proves completion. A changed claim identity cannot complete the original operation.
Subscription events preserve the paid entitlement floor; cancellation and deletion keep their existing lifecycle behavior.

## Acceptance and release

The highest-level check is one Sandbox addition through the real application, signed payment evidence and observed volume capacity.
Boundary tests cover duplicate confirmation, an interrupted response, account changes, existing items, and delayed or wrong-volume observations.
Chrome compares the supplied panel with the result at desktop and phone sizes in both themes.
The release keeps the feature unavailable until its catalogue metadata and controller capability exist.
A false unavailable result delays only a storage purchase; it prevents an unpriced charge or a false capacity promise.
Source publication and controller rollout retain their existing owners and window.
