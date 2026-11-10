import { loadCloudUpstream, type CloudUpstream } from "../cloud-upstream";

/** D5 settings with the hold off and every timeout far beyond a test's run. */
export const HOLD_OFF_ENV = {
  EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "0",
  EXOMEM_CLOUD_HOLD_INTERVAL_MS: "100",
  EXOMEM_CLOUD_HOLD_JITTER_MS: "0",
  EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS: "5",
  EXOMEM_CLOUD_HOLD_MAX: "32",
  EXOMEM_CLOUD_HOLD_MAX_PER_TENANT: "8",
  EXOMEM_CLOUD_CONNECT_TIMEOUT_MS: "2000",
  EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS: "60",
  EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS: "60",
};

export function testUpstream(overrides: Partial<typeof HOLD_OFF_ENV> = {}): CloudUpstream {
  return loadCloudUpstream({ ...HOLD_OFF_ENV, ...overrides });
}
