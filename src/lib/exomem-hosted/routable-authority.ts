import { createHash } from "node:crypto";

export type RoutableCellIdentity = {
  cell_id: unknown;
  source_release: unknown;
  protocol_version: unknown;
  command_fingerprint: unknown;
  contract_digest: unknown;
  compatibility_digest: unknown;
};

export function routableSetDigest(profile: string, identities: RoutableCellIdentity[]): string {
  const entries = identities.map((row) =>
    JSON.stringify([
      profile,
      String(row.cell_id),
      String(row.source_release),
      String(row.protocol_version),
      String(row.command_fingerprint),
      String(row.contract_digest),
      String(row.compatibility_digest),
    ])
  );
  return entries.length
    ? createHash("sha256").update(entries.join(",")).digest("hex")
    : "0".repeat(64);
}
