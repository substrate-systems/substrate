// The source offer that signed-in Cloud pages show. The two repositories are the whole service:
// the memory server and this control plane.

// The first memory-server release under FSL-1.1-ALv2. Every earlier release stays under
// AGPL-3.0-or-later. A licence change is a fixed historical point, not configuration.
export const FIRST_FSL_RELEASE = [0, 202, 0] as const;

const SERVER_REPOSITORY = "https://github.com/substrate-systems/evermatter";
const CONTROL_PLANE = {
  label: "Substrate (AGPL-3.0)",
  href: "https://github.com/substrate-systems/substrate",
};

/** The release as [major, minor, patch], or null when the text is not a plain version. */
function parseRelease(release: string): readonly [number, number, number] | null {
  const parts = release.replace(/^v/, "").split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function isFslRelease(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== FIRST_FSL_RELEASE[index]) return version[index] > FIRST_FSL_RELEASE[index];
  }
  return true;
}

/**
 * The server's licence for the release this account's cell runs. Without a readable release the
 * offer names both licences, because the page cannot tell which one covers the running code.
 */
function serverLicence(release: string | null | undefined): string {
  const version = typeof release === "string" ? parseRelease(release) : null;
  if (version === null) return `FSL-1.1-ALv2; releases before ${FIRST_FSL_RELEASE.join(".")}: AGPL-3.0`;
  return isFslRelease(version) ? "FSL-1.1-ALv2" : "AGPL-3.0";
}

/** The repositories the offer links, with the licence of each. */
export function sourceOfferLinks(release: string | null | undefined) {
  return [
    { label: `Evermatter (${serverLicence(release)})`, href: SERVER_REPOSITORY },
    CONTROL_PLANE,
  ] as const;
}

/**
 * What the offer says about the release this account's cell runs. `undefined` means the page has
 * no reading (no session, or the first poll has not returned), and the offer then says nothing
 * about a release; `null` means the reading found no recorded release for the cell's image.
 */
export function sourceOfferReleaseText(release: string | null | undefined): string | null {
  if (release === undefined) return null;
  return release === null ? "release not recorded" : `running release ${release}`;
}
