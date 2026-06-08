import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const REPO = 'Artexis10/endstate-gui';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const LIST_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

const ALLOWED_FORMATS = new Set(['exe', 'msi']);

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'substratesystems.io-download-redirect',
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Release = {
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
};

function fail(reason: string, ctx: Record<string, unknown>): NextResponse {
  console.error('[api/download] download_unavailable', { reason, ...ctx });
  return NextResponse.json({ error: 'download_unavailable' }, { status: 503 });
}

/** The installer asset for a format, skipping detached signatures (.sig). */
function pickAsset(release: Release | null, suffix: string): ReleaseAsset | undefined {
  return release?.assets?.find(
    (a) => a.name.endsWith(suffix) && !a.name.endsWith('.sig'),
  );
}

async function fetchGitHubJson<T>(url: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: GH_HEADERS, next: { revalidate: 300 } });
  } catch (err) {
    console.error('[api/download] upstream_fetch_threw', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!res.ok) {
    console.error('[api/download] upstream_non_2xx', { url, status: res.status });
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    console.error('[api/download] upstream_invalid_json', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const formatParam = searchParams.get('format')?.toLowerCase() ?? 'exe';
  const format = ALLOWED_FORMATS.has(formatParam) ? formatParam : 'exe';
  const suffix = `.${format}`;

  // Primary path: honor GitHub's "Latest" release. The endstate-gui release
  // pipeline only promotes a release to Latest after its installers are verified
  // (release-please.yml), so this is normally the correct artifact.
  const latest = await fetchGitHubJson<Release>(LATEST_URL);
  let asset = pickAsset(latest, suffix);

  // Resilience: if Latest somehow has no matching installer, redirect to the
  // newest published (non-draft, non-prerelease) release that does, instead of
  // 503-ing the user. The pipeline guards against an empty Latest, so this is a
  // deliberate last line of defense rather than the expected path.
  if (!asset) {
    const releases = await fetchGitHubJson<Release[]>(LIST_URL);
    for (const release of releases ?? []) {
      if (release.draft || release.prerelease) continue;
      asset = pickAsset(release, suffix);
      if (asset) break;
    }
  }

  if (!asset) {
    return fail('no_matching_asset', { repo: REPO, format });
  }

  return NextResponse.redirect(asset.browser_download_url, 302);
}
