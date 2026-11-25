/**
 * Settings named with the product prefix, `EVERMATTER_X`, are aliases of the
 * internal name `EXOMEM_X` that the gateway image reads. Both entry points
 * call this first. The Helm chart switches to the product prefix only after
 * this reader runs in production.
 *
 * The alias fills the internal name only when that is unset, and is then
 * removed, so the process holds one name per setting.
 */
const ALIAS_PREFIX = "EVERMATTER_";
const INTERNAL_PREFIX = "EXOMEM_";

export function adoptSettingAliases(
  environment: Record<string, string | undefined> = process.env,
  warn: (event: Record<string, string>) => void = console.warn
): void {
  for (const alias of Object.keys(environment)) {
    if (!alias.startsWith(ALIAS_PREFIX)) continue;
    const value = environment[alias];
    const internal = INTERNAL_PREFIX + alias.slice(ALIAS_PREFIX.length);
    const current = environment[internal];
    if (current === undefined) environment[internal] = value;
    // Names only: the values may be secrets.
    else if (current !== value) warn({ event: "exomem_setting_alias_conflict", alias, internal });
    delete environment[alias];
  }
}
