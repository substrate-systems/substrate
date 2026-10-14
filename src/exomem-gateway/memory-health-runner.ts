import { runMemoryHealthCheck } from "./memory-health";
import { closeHealthProofPool } from "../lib/exomem-hosted/functional-health-store";

async function main(): Promise<void> {
  try {
    const ok = await runMemoryHealthCheck();
    console.log(JSON.stringify({ component: "memory", ok }));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await closeHealthProofPool();
  }
}

void main();
