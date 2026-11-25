/** Splits a URL at its host: "https://", "substratesystems.io/" and the rest; null when it is not one. */
export function splitAtHost(
  address: string
): { scheme: string; host: string; path: string } | null {
  try {
    const url = new URL(address);
    const head = `${url.origin}/`;
    const scheme = `${url.protocol}//`;
    if (!address.startsWith(head) || !head.startsWith(scheme)) return null;
    return { scheme, host: head.slice(scheme.length), path: address.slice(head.length) };
  } catch {
    return null;
  }
}

/** The address as inline code in prose: it may wrap after "//" or after its host, never inside the host. */
export function McpAddressCode({ address }: { address: string }) {
  const parts = splitAtHost(address);
  if (!parts) return <code>{address}</code>;
  return (
    <code>
      {parts.scheme}
      <wbr />
      {parts.host}
      <wbr />
      {parts.path}
    </code>
  );
}
