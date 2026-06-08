/**
 * Tests for GET /api/download — the Endstate installer redirect.
 *
 * The handler reads GitHub's Releases API at call time, so we stub
 * `globalThis.fetch` per case (restored in afterEach) and assert the 302
 * Location. The key behavior under test is the resilience fallback: if the
 * "Latest" release has no matching installer, the handler must redirect to the
 * newest published (non-draft, non-prerelease) release that does, rather than
 * 503-ing the user.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const LATEST =
  'https://api.github.com/repos/Artexis10/endstate-gui/releases/latest';
const LIST =
  'https://api.github.com/repos/Artexis10/endstate-gui/releases?per_page=20';

const originalFetch = globalThis.fetch;

function stubFetch(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (!(url in routes)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(routes[url]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeReq(url: string): import('next/server').NextRequest {
  return new Request(url) as unknown as import('next/server').NextRequest;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GET /api/download', () => {
  it('redirects to the .exe on the Latest release (skips .sig)', async () => {
    stubFetch({
      [LATEST]: {
        assets: [
          {
            name: 'Endstate_2.17.2_x64-setup.exe.sig',
            browser_download_url: 'https://gh/2.17.2.exe.sig',
          },
          {
            name: 'Endstate_2.17.2_x64-setup.exe',
            browser_download_url: 'https://gh/2.17.2.exe',
          },
          {
            name: 'Endstate_2.17.2_x64_en-US.msi',
            browser_download_url: 'https://gh/2.17.2.msi',
          },
        ],
      },
    });
    const { GET } = await import('../route');
    const res = await GET(makeReq('https://substratesystems.io/api/download'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://gh/2.17.2.exe');
  });

  it('honors ?format=msi', async () => {
    stubFetch({
      [LATEST]: {
        assets: [
          {
            name: 'Endstate_2.17.2_x64-setup.exe',
            browser_download_url: 'https://gh/2.17.2.exe',
          },
          {
            name: 'Endstate_2.17.2_x64_en-US.msi',
            browser_download_url: 'https://gh/2.17.2.msi',
          },
        ],
      },
    });
    const { GET } = await import('../route');
    const res = await GET(
      makeReq('https://substratesystems.io/api/download?format=msi'),
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://gh/2.17.2.msi');
  });

  it('falls back to the newest published release when Latest has no installer', async () => {
    stubFetch({
      [LATEST]: { assets: [] }, // the exact failure this guards against
      [LIST]: [
        { prerelease: true, draft: false, assets: [] }, // held/empty prerelease — skipped
        {
          draft: true,
          assets: [{ name: 'x.exe', browser_download_url: 'https://gh/draft.exe' }],
        }, // draft — skipped
        {
          prerelease: false,
          draft: false,
          assets: [
            {
              name: 'Endstate_2.13.0_x64-setup.exe',
              browser_download_url: 'https://gh/2.13.0.exe',
            },
          ],
        },
      ],
    });
    const { GET } = await import('../route');
    const res = await GET(makeReq('https://substratesystems.io/api/download'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://gh/2.13.0.exe');
  });

  it('returns 503 when no release has a matching installer', async () => {
    stubFetch({
      [LATEST]: { assets: [] },
      [LIST]: [{ prerelease: true, assets: [] }],
    });
    const { GET } = await import('../route');
    const res = await GET(makeReq('https://substratesystems.io/api/download'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'download_unavailable');
  });
});
