import { spawnSync } from "node:child_process";

if (!process.env.EXOMEM_TEST_DATABASE_URL) {
  throw new Error("EXOMEM_TEST_DATABASE_URL is required for hosted admission acceptance");
}
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--experimental-test-module-mocks",
    "--test",
    "src/lib/exomem-hosted/__tests__/runtime-target-admission.integration.test.ts",
  ],
  { stdio: "inherit", env: process.env }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
