// The source offer that signed-in Cloud pages show. The two repositories are the whole service:
// the memory server and this control plane.
import { compareReleaseVersions, releaseVersion } from "./release-tag";

// The first memory-server release under FSL-1.1-ALv2. Every earlier release stays under
// AGPL-3.0-or-later. A licence change is a fixed historical point, not configuration.
export const FIRST_FSL_RELEASE = "v0.202.0";

const FSL = "FSL-1.1-ALv2";
const AGPL = "AGPL-3.0-or-later";
const SERVER_REPOSITORY = "https://github.com/substrate-systems/evermatter";
const CONTROL_PLANE = {
  label: `Substrate (${AGPL})`,
  href: "https://github.com/substrate-systems/substrate",
};

type ServerLicence = "fsl" | "agpl" | "unknown";

/** Which licence covers the server release a cell runs; unknown when the release is not a tag. */
function serverLicence(release: string | null | undefined): ServerLicence {
  const version = typeof release === "string" ? releaseVersion(release) : null;
  if (version === null) return "unknown";
  return compareReleaseVersions(version, releaseVersion(FIRST_FSL_RELEASE)!) >= 0 ? "fsl" : "agpl";
}

const SERVER_LABEL: Record<ServerLicence, string> = {
  fsl: `Evermatter (${FSL})`,
  agpl: `Evermatter (${AGPL})`,
  unknown: `Evermatter (${FSL}; before ${FIRST_FSL_RELEASE}: ${AGPL})`,
};

/**
 * The repositories the offer links, with the licence of each. A readable release links its own
 * tag, which is the corresponding source and carries that release's licence file.
 */
export function sourceOfferLinks(release: string | null | undefined) {
  const tagged = typeof release === "string" && releaseVersion(release) !== null;
  return [
    {
      label: SERVER_LABEL[serverLicence(release)],
      href: tagged ? `${SERVER_REPOSITORY}/tree/${release}` : SERVER_REPOSITORY,
    },
    CONTROL_PLANE,
  ] as const;
}

/**
 * The plain terms of the server licence, shown whenever the running code may be under FSL: free
 * to self-host and for any use except a competing product, and Apache-2.0 two years after release.
 */
export function sourceOfferLicenceNote(release: string | null | undefined): string | null {
  if (serverLicence(release) === "agpl") return null;
  return `${FSL}: free to self-host and for any use except a competing commercial product or service; each release becomes Apache-2.0 two years after it is published.`;
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
