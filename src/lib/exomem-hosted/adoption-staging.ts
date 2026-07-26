// Shared, dependency-free constants for adoption staging intake.
//
// The run-id slug pattern is enforced server-side when minting the staging
// upload grant (transfers.ts) and used browser-side to generate run slugs
// (adopt-state.ts). It lives here — importable from both bundles — so the two
// can never drift apart.
export const ADOPTION_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
