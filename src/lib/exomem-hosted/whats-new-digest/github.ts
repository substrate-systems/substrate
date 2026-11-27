/**
 * A month's Evermatter releases and their notes files, read from the GitHub
 * releases API (`send-monthly-whats-new-digest`, D1). Every call has a timeout.
 * Any failure throws `GitHubUnavailable`; the month then waits for the next
 * daily run, and nothing partial is reported as the whole.
 */

import { readBoundedBytes } from "../bounded-json";
import { EVERMATTER_REPOSITORY, NOTES_ASSET_NAME, type WhatsNewDigestConfig } from "./config";
import { versionTuple } from "./notes";
import { timeoutWithin } from "./time-budget";

export class GitHubUnavailable extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** Evermatter's about 100 releases a month make this about a year of releases: far past any month this reads. */
const MAX_PAGES = 15;
/** The list comes newest created first; a release is published within hours of its creation, so a week is a wide margin. */
const CREATED_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_FILE_BYTES = 256 * 1024;

export type ListedRelease = {
  /** The tag without its v: `X.Y.Z`. */
  version: string;
  publishedAt: Date;
  /** The release's notes asset on the API, or `null` when it lists none. */
  assetUrl: string | null;
};

type Fetch = typeof fetch;

/** `YYYY-MM` of a time in UTC. */
export function monthOf(time: Date): string {
  return time.toISOString().slice(0, 7);
}

export function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

function request(
  config: WhatsNewDigestConfig,
  url: URL,
  accept: string,
  fetchImpl: Fetch,
  deadlineAt: number | undefined
) {
  // Out of budget: the month waits for the next daily run.
  const timeout = timeoutWithin(deadlineAt, REQUEST_TIMEOUT_MS);
  if (timeout === null) throw new GitHubUnavailable("the run's time budget is spent");
  return fetchImpl(url, {
    headers: {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "substrate-whats-new-digest",
      ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}),
    },
    signal: AbortSignal.timeout(timeout),
    // The token stays with the API host: a redirect (an asset's download) drops it.
    redirect: "follow",
  });
}

type ApiRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  created_at?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

function asTime(value: unknown): Date | null {
  const time = typeof value === "string" ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? time : null;
}

/**
 * The month's published releases (UTC publish date; drafts and prereleases are
 * not releases), newest listed first. Reads pages until one is wholly older
 * than the month.
 */
export async function listMonthReleases(
  month: string,
  config: WhatsNewDigestConfig,
  fetchImpl: Fetch = fetch,
  deadlineAt?: number
): Promise<ListedRelease[]> {
  const start = monthStart(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1));
  const found: ListedRelease[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(
        `repos/${EVERMATTER_REPOSITORY}/releases`,
        `${config.githubApiUrl.replace(/\/+$/, "")}/`
      );
      url.searchParams.set("per_page", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const response = await request(
        config,
        url,
        "application/vnd.github+json",
        fetchImpl,
        deadlineAt
      );
      if (!response.ok) throw new GitHubUnavailable(`releases list answered ${response.status}`);
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBytes(response, MAX_PAGE_BYTES)
        )
      ) as unknown;
      if (!Array.isArray(body)) throw new GitHubUnavailable("releases list is not a list");
      let allOlder = body.length > 0;
      for (const item of body as ApiRelease[]) {
        const created = asTime(item.created_at);
        if (!created || created.getTime() >= start.getTime() - CREATED_MARGIN_MS) allOlder = false;
        const published = asTime(item.published_at);
        if (item.draft === true || item.prerelease === true || !published) continue;
        if (published < start || published >= end) continue;
        // The release workflow publishes only on tags vMAJOR.MINOR.PATCH (release-tag.ts); another tag is not one of its releases.
        const tag = typeof item.tag_name === "string" ? item.tag_name : "";
        const version = tag.startsWith("v") && versionTuple(tag.slice(1)) ? tag.slice(1) : null;
        if (!version) continue;
        const asset = Array.isArray(item.assets)
          ? (item.assets as Array<{ name?: unknown; url?: unknown }>).find(
              (entry) => entry.name === NOTES_ASSET_NAME
            )
          : undefined;
        found.push({ version, publishedAt: published, assetUrl: assetUrlOf(asset?.url, config) });
      }
      if (body.length < PAGE_SIZE || allOlder) return found;
    }
  } catch (error) {
    throw error instanceof GitHubUnavailable
      ? error
      : new GitHubUnavailable("releases list unreadable");
  }
  throw new GitHubUnavailable("releases list passed the page limit");
}

/** Only an asset on the API host is fetched, so the token never goes to another host. */
function assetUrlOf(value: unknown, config: WhatsNewDigestConfig): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin === new URL(config.githubApiUrl).origin ? value : null;
  } catch {
    return null;
  }
}

/** The text of one release's notes asset. */
export async function fetchNotesFileText(
  assetUrl: string,
  config: WhatsNewDigestConfig,
  fetchImpl: Fetch = fetch,
  deadlineAt?: number
): Promise<string> {
  try {
    const response = await request(
      config,
      new URL(assetUrl),
      "application/octet-stream",
      fetchImpl,
      deadlineAt
    );
    if (!response.ok) throw new GitHubUnavailable(`notes asset answered ${response.status}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedBytes(response, MAX_NOTES_FILE_BYTES)
    );
  } catch (error) {
    throw error instanceof GitHubUnavailable
      ? error
      : new GitHubUnavailable("notes asset unreadable");
  }
}
