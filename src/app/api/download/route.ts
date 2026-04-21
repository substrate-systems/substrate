import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const UPSTREAM_URL =
  'https://api.github.com/repos/Artexis10/endstate-gui/releases/latest';

const ALLOWED_FORMATS = new Set(['exe', 'msi']);

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Release = {
  assets?: ReleaseAsset[];
};

function fail(reason: string, ctx: Record<string, unknown>): NextResponse {
  console.error('[api/download] download_unavailable', { reason, ...ctx });
  return NextResponse.json({ error: 'download_unavailable' }, { status: 503 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const formatParam = searchParams.get('format')?.toLowerCase() ?? 'exe';
  const format = ALLOWED_FORMATS.has(formatParam) ? formatParam : 'exe';

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'substratesystems.io-download-redirect',
      },
      next: { revalidate: 300 },
    });
  } catch (err) {
    return fail('upstream_fetch_threw', {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!upstream.ok) {
    return fail('upstream_non_2xx', { url: UPSTREAM_URL, status: upstream.status });
  }

  let release: Release;
  try {
    release = (await upstream.json()) as Release;
  } catch (err) {
    return fail('upstream_invalid_json', {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const suffix = `.${format}`;
  const asset = release.assets?.find(
    (a) => a.name.endsWith(suffix) && !a.name.endsWith('.sig'),
  );

  if (!asset) {
    return fail('no_matching_asset', { url: UPSTREAM_URL, format });
  }

  return NextResponse.redirect(asset.browser_download_url, 302);
}
