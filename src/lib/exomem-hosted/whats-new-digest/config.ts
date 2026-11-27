/**
 * What the monthly What's new digest reads from configuration
 * (`send-monthly-whats-new-digest`). Read per call, so a test and a deploy
 * change a value without a reload.
 */

/** Evermatter's public repository: the one source of the digest's notes and of its closing link. */
export const EVERMATTER_REPOSITORY = "substrate-systems/evermatter";
export const EVERMATTER_RELEASES_URL = `https://github.com/${EVERMATTER_REPOSITORY}/releases`;

/** The asset every Evermatter release attaches: that release's own notes. */
export const NOTES_ASSET_NAME = "release-notes.json";

export const DEFAULT_MODEL_ID = "claude-haiku-5-5";

export type WhatsNewDigestConfig = {
  /** Base URL of the GitHub REST API. */
  githubApiUrl: string;
  /** A read-only token. Unset reads unauthenticated, which works on a public repository. */
  githubToken: string | null;
  anthropicBaseUrl: string;
  /** Unset leaves a month waiting in "model not configured"; no call is made. */
  anthropicApiKey: string | null;
  modelId: string;
  /**
   * The first month the daily route builds, `YYYY-MM` (D1): the month before
   * the one in which Evermatter's notes-file change ships, which attaches the
   * file to every release published since the start of the previous UTC month.
   * Unset, or not a month, builds nothing.
   */
  firstMonth: string | null;
  /** The signing secret of the unsubscribe token, as set; `unsubscribe.ts` reads it. */
  unsubscribeKey: string | null;
  /** The key being rotated out: links signed with it still verify, none is signed with it. */
  unsubscribeKeyPrevious: string | null;
};

/** A month's name as a request or a setting gives it: `YYYY-MM`, a format check. */
export function parseMonthName(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function whatsNewDigestConfig(
  env: Record<string, string | undefined> = process.env
): WhatsNewDigestConfig {
  return {
    githubApiUrl: present(env.EXOMEM_WHATS_NEW_GITHUB_API_URL) ?? "https://api.github.com",
    githubToken: present(env.EXOMEM_WHATS_NEW_GITHUB_TOKEN),
    anthropicBaseUrl: present(env.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
    anthropicApiKey: present(env.ANTHROPIC_API_KEY),
    modelId: present(env.EXOMEM_WHATS_NEW_MODEL) ?? DEFAULT_MODEL_ID,
    firstMonth: parseMonthName(present(env.EXOMEM_WHATS_NEW_FIRST_MONTH)),
    unsubscribeKey: present(env.EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY),
    unsubscribeKeyPrevious: present(env.EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS),
  };
}
