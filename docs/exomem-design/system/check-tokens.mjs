#!/usr/bin/env node
// Keeps the Exomem design system locked: fails if any Exomem source uses a raw colour instead of a token.
// Usage: node docs/exomem-design/system/check-tokens.mjs [paths…]   (default: src/app/exomem src/components/exomem)
// Allowed: var(--token), rgba(var(--*-rgb), a), transparent, currentColor, and anything inside tokens.css itself.
// Escape hatch for a deliberate exception: put  exo-allow-raw  in a comment on the same line, with the reason.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src/app/exomem', 'src/components/exomem'];
const exts = new Set(['.css', '.scss', '.ts', '.tsx', '.js', '.jsx', '.mdx']);
const RAW = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)|hsla?\([^)]*\)/g;
const problems = [];

function walk(p) {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) if (f !== 'node_modules' && !f.startsWith('.')) walk(join(p, f)); return; }
  if (!exts.has(extname(p)) || p.endsWith('tokens.css')) return;
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes('exo-allow-raw')) return;
    const hits = [...line.matchAll(RAW)].map((m) => m[0]);
    if (hits.length) problems.push(`${p}:${i + 1}: ${hits.join(', ')}  →  use a token from docs/exomem-design/system/tokens.css`);
  });
}
roots.forEach(walk);
if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} raw colour(s). The Exomem palette is locked.`); process.exit(1); }
console.log('Exomem tokens: no raw colours.');
