import { readFileSync } from "node:fs";

const bundle = readFileSync("dist/exomem-gateway/index.cjs", "utf8");
if (/require\(["']next(?:\/|["'])/.test(bundle)) {
  throw new Error("gateway bundle must not depend on Next.js");
}
