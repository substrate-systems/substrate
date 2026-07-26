# Retire Endstate lifetime licensing

Endstate's local product is free. Its paid offers are the recognition-only
Supporter tier and the Hosted Backup subscription. The lifetime-license SKU had
no customers and is no longer offered, so retaining its checkout, license minting,
activation endpoints, signing code, and manual test scripts only creates dead
surface area and an inaccurate product contract.

This change removes that lifetime-license surface while preserving:

- Supporter `transaction.completed` handling at `/api/license/webhook`.
- Hosted Backup subscription handling at `/api/webhooks/paddle`.
- The shared Paddle signature verification used by both destinations.

Historical archived changes remain unchanged as records of earlier decisions.
