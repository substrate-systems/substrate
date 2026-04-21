import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 300;

const UPSTREAM_URL =
  'https://github.com/Artexis10/endstate-gui/releases/latest/download/latest.json';

const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';

export async function GET(): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      next: { revalidate: 300 },
      redirect: 'follow',
    });
  } catch (err) {
    console.error('[updates/latest.json] upstream fetch threw', {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'manifest_unavailable' }, { status: 503 });
  }

  if (!upstream.ok) {
    console.error('[updates/latest.json] upstream returned non-2xx', {
      url: UPSTREAM_URL,
      status: upstream.status,
    });
    return NextResponse.json({ error: 'manifest_unavailable' }, { status: 503 });
  }

  let manifest: unknown;
  try {
    manifest = await upstream.json();
  } catch (err) {
    console.error('[updates/latest.json] upstream returned invalid JSON', {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'manifest_unavailable' }, { status: 503 });
  }

  return NextResponse.json(manifest, {
    status: 200,
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
