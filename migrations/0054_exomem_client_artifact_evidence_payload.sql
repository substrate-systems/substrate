-- Pending artifacts retain the exact accepted signed envelope so certification
-- can re-verify it after activation terminalizes its temporary canary stage.
-- Historical rows remain nullable. Their exact signed envelope may be recorded
-- once by the re-import path before certification; it can never be replaced.

ALTER TABLE exomem_client_artifacts
  ADD COLUMN evidence_payload jsonb,
  ADD COLUMN evidence_provenance jsonb;

ALTER TABLE exomem_client_artifacts
  ADD CONSTRAINT exomem_client_artifacts_evidence_payload_object_check
  CHECK (evidence_payload IS NULL OR jsonb_typeof(evidence_payload) = 'object'),
  ADD CONSTRAINT exomem_client_artifacts_evidence_provenance_object_check
  CHECK (evidence_provenance IS NULL OR jsonb_typeof(evidence_provenance) = 'object'),
  ADD CONSTRAINT exomem_client_artifacts_evidence_pair_check
  CHECK ((evidence_payload IS NULL) = (evidence_provenance IS NULL));

CREATE FUNCTION exomem_client_artifact_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (OLD.evidence_payload IS NOT NULL
      AND NEW.evidence_payload IS DISTINCT FROM OLD.evidence_payload)
     OR (OLD.evidence_provenance IS NOT NULL
         AND NEW.evidence_provenance IS DISTINCT FROM OLD.evidence_provenance) THEN
    RAISE EXCEPTION 'client artifact evidence is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_client_artifact_evidence_immutable
BEFORE UPDATE ON exomem_client_artifacts
FOR EACH ROW EXECUTE FUNCTION exomem_client_artifact_evidence_is_immutable();
