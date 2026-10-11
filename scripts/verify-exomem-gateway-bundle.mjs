import { readFileSync } from "node:fs";

const bundle = readFileSync("dist/exomem-gateway/index.cjs", "utf8");
if (/require\(["']next(?:\/|["'])/.test(bundle)) {
  throw new Error("gateway bundle must not depend on Next.js");
}

// The retired Hosted contract fixtures ran to hundreds of thousands of lines.
// These are module file names, so the check reads the build's input list.
const { inputs } = JSON.parse(readFileSync("dist/exomem-gateway/meta.json", "utf8"));
const hostedContractModules = Object.keys(inputs).filter((path) =>
  /(?:^|\/)(?:agent-contract|gateway-contract)[^/]*$/.test(path)
);
if (hostedContractModules.length) {
  throw new Error(`gateway bundle must not include ${hostedContractModules.join(", ")}`);
}
