/**
 * What Home's "What's new" shows, and the dismissal it keeps
 * (`show-whats-new-on-home`).
 *
 * The cell serves its release notes; this module decides which of them an
 * owner still has to see, and stores the one thing Substrate keeps: the
 * release version at which the owner pressed "Got it".
 */

import { executeExomemSql } from "./db";
import { compareReleaseVersions, releaseVersion, type ReleaseVersion } from "./release-tag";

/** One change: a short title when the release build wrote one (older images have none), and its sentence. */
export type WhatsNewNote = { title: string | null; text: string };

export type WhatsNewRelease = { version: string; released_on: string; notes: WhatsNewNote[] };

/** The cell reports a plain `X.Y.Z`; the release-tag module reads the tag form, `vX.Y.Z`. */
function parseVersion(version: string): ReleaseVersion | null {
  return releaseVersion(`v${version}`);
}

/** True for a version the dismissal may store: the format of a published release. */
export function isReleaseVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

/**
 * The releases the owner has not seen yet, newest first: newer than the
 * dismissed version and not newer than the version the cell runs. Before a
 * first dismissal the cut is the day the cell was created instead, so a new
 * owner meets no history. A release with no readable version or no note is
 * left out.
 */
export function selectWhatsNew(input: {
  running: string;
  releases: readonly WhatsNewRelease[];
  /** The stored dismissal; null before the owner's first. */
  dismissed: string | null;
  /** `YYYY-MM-DD` in UTC, the day the cell was created. */
  cellCreatedOn: string;
}): WhatsNewRelease[] {
  const running = parseVersion(input.running);
  if (!running) return [];
  const dismissed = input.dismissed === null ? null : parseVersion(input.dismissed);
  const shown: { release: WhatsNewRelease; version: ReleaseVersion }[] = [];
  for (const release of input.releases) {
    const version = parseVersion(release.version);
    if (!version || compareReleaseVersions(version, running) > 0) continue;
    const unseen = dismissed
      ? compareReleaseVersions(version, dismissed) > 0
      : release.released_on > input.cellCreatedOn;
    const notes = release.notes.filter((note) => note.text.trim() !== "");
    if (unseen && notes.length > 0) shown.push({ release: { ...release, notes }, version });
  }
  return shown
    .sort((a, b) => compareReleaseVersions(b.version, a.version))
    .map((entry) => entry.release);
}

type WhatsNewPrincipal = { userId: string; tenantId: string };

/** What the owner's own record says: the stored dismissal and the day the cell was created. */
export async function readWhatsNewAnchors(
  principal: WhatsNewPrincipal
): Promise<{ dismissed: string | null; cellCreatedOn: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:home-whats-new-anchors */
    SELECT tenant.whats_new_dismissed_version AS dismissed,
           to_char(cell.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_on
    FROM exomem_tenants AS tenant
    JOIN exomem_cloud_cells AS cell
      ON cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
    WHERE tenant.id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
    LIMIT 1
  `;
  const row = rows[0] as { dismissed: string | null; created_on: string } | undefined;
  return row ? { dismissed: row.dismissed, cellCreatedOn: row.created_on } : null;
}

/**
 * Stores the dismissal for the owner's own tenant row, keeping the higher of
 * the stored and posted versions. The comparison runs inside the UPDATE, so
 * two tabs that post at once cannot lower the stored version. `version` must
 * pass `isReleaseVersion`.
 */
export async function recordWhatsNewDismissal(
  principal: WhatsNewPrincipal,
  version: string
): Promise<void> {
  await executeExomemSql`
    /* exomem-cloud:home-whats-new-dismiss */
    UPDATE exomem_tenants AS tenant
    SET whats_new_dismissed_version = ${version}
    WHERE tenant.id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND (
        tenant.whats_new_dismissed_version IS NULL
        OR string_to_array(tenant.whats_new_dismissed_version, '.')::int[]
          < string_to_array(${version}, '.')::int[]
      )
  `;
}
