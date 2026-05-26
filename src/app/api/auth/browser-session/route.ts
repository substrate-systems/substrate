import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/hosted-backup/auth-middleware';
import { mintBrowserSession } from '@/lib/hosted-backup/browser-session';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';
import type { BrowserSessionResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mints the 60s GUI→web handoff token. Engine-initiated, bearer-authenticated;
// `endstate backup browser-session` is the canonical caller. Returns
// `{ sessionToken, accountUrl }`; the GUI opens `${accountUrl}?session=${sessionToken}`
// in the system browser. See hosted-backup-contract.md §5.
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireAuth(req);
    const { sessionToken, accountUrl } = await mintBrowserSession(userId);
    const body: BrowserSessionResponse = { sessionToken, accountUrl };
    return jsonWithApiVersion(body, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup browser-session] unhandled:', err);
    }
    return errorResponse(err);
  }
}
