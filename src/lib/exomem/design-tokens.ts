// Literal Exomem token values for renderers that cannot read CSS variables: the OG
// image (Satori) and the emails. They come from the one tokens stylesheet, parsed
// with postcss, so no second palette exists. Server only: it reads the file from disk.

import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule } from "postcss";
import valueParser from "postcss-value-parser";

// Traced into the serverless bundle by `outputFileTracingIncludes` in next.config.ts.
const TOKENS_FILE = path.join(process.cwd(), "src/app/exomem/exomem-tokens.css");

// The two rules that declare the tokens: dark is the default; light overrides part of it.
const DARK_RULE = ".brand-exomem";
const LIGHT_RULE = '.brand-exomem[data-theme="light"]';

export type ExomemTokenMap = Readonly<Record<string, string>>;

function tokensOf(rules: Rule[], selector: string): Map<string, string> {
  const rule = rules.find((r) => r.selectors.includes(selector));
  if (!rule) throw new Error(`exomem-tokens.css: no rule for ${selector}`);
  const tokens = new Map<string, string>();
  rule.each((node) => {
    if (node.type === "decl" && node.prop.startsWith("--")) tokens.set(node.prop, node.value);
  });
  return tokens;
}

/**
 * Replaces each var(--token) with that token's own value, so
 * rgba(var(--ink-rgb), 0.07) becomes rgba(236, 233, 226, 0.07). A variable that is
 * not an Exomem token (the font variables from next/font) stays as written.
 */
function resolve(tokens: Map<string, string>): ExomemTokenMap {
  const resolved: Record<string, string> = {};
  const valueOf = (name: string, seen: Set<string>): string => {
    if (resolved[name] !== undefined) return resolved[name];
    const raw = tokens.get(name);
    if (raw === undefined) throw new Error(`exomem-tokens.css: unknown token ${name}`);
    if (seen.has(name)) throw new Error(`exomem-tokens.css: ${name} refers to itself`);
    const parsed = valueParser(raw);
    parsed.walk((node) => {
      if (node.type !== "function" || node.value !== "var") return;
      const ref = node.nodes[0]?.value;
      if (!ref || !tokens.has(ref)) return;
      Object.assign(node, { type: "word", value: valueOf(ref, new Set(seen).add(name)) });
    });
    return (resolved[name] = parsed.toString());
  };
  for (const name of tokens.keys()) valueOf(name, new Set());
  return resolved;
}

let cached: { dark: ExomemTokenMap; light: ExomemTokenMap } | undefined;

/** Every Exomem token with its literal value, for the dark and the light theme. */
export function exomemTokens(): { dark: ExomemTokenMap; light: ExomemTokenMap } {
  if (cached) return cached;
  const root = postcss.parse(readFileSync(TOKENS_FILE, "utf8"));
  const rules: Rule[] = [];
  root.each((node) => {
    if (node.type === "rule") rules.push(node);
  });
  const dark = tokensOf(rules, DARK_RULE);
  const light = new Map([...dark, ...tokensOf(rules, LIGHT_RULE)]);
  cached = { dark: resolve(dark), light: resolve(light) };
  return cached;
}
