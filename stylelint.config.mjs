// The Exomem palette is locked: Exomem CSS takes its colours from the tokens in
// src/app/exomem/exomem-tokens.css, the one file allowed to hold raw values.
// `npm run lint:css` runs this over the Exomem CSS only.
const config = {
  ignoreFiles: ["src/app/exomem/exomem-tokens.css"],
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": ["hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"],
    // rgb()/rgba() only over a token channel, as in rgba(var(--ink-rgb), 0.1): the pattern
    // checks the shape of the first argument (a number means a raw colour), not its meaning.
    "declaration-property-value-disallowed-list": { "/.*/": ["/\\brgba?\\(\\s*[-+.\\d]/i"] },
  },
};

export default config;
