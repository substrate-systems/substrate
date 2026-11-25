-- OpenSpec change show-whats-new-on-home.
--
-- The release version at which the owner pressed "Got it" on Home's What's new.
-- NULL means the owner never dismissed it. The dismissal keeps the higher
-- version in one conditional UPDATE that compares the three numbers, so the
-- stored value must always be three plain integers that fit that comparison;
-- the route admits only release versions, and this check keeps any other
-- writer from storing a value the comparison cannot read.
SET LOCAL lock_timeout = '5s';

ALTER TABLE exomem_tenants
  ADD COLUMN whats_new_dismissed_version text
    CHECK (whats_new_dismissed_version ~ '^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$');
