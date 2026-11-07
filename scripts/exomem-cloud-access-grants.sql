-- Access records stay outside gateway credentials. The receiver writes receipts;
-- cellctl reads exact versions and appends derived metadata and placement evidence.
DO $access_grants$
BEGIN
  IF to_regclass('exomem_cloud_access_receipts') IS NOT NULL THEN
    REVOKE ALL ON exomem_cloud_access_receipts, exomem_cloud_access_records,
      exomem_cloud_access_entries, exomem_cloud_placements FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_gateway') THEN
      REVOKE ALL ON exomem_cloud_access_receipts, exomem_cloud_access_records,
        exomem_cloud_access_entries, exomem_cloud_placements FROM exomem_gateway;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'substrate_app') THEN
      REVOKE ALL ON exomem_cloud_access_receipts, exomem_cloud_access_records,
        exomem_cloud_access_entries, exomem_cloud_placements FROM substrate_app;
      GRANT SELECT, INSERT ON exomem_cloud_access_receipts TO substrate_app;
      GRANT SELECT ON exomem_cloud_access_records, exomem_cloud_access_entries,
        exomem_cloud_placements TO substrate_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_cellctl') THEN
      GRANT SELECT, UPDATE ON exomem_cloud_access_receipts TO exomem_cellctl;
      GRANT SELECT, INSERT ON exomem_cloud_access_records, exomem_cloud_access_entries TO exomem_cellctl;
      GRANT SELECT, INSERT, UPDATE ON exomem_cloud_placements TO exomem_cellctl;
      GRANT USAGE, SELECT ON SEQUENCE exomem_cloud_access_entries_id_seq TO exomem_cellctl;
    END IF;
  END IF;
END
$access_grants$;

DO $access_auth_grants$
BEGIN
  IF to_regclass('exomem_cloud_access_grants') IS NOT NULL THEN
    REVOKE ALL ON exomem_cloud_access_grants, exomem_cloud_access_sessions,
      exomem_cloud_access_challenges FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_gateway') THEN
      REVOKE ALL ON exomem_cloud_access_grants, exomem_cloud_access_sessions,
        exomem_cloud_access_challenges FROM exomem_gateway;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_cellctl') THEN
      REVOKE ALL ON exomem_cloud_access_grants, exomem_cloud_access_sessions,
        exomem_cloud_access_challenges FROM exomem_cellctl;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'substrate_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON exomem_cloud_access_grants,
        exomem_cloud_access_sessions, exomem_cloud_access_challenges TO substrate_app;
    END IF;
  END IF;
END
$access_auth_grants$;
