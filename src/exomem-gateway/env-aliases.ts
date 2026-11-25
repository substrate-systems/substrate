/**
 * Settings named with the product prefix, `EVERMATTER_X`, are aliases of the
 * internal name `EXOMEM_X` that the gateway reads. The Helm chart switches to
 * the product prefix only after this reader runs in production.
 *
 * The alias fills the internal name only when that is unset, and stays in the
 * environment: the gateway starts no child process and writes no setting after
 * start, and other code reads some `EVERMATTER_*` names natively.
 */
const ALIAS_PREFIX = "EVERMATTER_";
const INTERNAL_PREFIX = "EXOMEM_";

export function adoptSettingAliases(
  environment: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn
): void {
  for (const alias of Object.keys(environment)) {
    if (!alias.startsWith(ALIAS_PREFIX)) continue;
    const value = environment[alias];
    if (value === undefined) continue;
    const internal = INTERNAL_PREFIX + alias.slice(ALIAS_PREFIX.length);
    const current = environment[internal];
    if (current === undefined) environment[internal] = value;
    // Names only: the values may be secrets.
    else if (current !== value)
      warn(`${alias} and ${internal} are both set to different values; using ${internal}`);
  }
}
