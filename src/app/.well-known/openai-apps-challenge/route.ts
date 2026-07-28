const MAX_CHALLENGE_LENGTH = 512;

export const dynamic = "force-dynamic";

function configuredChallenge(): string | null {
  const value = process.env.OPENAI_APPS_CHALLENGE;
  if (
    !value ||
    value.trim() !== value ||
    value.length > MAX_CHALLENGE_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    return null;
  }
  return value;
}

export function GET(_request: Request): Response {
  void _request;
  const challenge = configuredChallenge();
  if (!challenge) return new Response(null, { status: 404 });

  return new Response(challenge, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}
