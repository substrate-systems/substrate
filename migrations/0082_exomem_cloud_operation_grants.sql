-- Exomem contain-cloud-controller-compromise D4: the signed grant for an export or an import.
-- Substrate signs it when it creates an export request and when it records an import upload as
-- complete. Both columns stay NULL while no grant key is configured; the cells then log a missing
-- grant. cellctl relays the value to the Job and must never write it. scripts/exomem-cloud-grants.sql
-- gives exomem_cellctl no INSERT or UPDATE on these columns and gives substrate_app the one write.
ALTER TABLE exomem_cloud_exports ADD COLUMN operation_grant text;
ALTER TABLE exomem_cloud_imports ADD COLUMN operation_grant text;
