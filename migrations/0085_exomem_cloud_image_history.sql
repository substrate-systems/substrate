-- Exomem automate-cloud-releases D1: the image history.
--
-- One row for each image that was ever the fleet's cell_image, with the
-- release tag it came from and the time it was first recorded. The release
-- route (cloud-release.ts) adds a row the first time a digest becomes
-- cell_image and never rewrites one. The deploy principal may set only a
-- digest that this table does not hold, so a rerun or a withdrawn release
-- can never move the fleet back.
--
-- A null release_tag marks a seeded image that matches no published release.
-- The seed (scripts/seed-cloud-image-history.ts) fills the table from the
-- published releases and the live Cloud tables; this migration creates it
-- empty. scripts/exomem-cloud-grants.sql makes it append-only for
-- substrate_app and read-only for exomem_cellctl.

CREATE TABLE exomem_cloud_image_history (
  image text PRIMARY KEY,
  release_tag text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
