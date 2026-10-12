/**
 * Where Exomem's status page lives, for "Status page ↗" when connecting fails on our
 * side: `EXOMEM_STATUS_PAGE_URL`, an https address. Configuration, because the page
 * is a third party's and its address can change. Unset or invalid: no link, and the
 * page does not mention one.
 */
export function statusPageUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const value = env.EXOMEM_STATUS_PAGE_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
