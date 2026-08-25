type EnvironmentSource = Record<string, string | undefined>;

export type VercelMigrationTarget =
  | { action: "skip"; reason: "non-deployment-target" }
  | { action: "migrate"; target: "production" | "staging" };

export class VercelMigrationTargetError extends Error {
  readonly code:
    | "EXOMEM_STAGING_FLAG_MISMATCH"
    | "EXOMEM_STAGING_BRANCH_MISMATCH"
    | "EXOMEM_STAGING_DATABASE_NAME_REQUIRED"
    | "EXOMEM_STAGING_DATABASE_MISMATCH"
    | "EXOMEM_STAGING_SCHEMA_NAME_REQUIRED"
    | "EXOMEM_STAGING_SCHEMA_MISMATCH";

  constructor(code: VercelMigrationTargetError["code"]) {
    super(code);
    this.name = "VercelMigrationTargetError";
    this.code = code;
  }
}

function databaseName(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    const parsed = new URL(databaseUrl);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

function searchPath(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    const options = new URL(databaseUrl).searchParams.get("options");
    const match = options?.match(/^-c\s+search_path=([a-z_][a-z0-9_]*),public$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function resolveVercelMigrationTarget(env: EnvironmentSource): VercelMigrationTarget {
  if (env.VERCEL_ENV === "production") {
    return { action: "migrate", target: "production" };
  }

  const branchIsStaging = env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === "staging";
  const stagingEnabled = env.EXOMEM_HOSTED_STAGING === "true";
  if (!branchIsStaging && !stagingEnabled) {
    return { action: "skip", reason: "non-deployment-target" };
  }
  if (!branchIsStaging) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_BRANCH_MISMATCH");
  }
  if (!stagingEnabled) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_FLAG_MISMATCH");
  }

  const expectedDatabase = env.EXOMEM_HOSTED_STAGING_DATABASE_NAME?.trim();
  if (!expectedDatabase) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_DATABASE_NAME_REQUIRED");
  }
  if (databaseName(env.DATABASE_URL) !== expectedDatabase) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_DATABASE_MISMATCH");
  }
  const expectedSchema = env.EXOMEM_HOSTED_STAGING_SCHEMA_NAME?.trim();
  if (!expectedSchema) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_SCHEMA_NAME_REQUIRED");
  }
  if (
    !/^[a-z_][a-z0-9_]*$/.test(expectedSchema) ||
    searchPath(env.DATABASE_URL) !== expectedSchema
  ) {
    throw new VercelMigrationTargetError("EXOMEM_STAGING_SCHEMA_MISMATCH");
  }
  return { action: "migrate", target: "staging" };
}
