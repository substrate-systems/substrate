// The release workflow publishes only on tags of this form (vMAJOR.MINOR.PATCH);
// a format check that also yields the numbers the forward-only rule compares.
// No dependencies, so client components can import it.
const RELEASE_TAG = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export type ReleaseVersion = readonly [number, number, number];

export function releaseVersion(tag: string): [number, number, number] | null {
  const match = RELEASE_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
