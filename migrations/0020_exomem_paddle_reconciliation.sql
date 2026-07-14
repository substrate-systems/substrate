-- Durable scheduling, leasing, and bounded retry state for periodic Paddle
-- subscription reconciliation. Existing eligible subscriptions become due
-- immediately; successful passes advance their next check by six hours.

ALTER TABLE exomem_entitlements
  ADD COLUMN provider_reconcile_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN provider_reconciled_at timestamptz,
  ADD COLUMN provider_reconcile_lease_owner uuid,
  ADD COLUMN provider_reconcile_lease_expires_at timestamptz,
  ADD COLUMN provider_reconcile_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN provider_reconcile_error_code text,
  ADD CONSTRAINT exomem_entitlements_provider_reconcile_attempts_check
    CHECK (provider_reconcile_attempts >= 0),
  ADD CONSTRAINT exomem_entitlements_provider_reconcile_lease_check
    CHECK (
      (provider_reconcile_lease_owner IS NULL) =
      (provider_reconcile_lease_expires_at IS NULL)
    );

CREATE INDEX exomem_entitlements_provider_reconcile_ready_idx
  ON exomem_entitlements (provider_reconcile_after, tenant_id)
  WHERE source = 'paddle'
    AND provider_subscription_ref IS NOT NULL
    AND source_state <> 'cancelled';
