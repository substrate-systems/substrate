-- Admit claude.ai by host, and let its client row refresh itself.
--
-- 0048 deliberately left claude.ai off the admitted-host allowlist because a
-- promoted artifact's pinned configuration digest admitted it. Removing artifact
-- admission (simplify-hosted-launch-boundaries) removed that digest path, so
-- claude.ai -- one global Client ID Metadata Document for every Claude user --
-- had no admission path at all.
INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host)
VALUES ('claude', 'claude.ai')
ON CONFLICT DO NOTHING;

-- Expiry maintenance disables a CIMD client whose metadata lapses, and the
-- self-registration upsert is the only path that revives one on contact. That
-- upsert refuses operator-registered rows so an anonymous caller cannot rewrite
-- an operator's client. On an admitted host the operator adds nothing the host
-- does not already vouch for, and the refusal leaves the row disabled until a
-- person refreshes it by hand, every metadata lifetime. Hand those rows to the
-- self-registration path. A client that ever held reviewer bootstrap authority
-- keeps its operator provenance.
UPDATE exomem_oauth_clients AS client
SET auto_registered = true, updated_at = now()
WHERE client.admission_mode = 'cimd'
  AND client.auto_registered = false
  AND client.reviewer_bootstrap_ever_authorized = false
  AND EXISTS (
    SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
    WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
  );
