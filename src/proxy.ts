import { NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith('/tidewave')) {
    return NextResponse.rewrite(new URL('/api/tidewave', req.url));
  }
  return NextResponse.next();
}
