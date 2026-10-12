import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import colorNames from "color-name";

// The Exomem palette is locked: Exomem source takes its colours from the tokens in
// src/app/exomem/exomem-tokens.css. Each pattern below checks the shape of a value, so tokens
// pass: var(--fg-primary), rgba(var(--ink-rgb), 0.1).
//
// Hex or a colour function with numeric channels, in any string: a module constant, a
// CSSProperties object, an el.style assignment or a canvas fillStyle can each carry one.
// url(#id) is a fragment reference, and href, id and htmlFor values are names, not colours.
const RAW_COLOUR = String.raw`/(?<!url\(['"]?)#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[-+.\d]/i`;
const NOT_A_COLOUR = "JSXAttribute[name.name=/^(?:href|id|htmlFor)$/]";
// CSS named colours (the closed set from the CSS Color spec, via color-name), only where a
// value is certainly a colour: copy uses words such as "red" too.
const NAMED_COLOUR = `/(?<![-\\w])(?:${Object.keys(colorNames).join("|")})(?![-\\w])/i`;
const COLOUR_POSITIONS = [
  "JSXAttribute[name.name='style']",
  "JSXAttribute[name.name=/^(?:fill|stroke|stopColor|floodColor|lightingColor|color)$/]",
];
// Tailwind palette utilities in className: the closed set of Tailwind's default palette
// (the colour names in tailwindcss/theme.css, plus black and white), after any colour
// utility and variant: text-red-500, hover:bg-black/50, border-x-neutral-700.
const TAILWIND_PALETTE = `/(?<![\\w-])(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow|inset-shadow|inset-ring|drop-shadow)-(?:black|white|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3})(?![\\w-])/`;
const RAW_COLOUR_MESSAGE =
  "Exomem colours come from the tokens in src/app/exomem/exomem-tokens.css: use var(--token) or rgba(var(--*-rgb), alpha).";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  prettier,
  {
    files: [
      "src/app/endstate/page.tsx",
      "src/app/exomem/invite/invite-client.tsx",
      "src/app/exomem/sign-in/sign-in-client.tsx",
      "src/components/Hero.tsx",
    ],
    rules: {
      // These existing observer/hydration effects predate the flat-config
      // migration. Keep the exception local so new code gets the rule.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // The Exomem palette is locked: a raw colour in Exomem source fails lint.
    files: [
      "src/app/exomem/**/*.{ts,tsx}",
      "src/components/exomem/**/*.{ts,tsx}",
      "src/lib/email-templates/exomem-*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["Literal[value", "TemplateElement[value.raw"].flatMap((node) => [
          {
            selector: `${node}=${RAW_COLOUR}]:not(${NOT_A_COLOUR} *)`,
            message: RAW_COLOUR_MESSAGE,
          },
          ...COLOUR_POSITIONS.map((position) => ({
            selector: `${position} ${node}=${NAMED_COLOUR}]`,
            message: RAW_COLOUR_MESSAGE,
          })),
          {
            selector: `JSXAttribute[name.name='className'] ${node}=${TAILWIND_PALETTE}]`,
            message: "Tailwind palette colours are not Exomem tokens: use var(--token) instead.",
          },
        ]),
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "coverage/**",
    "dist/**",
    "node_modules/**",
    "next-env.d.ts",
    // Playwright's HTML report and run output: generated files, written by CI-mode runs.
    "playwright-report/**",
    "test-results/**",
    "public/sw.js",
    "tsconfig.tsbuildinfo",
  ]),
]);
