// Owner sign-in is the fixed fifteen-minute authentication contract, shared by issuer, cookie and copy.
export const OWNER_SIGN_IN_TTL_MS = 15 * 60 * 1000;

// The three limits that can refuse a start request. A closed set that the server names in its answer and the page words.
export const START_LIMITS = ["ip", "browser", "address"] as const;
export type StartLimit = (typeof START_LIMITS)[number];
