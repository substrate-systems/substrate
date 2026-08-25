import { paddleFetch } from "../src/lib/hosted-backup/paddle-client";
import { verifyExomemPaddleCatalog } from "../src/lib/exomem-hosted/paddle-catalog-gate";
import { loadExomemPaddleConfig } from "../src/lib/exomem-hosted/paddle-config";

async function main(): Promise<void> {
  if (!process.env.EXOMEM_PADDLE_PRICE_ID?.trim()) {
    console.log("[exomem-paddle-catalog] checkout disabled");
    return;
  }

  const result = await verifyExomemPaddleCatalog(loadExomemPaddleConfig(), paddleFetch);
  console.log(`[exomem-paddle-catalog] ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "EXOMEM_PADDLE_CATALOG_CHECK_FAILED";
  console.error(`[exomem-paddle-catalog] ${code}`);
  process.exitCode = 1;
});
