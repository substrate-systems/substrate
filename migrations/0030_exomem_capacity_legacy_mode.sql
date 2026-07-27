-- A missing allocation is corruption unless this retained pre-MCP tenant was
-- explicitly marked during an audited migration/repair.
ALTER TABLE exomem_tenants
  ADD COLUMN legacy_unmetered boolean NOT NULL DEFAULT false;
