import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

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
      "src/components/Hook.tsx",
      "src/components/Philosophy.tsx",
      "src/components/Products.tsx",
    ],
    rules: {
      // These existing observer/hydration effects predate the flat-config
      // migration. Keep the exception local so new code gets the rule.
      "react-hooks/set-state-in-effect": "off",
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
