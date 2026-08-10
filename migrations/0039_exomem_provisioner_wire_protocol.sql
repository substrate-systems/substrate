-- Immutable outer provisioner-wire provenance. The current consumer speaks
-- strict v1 only; the later dual-protocol migration widens this allowlist.

ALTER TABLE exomem_lifecycle_operations
  ADD COLUMN provisioner_wire_protocol text NOT NULL
    DEFAULT 'exomem-cell-provisioner.v1';

ALTER TABLE exomem_lifecycle_operations
  ADD CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check
    CHECK (provisioner_wire_protocol IN ('exomem-cell-provisioner.v1'));

CREATE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.provisioner_wire_protocol IS DISTINCT FROM OLD.provisioner_wire_protocol THEN
    RAISE EXCEPTION 'provisioner wire protocol is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
BEFORE UPDATE ON exomem_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable();
