-- Bind every retained Paddle reference to the environment that issued it.
-- Receipt-backed rows can be backfilled safely. Rows without such proof stay
-- NULL and are deliberately blocked by runtime provider-call guards until an
-- authenticated webhook proves their environment or an operator repairs them.

ALTER TABLE exomem_entitlements
  ADD COLUMN provider_environment text,
  ADD COLUMN provider_provenance_unresolved_fingerprint text,
  ADD CONSTRAINT exomem_entitlements_provider_environment_value_check
    CHECK (provider_environment IS NULL OR provider_environment IN ('sandbox', 'production'));

UPDATE exomem_entitlements AS entitlement
SET provider_environment = CASE
      WHEN receipt.environment = 'live' THEN 'production'
      ELSE 'sandbox'
    END
FROM exomem_paddle_events AS receipt
WHERE entitlement.source_revision = receipt.paddle_event_id
  AND entitlement.provider_environment IS NULL
  AND (
    entitlement.provider_customer_ref IS NOT NULL
    OR entitlement.provider_subscription_ref IS NOT NULL
    OR entitlement.provider_transaction_ref IS NOT NULL
  );

UPDATE exomem_entitlements AS entitlement
SET provider_environment = CASE
      WHEN proof.environment = 'live' THEN 'production'
      ELSE 'sandbox'
    END
FROM (
  SELECT tenant_id, min(environment) AS environment
  FROM exomem_paddle_events
  WHERE tenant_id IS NOT NULL
  GROUP BY tenant_id
  HAVING count(DISTINCT environment) = 1
) AS proof
WHERE entitlement.tenant_id = proof.tenant_id
  AND entitlement.provider_environment IS NULL
  AND (
    entitlement.provider_customer_ref IS NOT NULL
    OR entitlement.provider_subscription_ref IS NOT NULL
    OR entitlement.provider_transaction_ref IS NOT NULL
  );

-- Freeze unresolved legacy references in place without making the whole row
-- immutable. Product lifecycle updates (especially deletion gating) remain
-- possible, while introducing or changing an unproven provider reference is
-- rejected. Verified webhook/application paths clear this marker when they
-- attach environment provenance.
UPDATE exomem_entitlements AS entitlement
SET provider_provenance_unresolved_fingerprint =
      COALESCE(entitlement.provider_customer_ref, '') || E'\x1f' ||
      COALESCE(entitlement.provider_subscription_ref, '') || E'\x1f' ||
      COALESCE(entitlement.provider_transaction_ref, '')
WHERE entitlement.provider_environment IS NULL
  AND (
    entitlement.provider_customer_ref IS NOT NULL
    OR entitlement.provider_subscription_ref IS NOT NULL
    OR entitlement.provider_transaction_ref IS NOT NULL
  );

ALTER TABLE exomem_entitlements
  ADD CONSTRAINT exomem_entitlements_provider_reference_provenance_check
    CHECK (
      (
        provider_customer_ref IS NULL
        AND provider_subscription_ref IS NULL
        AND provider_transaction_ref IS NULL
        AND provider_environment IS NULL
      )
      OR (
        source = 'paddle'
        AND (
          (
            provider_environment IS NOT NULL
            AND provider_environment IN ('sandbox', 'production')
          )
          OR (
            provider_environment IS NULL
            AND provider_provenance_unresolved_fingerprint IS NOT NULL
            AND provider_provenance_unresolved_fingerprint =
                  COALESCE(provider_customer_ref, '') || E'\x1f' ||
                  COALESCE(provider_subscription_ref, '') || E'\x1f' ||
                  COALESCE(provider_transaction_ref, '')
          )
        )
      )
    ) NOT VALID;

CREATE UNIQUE INDEX exomem_entitlements_provider_subscription_environment_idx
  ON exomem_entitlements (provider_environment, provider_subscription_ref)
  WHERE provider_environment IS NOT NULL
    AND provider_subscription_ref IS NOT NULL;

CREATE UNIQUE INDEX exomem_entitlements_provider_customer_environment_idx
  ON exomem_entitlements (provider_environment, provider_customer_ref)
  WHERE provider_environment IS NOT NULL
    AND provider_customer_ref IS NOT NULL;

CREATE UNIQUE INDEX exomem_entitlements_provider_transaction_environment_idx
  ON exomem_entitlements (provider_environment, provider_transaction_ref)
  WHERE provider_environment IS NOT NULL
    AND provider_transaction_ref IS NOT NULL;
