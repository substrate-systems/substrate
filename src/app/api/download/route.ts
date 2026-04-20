import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_FORMATS = new Set(['exe', 'msi']);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);

  const formatParam = searchParams.get('format')?.toLowerCase() ?? 'exe';
  const format = ALLOWED_FORMATS.has(formatParam) ? formatParam : 'exe';

  // `version` is accepted for forward compatibility. For launch we always
  // redirect to the "latest" artifact hosted in /public/downloads.
  const target = `${origin}/downloads/endstate-latest.${format}`;

  return NextResponse.redirect(target, 302);
}
