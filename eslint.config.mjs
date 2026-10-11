import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import colorNames from "color-name";

// A colour written as a value: hex, a functional notation with numeric channels, or a
// CSS named colour (the closed set from the CSS Color spec, via color-name). It checks
// the shape of a value, so tokens pass: var(--fg-primary), rgba(var(--ink-rgb), 0.1).
const RAW_COLOUR = `/#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(\\s*[-+.\\d]|(?<![-\\w])(?:${Object.keys(colorNames).join("|")})(?![-\\w])/i`;
const RAW_COLOUR_MESSAGE =
  "Exomem colours come from the tokens in src/app/exomem/exomem-tokens.css: use var(--token) or rgba(var(--*-rgb), alpha).";
// Only the places a colour can be written in markup: a style object and the SVG colour
// attributes. Other strings (hrefs such as "#add", copy) are not colours.
const COLOUR_POSITIONS = [
  "JSXAttribute[name.name='style']",
  "JSXAttribute[name.name=/^(?:fill|stroke|stopColor|floodColor|lightingColor|color)$/]",
];

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  prettier,
  {
    files: [
      "src/app/endstate/page.tsx",
      "src/app/exomem/invite/invite-client.tsx",
      "src/app/exomem/memory-graph.tsx",
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
    // The Exomem palette is locked: a raw colour in Exomem markup fails lint.
    files: ["src/app/exomem/**/*.{ts,tsx}", "src/components/exomem/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...COLOUR_POSITIONS.flatMap((position) => [
          { selector: `${position} Literal[value=${RAW_COLOUR}]`, message: RAW_COLOUR_MESSAGE },
          {
            selector: `${position} TemplateElement[value.raw=${RAW_COLOUR}]`,
            message: RAW_COLOUR_MESSAGE,
          },
        ]),
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "coverage/**",
    "node_modules/**",
    "next-env.d.ts",
    "public/sw.js",
    "tsconfig.tsbuildinfo",
  ]),
]);
