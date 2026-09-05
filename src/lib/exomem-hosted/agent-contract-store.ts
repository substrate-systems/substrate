import { createHmac, timingSafeEqual } from "node:crypto";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemHostedContractFixture } from "./agent-contract-fixture";
import { exomemHostedContractFixture as exomemHostedContractFixture0340 } from "./agent-contract-fixture-0-34-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0350 } from "./agent-contract-fixture-0-35-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0392 } from "./agent-contract-fixture-0-39-2";
import { exomemHostedContractFixture as exomemHostedContractFixture0490 } from "./agent-contract-fixture-0-49-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0500 } from "./agent-contract-fixture-0-50-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0541 } from "./agent-contract-fixture-0-54-1";
import { exomemHostedContractFixture as exomemHostedContractFixture0572 } from "./agent-contract-fixture-0-57-2";
import { exomemHostedContractFixture as exomemHostedContractFixture0631 } from "./agent-contract-fixture-0-63-1";
import { exomemHostedContractFixture as exomemHostedContractFixture0660 } from "./agent-contract-fixture-0-66-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0680 } from "./agent-contract-fixture-0-68-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0681 } from "./agent-contract-fixture-0-68-1";
import { exomemHostedContractFixture as exomemHostedContractFixture0683 } from "./agent-contract-fixture-0-68-3";
import {
  loadClientArtifactLocks,
  promotionEvidenceDigest,
  validatePromotionEvidence,
} from "./client-artifacts";
import { revokeConflictingCandidateOAuthLineageInTransaction } from "./agent-contract-canaries";
import { routableSetDigest, type RoutableCellIdentity } from "./routable-authority";
import { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";
import {
  PromotionRuntimePreconditionError,
  preparePromotionRuntimeHealth,
  recordPromotionRuntimeAuthorityInTransaction,
} from "./promotion-runtime";

export { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";
export const EXOMEM_HOSTED_RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";
type ExomemHostedProfile = "hosted-alpha-agent-v1" | typeof EXOMEM_HOSTED_PROFILE;
/** Releases whose fixtures are pinned here; the bare fixture is the live one. */
export type TrustedRelease =
  | "0.34.0"
  | "0.35.0"
  | "0.39.2"
  | "0.49.0"
  | "0.50.0"
  | "0.54.1"
  | "0.57.2"
  | "0.63.1"
  | "0.66.0"
  | "0.68.0"
  | "0.68.1"
  | "0.68.3"
  | "0.72.1";
const TRUSTED_RELEASES = new Map([
  [
    "0.72.1",
    {
      sourceCommit: "9720ccdfcc3e5e77ea47c56ddbddc53d75de40aa",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "60b5aec6f872874234a214e778e26ce57fa5805af8ce744bdd68efe8ca0fcb26",
      compatibility_sha256: "636d271faaa57d38730a5638abb9f12797cb49189e99be9762632f03ae49117c",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.68.3",
    {
      sourceCommit: "a35cd9e2f494a901b823c5037733bb758f48038a",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "124fb718c6d2b6caee93edd7281fbc6cd7ca991e4a39bcc90df00bf0811208fd",
      compatibility_sha256: "62356a1220b823e9ae91e1fab18a8da5711481b6cc907dbcae033e254a3585dc",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.68.1",
    {
      sourceCommit: "e487efa2fdfd8c7653b6e99605163a0200c6ce58",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "124fb718c6d2b6caee93edd7281fbc6cd7ca991e4a39bcc90df00bf0811208fd",
      compatibility_sha256: "62356a1220b823e9ae91e1fab18a8da5711481b6cc907dbcae033e254a3585dc",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.68.0",
    {
      sourceCommit: "76571f2c9f600395344a2a62efe6aca36d32b42d",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "124fb718c6d2b6caee93edd7281fbc6cd7ca991e4a39bcc90df00bf0811208fd",
      compatibility_sha256: "62356a1220b823e9ae91e1fab18a8da5711481b6cc907dbcae033e254a3585dc",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.66.0",
    {
      sourceCommit: "efd6e15f40221bb3821f979d6fcbda45e7c6a649",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "55f704688e015a4497f9ca8da49169a717c282aacec838bfde52c08c12cdf95c",
      compatibility_sha256: "4a12a115086166c5b37cde02e6bfcc6aa2c095b6d073dc23f5634803b13c0ce9",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.63.1",
    {
      sourceCommit: "35f6d7bb92a79f9d59f82e8e87557fd0e68fb3e5",
      command_surface_sha256: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
      schema_contract_sha256: "553b077a18808c77f928141068b4e22e65f845c383641d66ccf6d524a451d9ca",
      compatibility_sha256: "602bb4f9670f7436c8e530a4ffa6be6c9fa7913b6f156e1aa2c8923451a6b29f",
      artifact_sha256: "be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241",
      archive_sha256: "00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4",
    },
  ],
  [
    "0.57.2",
    {
      sourceCommit: "d4bbef7725d55f3bb6e8c288deadddb15ef7855f",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "30c65de187984940a57a122638d42a85989b7409e1eccb026a828fd1d785d788",
      compatibility_sha256: "9e028c9e2001378a4ab5fc6f2c3a421e5502cf9e59fb043d6066055f115c08ea",
      artifact_sha256: "9d2bba6d14038139bb4120b91c35c17364e88db4f077e69cfb0e5875d14c44ee",
      archive_sha256: "0da1055f4bb34d383101011f568b171f73ad4e033c3f3dd575136e1da54a1442",
    },
  ],
  [
    "0.54.1",
    {
      sourceCommit: "b41906384ac187cc4877abfc204639fb3b6f8d48",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "471cd6bf03cacfe0c5cd6f463d2141aacb61b3fabe8e3573158c830be9df2a33",
      compatibility_sha256: "54c7a376d5bca6ec8f6606613d340b58b1ab8ac274dbb0cccce30a38cba0c0fb",
      artifact_sha256: "9d2bba6d14038139bb4120b91c35c17364e88db4f077e69cfb0e5875d14c44ee",
      archive_sha256: "0da1055f4bb34d383101011f568b171f73ad4e033c3f3dd575136e1da54a1442",
    },
  ],
  [
    "0.50.0",
    {
      sourceCommit: "9c862c2bd851cf72921a545239ae5c8b45594c31",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "b974fb04b9dca69580dd0b386d0de94b27c6a84543f24faeab684da3cbbbb57e",
      compatibility_sha256: "f3cee4e10a9b3b0e87e469710504a0f850982e1e4b4bff5e4bad7eae4d2dec19",
      artifact_sha256: "9d2bba6d14038139bb4120b91c35c17364e88db4f077e69cfb0e5875d14c44ee",
      archive_sha256: "0da1055f4bb34d383101011f568b171f73ad4e033c3f3dd575136e1da54a1442",
    },
  ],
  [
    "0.49.0",
    {
      sourceCommit: "d6ea0c11224331fb27a45b485091399679e59bbf",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "b974fb04b9dca69580dd0b386d0de94b27c6a84543f24faeab684da3cbbbb57e",
      compatibility_sha256: "f3cee4e10a9b3b0e87e469710504a0f850982e1e4b4bff5e4bad7eae4d2dec19",
      artifact_sha256: "9d2bba6d14038139bb4120b91c35c17364e88db4f077e69cfb0e5875d14c44ee",
      archive_sha256: "0da1055f4bb34d383101011f568b171f73ad4e033c3f3dd575136e1da54a1442",
    },
  ],
  [
    "0.39.2",
    {
      sourceCommit: "4e9ba9caabcee985e3371320803c11946cd40cc6",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "8abece817b0b2a6a9f9dfc01e92bfb93b954725d7ead2c399f210eb2f83d745c",
      compatibility_sha256: "fed9898424ac4b3349af36353a9119b576adb6aa91b4a81cd0abbaaf95c9874c",
      artifact_sha256: "20adc7f85bc66c3566431de15f7d42d9d24693a32945151a7a3db53b3d2a2469",
      archive_sha256: "c4ef2e565fbe30cff342c934d6bbe4f56937907b4ce9f348e6bc748e38285f91",
    },
  ],
  [
    "0.34.0",
    {
      sourceCommit: "253c9aa365d7afd8829dc7843f1cac53353ac825",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "c18580d9dfa8fe549df17984487668f1ead73ba5b37fb6a07b82c68a76e30853",
      compatibility_sha256: "6da6c697c7720b2178d753299ced98f93f440134c2cbcc0fa7d741f3680d5d9c",
      artifact_sha256: "b99ac90d97c7ae25463f434fb02fe87a36842aa82373cd5c4c449b17f512b95a",
      archive_sha256: "dc55e52e36c4b533a0179f19e8856a3414016ad536d0f85370fe5a765661858b",
    },
  ],
  [
    "0.35.0",
    {
      sourceCommit: "d4c5614e5f65d8bcbddee90e9e374846c5a2c22f",
      command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
      schema_contract_sha256: "22fac274c147a5e0ff4096e70a500d9fbb5489a6a8731687fa162dd5e224a7b1",
      compatibility_sha256: "bacca49e553f6d50fabb735164ae613238177bd9f0d9cffeafdae9fa4fc91840",
      artifact_sha256: "b99ac90d97c7ae25463f434fb02fe87a36842aa82373cd5c4c449b17f512b95a",
      archive_sha256: "dc55e52e36c4b533a0179f19e8856a3414016ad536d0f85370fe5a765661858b",
    },
  ],
] as const);
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;
type ContractState = "pending" | "live" | "failed" | "retired";

type ExomemAgentContractCandidate = {
  state: ContractState;
  profile: ExomemHostedProfile;
  endpoint: typeof EXOMEM_HOSTED_RESOURCE;
  sourceRelease: string;
  commandSurfaceSha256: string;
  schemaDigest: string;
  compatibilitySha256: string;
  protocolVersion: string;
  mcpProtocolVersions: string[];
  tools: unknown[];
  compatibility: JsonRecord;
  claudePackageLock: JsonRecord;
  claudeArchiveLock: JsonRecord;
  openaiPackageLock: JsonRecord | null;
  openaiArchiveLock: JsonRecord | null;
};

export type LiveExomemAgentContract = {
  profile: typeof EXOMEM_HOSTED_PROFILE;
  endpoint: typeof EXOMEM_HOSTED_RESOURCE;
  sourceRelease: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
  protocolVersion: string;
  mcpProtocolVersions: string[];
  contract: JsonRecord;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!SHA256.test(candidate)) throw new Error(`${label} must be SHA-256`);
  return candidate;
}

function mcpProtocolVersions(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((version) => typeof version !== "string" || !/^20\d\d-\d\d-\d\d$/.test(version)) ||
    new Set(value).size !== value.length
  )
    throw new Error("MCP protocol versions are invalid");
  return [...value] as string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkedOpenAiLocks(
  packageLock: unknown,
  archiveLock: unknown
): { packageLock: JsonRecord; archiveLock: JsonRecord } {
  const packageRecord = record(packageLock, "OpenAI package lock");
  const archiveRecord = record(archiveLock, "OpenAI archive lock");
  // Cumulative, not current-only: every release whose OpenAI locks we still
  // accept, including retained ones. The first entry is the current release via
  // the bare fixture, so each adoption must ADD the outgoing release here --
  // rotating the bare fixture silently drops it otherwise.
  const claudeLocks = [
    record(exomemHostedContractFixture.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0340.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0350.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0392.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0490.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0500.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0541.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0572.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0631.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0660.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0680.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0681.packageLock, "Claude package lock"),
    record(exomemHostedContractFixture0683.packageLock, "Claude package lock"),
  ];
  const requiredIdentityFields = [
    "schema_version",
    "platform_schema_version",
    "plugin_id",
    "plugin_version",
    "endpoint",
    "profile",
    "command_surface_sha256",
    "schema_contract_sha256",
    "definition_sha256",
    "skills_sha256",
    "compatibility_sha256",
    "oauth_discovery_sha256",
  ];
  const optionalIdentityFields = ["minimum_records_reader_version", "selection_cases_sha256"];
  const identityFields = [
    ...requiredIdentityFields,
    ...optionalIdentityFields.filter((key) => key in packageRecord),
  ];
  const packageKeys = [
    "platform",
    "artifact_sha256",
    "registered_app_id_sha256",
    ...identityFields,
  ];
  if (
    packageRecord.platform !== "openai" ||
    !claudeLocks.some((claudeLock) =>
      identityFields.every((key) => packageRecord[key] === claudeLock[key])
    ) ||
    Object.keys(packageRecord).length !== packageKeys.length ||
    Object.keys(packageRecord).some((key) => !packageKeys.includes(key))
  ) {
    throw new Error("OpenAI locks differ from the checked Exomem release");
  }
  const archiveKeys = ["platform", "archive_sha256", "registered_app_id_sha256"];
  if (
    archiveRecord.platform !== "openai" ||
    Object.keys(archiveRecord).length !== archiveKeys.length ||
    Object.keys(archiveRecord).some((key) => !archiveKeys.includes(key))
  ) {
    throw new Error("OpenAI archive lock is invalid");
  }
  sha256(packageRecord.artifact_sha256, "OpenAI package artifact digest");
  sha256(archiveRecord.archive_sha256, "OpenAI archive digest");
  if (
    sha256(packageRecord.registered_app_id_sha256, "OpenAI registered app ID digest") !==
    sha256(archiveRecord.registered_app_id_sha256, "OpenAI registered app ID digest")
  ) {
    throw new Error("OpenAI locks have different registered app ID digests");
  }
  return { packageLock: packageRecord, archiveLock: archiveRecord };
}

/**
 * The promotable releases as one SQL parameter. Promotion matches a candidate
 * against this set rather than an inline disjunction, so rotating the live
 * contract cannot leave the new release trusted for import but unpromotable.
 */
function trustedReleaseAllowlist(): string {
  return JSON.stringify(
    [...TRUSTED_RELEASES].map(([sourceRelease, trusted]) => ({
      source_release: sourceRelease,
      command_surface_sha256: trusted.command_surface_sha256,
      schema_contract_sha256: trusted.schema_contract_sha256,
      compatibility_sha256: trusted.compatibility_sha256,
      artifact_sha256: trusted.artifact_sha256,
      archive_sha256: trusted.archive_sha256,
    }))
  );
}

/** Import only the checked, pinned Exomem release fixture; callers cannot supply a contract. */
function checkedExomemAgentContractCandidate(fixture: unknown): ExomemAgentContractCandidate {
  const source = record(fixture, "fixture");
  const sourceRelease = string(source.sourceRelease, "fixture source release");
  const trusted = TRUSTED_RELEASES.get(sourceRelease as TrustedRelease);
  if (!trusted) throw new Error("agent contract fixture has an untrusted source release");
  if (source.sourceCommit !== trusted.sourceCommit)
    throw new Error("agent contract fixture has an untrusted source commit");
  const compatibility = record(source.compatibility, "compatibility");
  // Every release from 0.63.1 forward ships the v4 profile; earlier units stay v1.
  const expectedProfile: ExomemHostedProfile =
    sourceRelease === "0.63.1" ||
    sourceRelease === "0.66.0" ||
    sourceRelease === "0.68.0" ||
    sourceRelease === "0.68.1" ||
    sourceRelease === "0.68.3" ||
    sourceRelease === "0.72.1"
      ? EXOMEM_HOSTED_PROFILE
      : "hosted-alpha-agent-v1";
  const packageLock = record(source.packageLock, "Claude package lock");
  const archiveLock = record(source.archiveLock, "Claude archive lock");
  if (
    compatibility.command_surface_sha256 !== trusted.command_surface_sha256 ||
    compatibility.schema_contract_sha256 !== trusted.schema_contract_sha256 ||
    compatibility.compatibility_sha256 !== trusted.compatibility_sha256 ||
    packageLock.artifact_sha256 !== trusted.artifact_sha256 ||
    archiveLock.archive_sha256 !== trusted.archive_sha256
  ) {
    throw new Error("agent contract fixture differs from the trusted Exomem release");
  }
  if (compatibility.schema_version !== 1) throw new Error("unsupported compatibility schema");
  if (
    compatibility.profile !== expectedProfile ||
    compatibility.endpoint !== EXOMEM_HOSTED_RESOURCE
  ) {
    throw new Error("compatibility identity is not the Hosted agent contract");
  }
  const agentContract = record(compatibility.agent_contract, "agent contract");
  const profile = record(agentContract.agent_profile, "agent profile");
  const digest = record(agentContract.digest, "agent contract digest");
  const tools = (agentContract.commands as unknown[] | undefined)?.map((command) => {
    const raw = record(command, "agent command");
    const mcpTool = record(raw.mcp_tool, "raw MCP tool");
    if (string(raw.name, "agent command name") !== string(mcpTool.name, "raw MCP tool name")) {
      throw new Error("raw MCP tool name differs from the imported command");
    }
    if (
      typeof mcpTool.description !== "string" ||
      !record(mcpTool.inputSchema, "raw MCP input schema")
    ) {
      throw new Error("raw MCP tool is incomplete");
    }
    record(mcpTool.annotations, "raw MCP annotations");
    return mcpTool;
  });
  if (
    !tools?.length ||
    profile.profile !== expectedProfile ||
    agentContract.protocol_version !== "1"
  ) {
    throw new Error("agent profile has an unsupported protocol");
  }
  const commandSurfaceSha256 = sha256(
    compatibility.command_surface_sha256,
    "command surface digest"
  );
  const schemaDigest = sha256(compatibility.schema_contract_sha256, "schema digest");
  if (
    sha256(profile.active_capability_sha256, "agent profile digest") !== commandSurfaceSha256 ||
    sha256(digest.value, "agent contract digest") !== schemaDigest ||
    digest.algorithm !== "sha256"
  ) {
    throw new Error("agent contract digests disagree");
  }
  for (const [key, expected] of Object.entries({
    endpoint: EXOMEM_HOSTED_RESOURCE,
    profile: expectedProfile,
    command_surface_sha256: commandSurfaceSha256,
    schema_contract_sha256: schemaDigest,
    compatibility_sha256: sha256(compatibility.compatibility_sha256, "compatibility digest"),
  })) {
    if (packageLock[key] !== expected) throw new Error(`package lock differs for ${key}`);
  }
  if (packageLock.platform !== archiveLock.platform || typeof packageLock.platform !== "string") {
    throw new Error("package and archive locks must name the same platform");
  }
  sha256(packageLock.artifact_sha256, "package artifact digest");
  sha256(archiveLock.archive_sha256, "archive digest");
  return {
    state: "pending",
    profile: expectedProfile,
    endpoint: EXOMEM_HOSTED_RESOURCE,
    sourceRelease,
    commandSurfaceSha256,
    schemaDigest,
    compatibilitySha256: sha256(compatibility.compatibility_sha256, "compatibility digest"),
    protocolVersion: string(agentContract.protocol_version, "protocol version"),
    mcpProtocolVersions: [...MCP_PROTOCOL_VERSIONS],
    tools,
    compatibility,
    claudePackageLock: packageLock,
    claudeArchiveLock: archiveLock,
    openaiPackageLock:
      source.openaiPackageLock === undefined && source.openaiArchiveLock === undefined
        ? null
        : checkedOpenAiLocks(source.openaiPackageLock, source.openaiArchiveLock).packageLock,
    openaiArchiveLock:
      source.openaiPackageLock === undefined && source.openaiArchiveLock === undefined
        ? null
        : checkedOpenAiLocks(source.openaiPackageLock, source.openaiArchiveLock).archiveLock,
  };
}

/** Store the sole checked Exomem fixture; no caller-supplied contract is accepted. */
export async function storeExomemAgentContractCandidate(): Promise<string> {
  return storeCheckedExomemAgentContractCandidate(
    checkedExomemAgentContractCandidate(exomemHostedContractFixture)
  );
}

/** A rollback begins with a fresh pending UUID from an immutable retained release fixture. */
export async function storeRetainedExomemAgentContractCandidate(
  sourceRelease: TrustedRelease
): Promise<string> {
  const fixture =
    sourceRelease === "0.34.0"
      ? exomemHostedContractFixture0340
      : sourceRelease === "0.35.0"
        ? exomemHostedContractFixture0350
        : sourceRelease === "0.39.2"
          ? exomemHostedContractFixture0392
          : sourceRelease === "0.49.0"
            ? exomemHostedContractFixture0490
            : sourceRelease === "0.50.0"
              ? exomemHostedContractFixture0500
              : sourceRelease === "0.54.1"
                ? exomemHostedContractFixture0541
                : sourceRelease === "0.57.2"
                  ? exomemHostedContractFixture0572
                  : sourceRelease === "0.63.1"
                    ? exomemHostedContractFixture0631
                    : sourceRelease === "0.66.0"
                      ? exomemHostedContractFixture0660
                      : sourceRelease === "0.68.0"
                        ? exomemHostedContractFixture0680
                        : sourceRelease === "0.68.1"
                          ? exomemHostedContractFixture0681
                          : exomemHostedContractFixture;
  return storeCheckedExomemAgentContractCandidate(checkedExomemAgentContractCandidate(fixture));
}

async function storeCheckedExomemAgentContractCandidate(
  candidate: ExomemAgentContractCandidate
): Promise<string> {
  const { rows } = await executeExomemSql`
    /* exomem:store-agent-contract-candidate */
    INSERT INTO exomem_agent_contract_candidates (
      state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
      compatibility_digest, protocol_version, mcp_protocol_versions, contract, claude_package_lock, claude_archive_lock,
      openai_package_lock, openai_archive_lock
    ) VALUES (
      'pending', ${candidate.profile}, ${candidate.endpoint}, ${candidate.sourceRelease},
      ${candidate.commandSurfaceSha256}, ${candidate.schemaDigest}, ${candidate.compatibilitySha256},
      ${candidate.protocolVersion}, ${JSON.stringify(candidate.mcpProtocolVersions)}::jsonb, ${JSON.stringify(candidate.compatibility)}::jsonb,
      ${JSON.stringify(candidate.claudePackageLock)}::jsonb, ${JSON.stringify(candidate.claudeArchiveLock)}::jsonb,
      ${candidate.openaiPackageLock === null ? null : JSON.stringify(candidate.openaiPackageLock)}::jsonb,
      ${candidate.openaiArchiveLock === null ? null : JSON.stringify(candidate.openaiArchiveLock)}::jsonb
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("agent contract candidate insert returned no id");
  return id;
}

/** Discovery reads one already-promoted contract; it never contacts or wakes a cell. */
export async function getLiveExomemAgentContract(): Promise<LiveExomemAgentContract | null> {
  const { rows } = await executeExomemSql`
    /* exomem:get-live-agent-contract */
    SELECT profile_id, endpoint, source_release, command_fingerprint, schema_digest,
           compatibility_digest, protocol_version, mcp_protocol_versions, contract
    FROM exomem_agent_contract_candidates
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
      AND endpoint = ${EXOMEM_HOSTED_RESOURCE}
      AND state = 'live'
    LIMIT 2
  `;
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  try {
    if (row.profile_id !== EXOMEM_HOSTED_PROFILE || row.endpoint !== EXOMEM_HOSTED_RESOURCE)
      return null;
    return {
      profile: EXOMEM_HOSTED_PROFILE,
      endpoint: EXOMEM_HOSTED_RESOURCE,
      sourceRelease: string(row.source_release, "live source release"),
      commandFingerprint: sha256(row.command_fingerprint, "live command fingerprint"),
      schemaDigest: sha256(row.schema_digest, "live schema digest"),
      compatibilityDigest: sha256(row.compatibility_digest, "live compatibility digest"),
      protocolVersion: string(row.protocol_version, "live protocol version"),
      mcpProtocolVersions: mcpProtocolVersions(row.mcp_protocol_versions),
      contract: record(row.contract, "live contract"),
    };
  } catch {
    return null;
  }
}

/**
 * MCP contract selection is derived solely from the access-token lineage and
 * the tenant's attested binding. Candidate lineage never falls back to live.
 */
export async function getExomemAgentContractForOAuthAccess(input: {
  tenantId: string;
  candidateId?: string;
  assignmentId?: string;
  assignmentGeneration?: bigint;
}): Promise<LiveExomemAgentContract | null> {
  const candidateId = input.candidateId;
  const candidateLineage = candidateId !== undefined;
  if (
    (candidateLineage &&
      (!input.assignmentId ||
        !input.assignmentGeneration ||
        input.assignmentGeneration < BigInt(1))) ||
    !UUID.test(input.tenantId) ||
    (candidateId !== undefined && !UUID.test(candidateId)) ||
    (input.assignmentId !== undefined && !UUID.test(input.assignmentId))
  ) {
    return null;
  }
  const { rows } = await executeExomemSql`
    /* exomem:get-agent-contract-for-oauth-access */
    WITH access_tenant AS (
      SELECT tenant.id, tenant.bound_cell_id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}::uuid
    ), selected AS (
      SELECT candidate.profile_id, candidate.endpoint, candidate.source_release,
             candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest,
             candidate.protocol_version, candidate.mcp_protocol_versions, candidate.contract
      FROM exomem_agent_contract_candidates AS candidate
      JOIN access_tenant ON true
      LEFT JOIN (SELECT DISTINCT candidate_id AS id FROM exomem_hosted_alpha_platform_cohort) AS cohort
        ON cohort.id = candidate.id
      LEFT JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.id = ${input.assignmentId ?? null}::uuid
       AND assignment.tenant_id = access_tenant.id
       AND assignment.candidate_id = candidate.id
       AND assignment.generation = ${input.assignmentGeneration?.toString() ?? null}::bigint
      LEFT JOIN exomem_routable_cell_contracts AS binding
        ON binding.cell_id = access_tenant.bound_cell_id
       AND binding.profile_id = ${EXOMEM_HOSTED_PROFILE}
       AND binding.routable = true
      WHERE candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
        AND candidate.endpoint = ${EXOMEM_HOSTED_RESOURCE}
        AND (
          (
            ${candidateLineage} = false
            AND candidate.state = 'live'
            AND cohort.id = candidate.id
            AND (
              access_tenant.bound_cell_id IS NULL OR (
                binding.source_release = candidate.source_release
                AND binding.protocol_version = candidate.protocol_version
                AND binding.command_fingerprint = candidate.command_fingerprint
                AND binding.contract_digest = candidate.schema_digest
                AND binding.compatibility_digest = candidate.compatibility_digest
              )
            )
          ) OR (
            ${candidateLineage} = true
            AND candidate.id = ${candidateId ?? null}::uuid
            AND (
              (
                candidate.state = 'live'
                AND cohort.id = candidate.id
                AND (
                  access_tenant.bound_cell_id IS NULL OR (
                    binding.source_release = candidate.source_release
                    AND binding.protocol_version = candidate.protocol_version
                    AND binding.command_fingerprint = candidate.command_fingerprint
                    AND binding.contract_digest = candidate.schema_digest
                    AND binding.compatibility_digest = candidate.compatibility_digest
                  )
                )
              ) OR (
                candidate.state = 'pending'
                AND assignment.id IS NOT NULL
                AND assignment.marketplace_reviewer_purpose = true
                AND assignment.state = 'active'
                AND assignment.expires_at > now()
                AND binding.source_release = candidate.source_release
                AND binding.protocol_version = candidate.protocol_version
                AND binding.command_fingerprint = candidate.command_fingerprint
                AND binding.contract_digest = candidate.schema_digest
                AND binding.compatibility_digest = candidate.compatibility_digest
              )
            )
          )
        )
      LIMIT 2
    ) SELECT * FROM selected
  `;
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  try {
    return {
      profile: EXOMEM_HOSTED_PROFILE,
      endpoint: EXOMEM_HOSTED_RESOURCE,
      sourceRelease: string(row.source_release, "selected source release"),
      commandFingerprint: sha256(row.command_fingerprint, "selected command fingerprint"),
      schemaDigest: sha256(row.schema_digest, "selected schema digest"),
      compatibilityDigest: sha256(row.compatibility_digest, "selected compatibility digest"),
      protocolVersion: string(row.protocol_version, "selected protocol version"),
      mcpProtocolVersions: mcpProtocolVersions(row.mcp_protocol_versions),
      contract: record(row.contract, "selected contract"),
    };
  } catch {
    return null;
  }
}

/** The operator uses this opaque identifier as the cohort promotion compare-and-swap value. */
export async function getLiveExomemHostedCohortCandidateId(): Promise<string | null> {
  const { rows } = await executeExomemSql`
    /* exomem:get-live-hosted-cohort-candidate */
    SELECT DISTINCT candidate_id::text AS id FROM exomem_hosted_alpha_platform_cohort LIMIT 2
  `;
  return rows.length === 1 && typeof rows[0]?.id === "string" ? rows[0].id : null;
}

export type OperatorExomemAgentContractStatus = {
  id: string;
  state: "pending" | "live" | "retired";
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
};

export type OperatorExomemHostedRolloutStatus = {
  candidateId: string;
  state: "pending" | "live" | "retired";
  sourceRelease: string;
  routableCellCount: number;
  routableSetDigest: string | null;
  routableObservationFresh: boolean;
  observedSourceRelease: string | null;
  observedProtocolVersion: string | null;
  currentTargetSourceRelease: string | null;
};

function routableCellIdentities(value: unknown): RoutableCellIdentity[] | null {
  if (!Array.isArray(value)) return null;
  const identities: RoutableCellIdentity[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      typeof row.cell_id !== "string" ||
      typeof row.source_release !== "string" ||
      typeof row.protocol_version !== "string" ||
      !SHA256.test(String(row.command_fingerprint)) ||
      !SHA256.test(String(row.contract_digest)) ||
      !SHA256.test(String(row.compatibility_digest))
    )
      return null;
    identities.push(row as RoutableCellIdentity);
  }
  return identities;
}

/** Content-free operator view of candidate readiness, observed authority, and latest lifecycle target. */
export async function listExomemHostedRolloutStatus(): Promise<
  OperatorExomemHostedRolloutStatus[]
> {
  const { rows } = await executeExomemSql`
    /* exomem:list-hosted-rollout-status */
    SELECT candidate.id::text AS candidate_id, candidate.state, candidate.source_release,
           routable.identities AS routable_identities,
           authority.routable_set_digest AS observed_routable_set_digest,
           COALESCE(authority.observed_at > now() - interval '5 minutes', false)
             AS observation_within_freshness_window,
           authority.source_release AS observed_source_release,
           authority.protocol_version AS observed_protocol_version,
           latest.target_source_release AS current_target_source_release
    FROM exomem_agent_contract_candidates AS candidate
    LEFT JOIN exomem_agent_contract_profile_authority AS authority
      ON authority.profile_id = candidate.profile_id
     AND authority.source_release = candidate.source_release
     AND authority.protocol_version = candidate.protocol_version
     AND authority.command_fingerprint = candidate.command_fingerprint
     AND authority.contract_digest = candidate.schema_digest
     AND authority.compatibility_digest = candidate.compatibility_digest
    LEFT JOIN LATERAL (
      SELECT COALESCE(
               json_agg(
                 json_build_object(
                   'cell_id', cell.cell_id::text,
                   'source_release', cell.source_release,
                   'protocol_version', cell.protocol_version,
                   'command_fingerprint', cell.command_fingerprint,
                   'contract_digest', cell.contract_digest,
                   'compatibility_digest', cell.compatibility_digest
                 ) ORDER BY cell.cell_id
               ),
               '[]'::json
             ) AS identities
      FROM exomem_routable_cell_contracts AS cell
      WHERE cell.profile_id = candidate.profile_id AND cell.routable = true
    ) AS routable ON TRUE
    LEFT JOIN LATERAL (
      SELECT operation.target_source_release
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.target_candidate_id = candidate.id
      ORDER BY operation.updated_at DESC
      LIMIT 1
    ) AS latest ON TRUE
    WHERE candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
    ORDER BY candidate.created_at DESC
    LIMIT 50
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const identities = routableCellIdentities(row.routable_identities);
    if (identities === null) return [];
    const digest = routableSetDigest(EXOMEM_HOSTED_PROFILE, identities);
    if (
      typeof row.candidate_id !== "string" ||
      (row.state !== "pending" && row.state !== "live" && row.state !== "retired") ||
      typeof row.source_release !== "string" ||
      (row.observed_routable_set_digest !== null &&
        !SHA256.test(String(row.observed_routable_set_digest))) ||
      typeof row.observation_within_freshness_window !== "boolean" ||
      (row.observed_source_release !== null && typeof row.observed_source_release !== "string") ||
      (row.observed_protocol_version !== null &&
        typeof row.observed_protocol_version !== "string") ||
      (row.current_target_source_release !== null &&
        typeof row.current_target_source_release !== "string")
    )
      return [];
    return [
      {
        candidateId: row.candidate_id,
        state: row.state,
        sourceRelease: row.source_release,
        routableCellCount: identities.length,
        routableSetDigest: digest,
        routableObservationFresh:
          row.observed_routable_set_digest === digest && row.observation_within_freshness_window,
        observedSourceRelease: row.observed_source_release,
        observedProtocolVersion: row.observed_protocol_version,
        currentTargetSourceRelease: row.current_target_source_release,
      },
    ];
  });
}

/** Operator status exposes only candidate IDs and verification digests, never contract content. */
export async function listExomemAgentContractStatus(): Promise<
  OperatorExomemAgentContractStatus[]
> {
  const { rows } = await executeExomemSql`
    /* exomem:list-agent-contract-status */
    SELECT id, state, command_fingerprint, schema_digest, compatibility_digest
    FROM exomem_agent_contract_candidates
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      (row.state !== "pending" && row.state !== "live" && row.state !== "retired") ||
      typeof row.command_fingerprint !== "string" ||
      typeof row.schema_digest !== "string" ||
      typeof row.compatibility_digest !== "string"
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        state: row.state,
        commandFingerprint: row.command_fingerprint,
        schemaDigest: row.schema_digest,
        compatibilityDigest: row.compatibility_digest,
      },
    ];
  });
}

/** A rollback retires the live candidate atomically; it never marks it as a failed import. */
export async function demoteExomemAgentContractCandidate(candidateId: string): Promise<boolean> {
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await transaction`
      /* exomem:demote-agent-contract-candidate */
      UPDATE exomem_agent_contract_candidates
      SET state = 'retired', retired_at = now()
      WHERE id = ${candidateId}::uuid
        AND profile_id = ${EXOMEM_HOSTED_PROFILE}
        AND state = 'live'
      RETURNING id
    `;
    return rows.length === 1;
  });
}

/** Attach operator-signed, exact OpenAI locks after a registered app is rendered from this pinned release. */
export async function attachOpenAiContractLocks(input: {
  candidateId: string;
  packageLock: unknown;
  archiveLock: unknown;
  operatorKeyId: string;
  operatorSignature: string;
}): Promise<boolean> {
  const locks = checkedOpenAiLocks(input.packageLock, input.archiveLock);
  const keyId = process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID;
  const secret = process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET;
  const unsigned = {
    candidateId: input.candidateId,
    packageLock: locks.packageLock,
    archiveLock: locks.archiveLock,
    operatorKeyId: input.operatorKeyId,
  };
  if (!keyId || !secret || input.operatorKeyId !== keyId)
    throw new Error("OpenAI lock import requires an operator-trusted signing key");
  const expected = createHmac("sha256", secret).update(canonical(unsigned)).digest();
  const supplied = Buffer.from(input.operatorSignature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("OpenAI lock import signature is invalid");
  }
  const { rows } = await executeExomemSql`
    /* exomem:attach-openai-contract-locks */
    UPDATE exomem_agent_contract_candidates
    SET openai_package_lock = ${JSON.stringify(locks.packageLock)}::jsonb,
        openai_archive_lock = ${JSON.stringify(locks.archiveLock)}::jsonb
    WHERE id = ${input.candidateId}::uuid AND profile_id = ${EXOMEM_HOSTED_PROFILE} AND state = 'pending'
      AND (
        (openai_package_lock IS NULL AND openai_archive_lock IS NULL)
        OR (
          openai_package_lock = ${JSON.stringify(locks.packageLock)}::jsonb
          AND openai_archive_lock = ${JSON.stringify(locks.archiveLock)}::jsonb
        )
      )
      AND command_fingerprint = ${String(locks.packageLock.command_surface_sha256)}
      AND schema_digest = ${String(locks.packageLock.schema_contract_sha256)}
      AND compatibility_digest = ${String(locks.packageLock.compatibility_sha256)}
    RETURNING id
  `;
  return rows.length === 1;
}

/** Caller holds the cohort lock; refresh promotion authority from the exact post-write route set. */
export async function refreshRoutableProfileAuthorityInTransaction(
  transaction: ExomemSql,
  observedCellId: string,
  fallbackIdentity?: Omit<RoutableCellIdentity, "cell_id">
): Promise<void> {
  const { rows } = await transaction`
    SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint,
           contract_digest, compatibility_digest
    FROM exomem_routable_cell_contracts
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
    ORDER BY cell_id
    FOR UPDATE
  `;
  const identities = rows as RoutableCellIdentity[];
  const observed = identities.find((row) => row.cell_id === observedCellId) ?? fallbackIdentity;
  if (!observed) throw new Error("observed routable cell is missing from the profile route set");
  const sourceRelease = string(observed.source_release, "observed source release");
  const protocolVersion = string(observed.protocol_version, "observed protocol version");
  const fingerprint = sha256(observed.command_fingerprint, "observed command fingerprint");
  const contract = sha256(observed.contract_digest, "observed contract digest");
  const compatibility = sha256(observed.compatibility_digest, "observed compatibility digest");
  const digest = routableSetDigest(EXOMEM_HOSTED_PROFILE, identities);
  const allMatch = identities.every(
    (row) =>
      row.source_release === sourceRelease &&
      row.protocol_version === protocolVersion &&
      row.command_fingerprint === fingerprint &&
      row.contract_digest === contract &&
      row.compatibility_digest === compatibility
  );
  await transaction`
    INSERT INTO exomem_agent_contract_profile_authority (
      profile_id, routable_set_digest, routable_cell_count, source_release, protocol_version,
      command_fingerprint, contract_digest, compatibility_digest, observed_at
    ) VALUES (
      ${EXOMEM_HOSTED_PROFILE}, repeat('0', 64), 0, ${sourceRelease}, ${protocolVersion},
      ${fingerprint}, ${contract}, ${compatibility}, now()
    )
    ON CONFLICT (profile_id) DO NOTHING
  `;
  await transaction`
    SELECT profile_id
    FROM exomem_agent_contract_profile_authority
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
    FOR UPDATE
  `;
  await transaction`
    UPDATE exomem_agent_contract_profile_authority
    SET routable_set_digest = ${digest},
        routable_cell_count = ${identities.length},
        source_release = CASE WHEN ${allMatch} THEN ${sourceRelease} ELSE source_release END,
        protocol_version = CASE WHEN ${allMatch} THEN ${protocolVersion} ELSE protocol_version END,
        command_fingerprint = CASE WHEN ${allMatch} THEN ${fingerprint} ELSE command_fingerprint END,
        contract_digest = CASE WHEN ${allMatch} THEN ${contract} ELSE contract_digest END,
        compatibility_digest = CASE WHEN ${allMatch} THEN ${compatibility} ELSE compatibility_digest END,
        observed_at = now(),
        updated_at = now()
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
  `;
}

/** The sole standalone authority writer serializes behind the same cohort lock as binding. */
export async function recordRoutableCellObservation(input: {
  cellId: string;
  sourceRelease: string;
  protocolVersion: string;
  commandSurfaceSha256: string;
  schemaDigest: string;
  compatibilitySha256: string;
  routable: boolean;
}): Promise<void> {
  const fingerprint = sha256(input.commandSurfaceSha256, "command surface digest");
  const contract = sha256(input.schemaDigest, "schema digest");
  const compatibility = sha256(input.compatibilitySha256, "compatibility digest");
  await withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    await transaction`
      INSERT INTO exomem_routable_cell_contracts (
        cell_id, profile_id, source_release, protocol_version, command_fingerprint,
        contract_digest, compatibility_digest, routable, observed_at
      ) VALUES (
        ${input.cellId}::uuid, ${EXOMEM_HOSTED_PROFILE}, ${input.sourceRelease},
        ${input.protocolVersion}, ${fingerprint}, ${contract}, ${compatibility},
        ${input.routable}, now()
      )
      ON CONFLICT (cell_id, profile_id) DO UPDATE
      SET source_release = EXCLUDED.source_release,
          protocol_version = EXCLUDED.protocol_version,
          command_fingerprint = EXCLUDED.command_fingerprint,
          contract_digest = EXCLUDED.contract_digest,
          compatibility_digest = EXCLUDED.compatibility_digest,
          routable = EXCLUDED.routable,
          observed_at = now()
    `;
    await refreshRoutableProfileAuthorityInTransaction(transaction, input.cellId, {
      source_release: input.sourceRelease,
      protocol_version: input.protocolVersion,
      command_fingerprint: fingerprint,
      contract_digest: contract,
      compatibility_digest: compatibility,
    });
  });
}

export type ExomemHostedCohortPromotionResult = "promoted" | "already_live" | "precondition_failed";

/** Promote the contract and both native client artifacts as one locked cohort. */
export async function promoteExomemHostedCohort(input: {
  candidateId: string;
  claudeArtifactId: string;
  /**
   * Omit to promote a Claude-only cohort. Paired promotion is unchanged: when an
   * OpenAI artifact is supplied, every OpenAI precondition and the cross-client
   * evidence equality below are enforced exactly as before.
   */
  openaiArtifactId?: string | null;
  expectedLiveCandidateId: string | null;
  expectedRoutableCellDigest: string;
  claudeEvidence: unknown;
  openaiEvidence?: unknown;
}): Promise<ExomemHostedCohortPromotionResult> {
  const promoteOpenai = typeof input.openaiArtifactId === "string";
  const expected = sha256(input.expectedRoutableCellDigest, "routable cell digest");
  const { rows: candidateRows } = await executeExomemSql`
    SELECT state
    FROM exomem_agent_contract_candidates
    WHERE id = ${input.candidateId}::uuid AND profile_id = ${EXOMEM_HOSTED_PROFILE}
    LIMIT 1
  `;
  const candidateAlreadyLive = candidateRows[0]?.state === "live";
  const promotionHealth = candidateAlreadyLive
    ? null
    : await preparePromotionRuntimeHealth({
        candidateId: input.candidateId,
        expectedRoutableCellDigest: expected,
      });
  if (!candidateAlreadyLive && !promotionHealth) return "precondition_failed";
  try {
    return await withExomemTransaction(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
      const preconditionFailed = (): ExomemHostedCohortPromotionResult => {
        if (promotionHealth) throw new PromotionRuntimePreconditionError();
        return "precondition_failed";
      };
      await transaction`
      /* exomem:lock-routable-hosted-authority */
      SELECT profile_id FROM exomem_agent_contract_profile_authority
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
      FOR UPDATE
    `;
      const { rows: routableRows } = await transaction`
      /* exomem:lock-current-routable-hosted-cells */
      SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint,
             contract_digest, compatibility_digest
      FROM exomem_routable_cell_contracts
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
      ORDER BY cell_id
      FOR UPDATE
    `;
      if (
        routableSetDigest(EXOMEM_HOSTED_PROFILE, routableRows as RoutableCellIdentity[]) !==
        expected
      )
        return preconditionFailed();
      const claudeLocks = await loadClientArtifactLocks("claude", input.candidateId, transaction);
      const claudeEvidence = validatePromotionEvidence(input.claudeEvidence, "claude", claudeLocks);
      const openaiEvidence = promoteOpenai
        ? validatePromotionEvidence(
            input.openaiEvidence,
            "openai",
            await loadClientArtifactLocks("openai", input.candidateId, transaction)
          )
        : null;
      // Cross-client equality is what proves both clients attached to ONE cohort.
      // It is meaningful only when two platforms are promoted together, and is
      // enforced in full in exactly that case.
      if (openaiEvidence) {
        for (const key of [
          "paired_run_hmac_sha256",
          "exomem_identity_hmac_sha256",
          "tenant_hmac_sha256",
        ]) {
          if (claudeEvidence[key] !== openaiEvidence[key])
            throw new Error("paired client evidence must name the same Hosted cohort");
        }
      }
      // Locked in its own statement rather than through FOR UPDATE on the queries
      // below: PostgreSQL refuses FOR UPDATE on the nullable side of an outer
      // join, and the OpenAI artifact is now optional.
      if (openaiEvidence) {
        await transaction`
          /* exomem:lock-promoted-openai-artifact */
          SELECT 1 FROM exomem_client_artifacts
          WHERE id = ${input.openaiArtifactId}::uuid
            AND platform = 'openai' AND state IN ('pending', 'live')
          FOR UPDATE
        `;
      }
      const openaiDigests = openaiEvidence
        ? {
            evidence: promotionEvidenceDigest(openaiEvidence),
            result: sha256(openaiEvidence.result_sha256, "OpenAI result digest"),
            packageArtifact: sha256(
              openaiEvidence.package_artifact_sha256,
              "OpenAI package digest"
            ),
            archive: sha256(openaiEvidence.archive_sha256, "OpenAI archive digest"),
            clientIdentity: sha256(
              openaiEvidence.clean_client_identity_hmac_sha256,
              "OpenAI identity digest"
            ),
            pairedRun: sha256(openaiEvidence.paired_run_hmac_sha256, "OpenAI paired-run digest"),
            exomemIdentity: sha256(
              openaiEvidence.exomem_identity_hmac_sha256,
              "OpenAI Exomem identity digest"
            ),
            tenant: sha256(openaiEvidence.tenant_hmac_sha256, "OpenAI tenant digest"),
            oauthClientConfig: sha256(
              openaiEvidence.oauth_client_config_sha256,
              "OpenAI OAuth client configuration digest"
            ),
          }
        : null;
      const { rows: terminalRows } = await transaction`
        /* exomem:lock-terminal-hosted-cohort-replay */
        SELECT candidate.state AS candidate_state, claude.state AS claude_state, openai.state AS openai_state
        FROM exomem_agent_contract_candidates AS candidate
        JOIN exomem_client_artifacts AS claude
          ON claude.id = ${input.claudeArtifactId}::uuid
         AND claude.platform = 'claude'
         AND claude.contract_candidate_id = candidate.id
         AND claude.evidence_sha256 = ${promotionEvidenceDigest(claudeEvidence)}
        LEFT JOIN exomem_client_artifacts AS openai
          ON openai.id = ${input.openaiArtifactId ?? null}::uuid
         AND openai.platform = 'openai'
         AND openai.contract_candidate_id = candidate.id
         AND openai.evidence_sha256 = ${openaiDigests?.evidence ?? null}
        WHERE candidate.id = ${input.candidateId}::uuid
          AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
        FOR UPDATE OF candidate, claude
      `;
      const terminal = terminalRows[0];
      if (
        terminal?.candidate_state === "live" &&
        terminal.claude_state === "live" &&
        (promoteOpenai ? terminal.openai_state === "live" : true) &&
        (input.expectedLiveCandidateId === null ||
          input.expectedLiveCandidateId === input.candidateId)
      )
        return "already_live";
      if (
        promotionHealth &&
        !(await recordPromotionRuntimeAuthorityInTransaction({
          transaction,
          candidateId: input.candidateId,
          expectedRoutableCellDigest: expected,
          probes: promotionHealth,
          refreshAuthority: refreshRoutableProfileAuthorityInTransaction,
        }))
      )
        return "precondition_failed";
      const { rows: liveRows } = await transaction`
      /* exomem:lock-live-hosted-cohort */
      SELECT id::text AS id
      FROM exomem_agent_contract_candidates
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND state = 'live'
      ORDER BY id
      FOR UPDATE
    `;
      const liveCandidateIds = liveRows.flatMap((row) =>
        typeof row.id === "string" ? [row.id] : []
      );
      if (
        liveCandidateIds.length !== (input.expectedLiveCandidateId === null ? 0 : 1) ||
        (input.expectedLiveCandidateId !== null &&
          liveCandidateIds[0] !== input.expectedLiveCandidateId)
      ) {
        return preconditionFailed();
      }
      const { rows } = await transaction`
      /* exomem:validate-hosted-cohort-promotion */
      WITH authority AS (
      SELECT authority.*
      FROM exomem_agent_contract_profile_authority AS authority
      WHERE authority.profile_id = ${EXOMEM_HOSTED_PROFILE}
      FOR UPDATE
    ), candidate AS (
      SELECT * FROM exomem_agent_contract_candidates
      WHERE id = ${input.candidateId}::uuid AND state IN ('pending', 'live')
      FOR UPDATE
    ), cells AS (
      SELECT route.source_release, route.protocol_version, route.command_fingerprint,
             route.contract_digest, route.compatibility_digest
      FROM candidate
      JOIN exomem_routable_cell_contracts AS route
        ON route.profile_id = ${EXOMEM_HOSTED_PROFILE}
       AND route.routable = true
      JOIN exomem_cells AS cell ON cell.id = route.cell_id
      JOIN exomem_tenants AS tenant
        ON tenant.id = cell.tenant_id
       AND tenant.bound_cell_id = cell.id
      JOIN LATERAL (
        SELECT operation.*
        FROM exomem_lifecycle_operations AS operation
        WHERE operation.cell_id = route.cell_id
          AND operation.tenant_id = cell.tenant_id
          AND operation.fence_generation = tenant.fence_generation
          AND operation.state = 'succeeded'
          AND operation.operation_type IN ('provision', 'restore')
          AND operation.checkpoint = 'bound'
          AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
          AND operation.target_candidate_id = candidate.id
          AND cell.observed_gateway_contract_digest IS NOT NULL
          AND cell.observed_command_fingerprint IS NOT NULL
          AND cell.observed_schema_digest IS NOT NULL
          AND cell.observed_compatibility_digest IS NOT NULL
          AND cell.observed_gateway_contract_digest = operation.target_gateway_contract_digest
          AND cell.observed_command_fingerprint = operation.target_command_fingerprint
          AND cell.observed_schema_digest = operation.target_schema_digest
          AND cell.observed_compatibility_digest = operation.target_compatibility_digest
          AND route.source_release = operation.target_source_release
          AND route.protocol_version = operation.target_protocol_version
          AND route.command_fingerprint = operation.target_command_fingerprint
          AND route.contract_digest = operation.target_schema_digest
          AND route.compatibility_digest = operation.target_compatibility_digest
        ORDER BY operation.completed_at DESC NULLS LAST, operation.id
        LIMIT 1
        FOR UPDATE
      ) AS operation ON true
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.id = operation.target_assignment_id
       AND assignment.tenant_id = cell.tenant_id
       AND assignment.candidate_id = operation.target_candidate_id
       AND assignment.generation = operation.target_assignment_generation
       AND assignment.source_release = operation.target_source_release
       AND assignment.protocol_version = operation.target_protocol_version
       AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
       AND assignment.command_fingerprint = operation.target_command_fingerprint
       AND assignment.schema_digest = operation.target_schema_digest
       AND assignment.compatibility_digest = operation.target_compatibility_digest
       AND assignment.state = 'active'
       AND assignment.expires_at > now()
      WHERE cell.routing_state = 'bound'
        AND cell.lifecycle_state = 'active'
        AND tenant.status = 'active'
        AND tenant.desired_state = 'running'
        AND cell.readiness_code = 'CELL_READY'
      FOR UPDATE OF route, cell, tenant, operation, assignment
    ), claude AS (
      SELECT * FROM exomem_client_artifacts
      WHERE id = ${input.claudeArtifactId}::uuid AND platform = 'claude' AND state IN ('pending', 'live')
      FOR UPDATE
    ), openai AS (
      SELECT * FROM exomem_client_artifacts
      WHERE id = ${input.openaiArtifactId ?? null}::uuid AND platform = 'openai' AND state IN ('pending', 'live')
    ), exact_cells AS (
      SELECT candidate.state AS candidate_state, claude.state AS claude_state, openai.state AS openai_state
      FROM candidate
      JOIN authority ON authority.profile_id = candidate.profile_id
      JOIN claude ON true
      LEFT JOIN openai ON true
      WHERE EXISTS (SELECT 1 FROM cells)
        AND (SELECT count(*) FROM cells) = (
          SELECT count(*) FROM exomem_routable_cell_contracts AS route
          WHERE route.profile_id = ${EXOMEM_HOSTED_PROFILE} AND route.routable = true
        )
        AND candidate.mcp_protocol_versions IS NOT NULL
        AND exomem_mcp_protocol_versions_are_valid(candidate.mcp_protocol_versions)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${trustedReleaseAllowlist()}::jsonb) AS trusted
          WHERE candidate.source_release = trusted->>'source_release'
            AND candidate.command_fingerprint = trusted->>'command_surface_sha256'
            AND candidate.schema_digest = trusted->>'schema_contract_sha256'
            AND candidate.compatibility_digest = trusted->>'compatibility_sha256'
            AND candidate.claude_package_lock->>'artifact_sha256' = trusted->>'artifact_sha256'
            AND candidate.claude_archive_lock->>'archive_sha256' = trusted->>'archive_sha256'
        )
        AND authority.routable_set_digest = ${expected}
        AND (candidate.state = 'live' OR authority.observed_at > now() - interval '5 minutes')
        AND authority.source_release = candidate.source_release
        AND authority.protocol_version = candidate.protocol_version
        AND authority.command_fingerprint = candidate.command_fingerprint
        AND authority.contract_digest = candidate.schema_digest
        AND authority.compatibility_digest = candidate.compatibility_digest
        AND NOT EXISTS (
          SELECT 1 FROM cells
          WHERE source_release <> candidate.source_release
             OR protocol_version <> candidate.protocol_version
             OR command_fingerprint <> candidate.command_fingerprint
             OR contract_digest <> candidate.schema_digest
             OR compatibility_digest <> candidate.compatibility_digest
        )
        AND claude.evidence_sha256 = ${promotionEvidenceDigest(claudeEvidence)}
        AND claude.result_sha256 = ${sha256(claudeEvidence.result_sha256, "Claude result digest")}
        AND claude.package_sha256 = ${sha256(claudeEvidence.package_artifact_sha256, "Claude package digest")}
        AND claude.archive_sha256 = ${sha256(claudeEvidence.archive_sha256, "Claude archive digest")}
        AND claude.compatibility_sha256 = candidate.compatibility_digest
        AND claude.contract_sha256 = candidate.schema_digest
        AND claude.plugin_version = candidate.claude_package_lock->>'plugin_version'
        AND claude.contract_candidate_id = candidate.id
        AND claude.client_identity_sha256 = ${sha256(claudeEvidence.clean_client_identity_hmac_sha256, "Claude identity digest")}
        AND claude.paired_run_hmac_sha256 = ${sha256(claudeEvidence.paired_run_hmac_sha256, "Claude paired-run digest")}
        AND claude.exomem_identity_hmac_sha256 = ${sha256(claudeEvidence.exomem_identity_hmac_sha256, "Claude Exomem identity digest")}
        AND claude.tenant_hmac_sha256 = ${sha256(claudeEvidence.tenant_hmac_sha256, "Claude tenant digest")}
        AND claude.oauth_client_config_sha256 = ${sha256(
          claudeEvidence.oauth_client_config_sha256,
          "Claude OAuth client configuration digest"
        )}
        AND claude.oauth_client_config_sha256 IS NOT NULL
        AND claude.observed_at <= now() AND claude.observed_at > now() - interval '24 hours'
        AND (${!promoteOpenai} OR (
          openai.evidence_sha256 = ${openaiDigests?.evidence ?? null}
          AND openai.result_sha256 = ${openaiDigests?.result ?? null}
          AND openai.package_sha256 = ${openaiDigests?.packageArtifact ?? null}
          AND openai.archive_sha256 = ${openaiDigests?.archive ?? null}
          AND openai.compatibility_sha256 = candidate.compatibility_digest
          AND openai.contract_sha256 = candidate.schema_digest
          AND openai.plugin_version = candidate.openai_package_lock->>'plugin_version'
          AND openai.contract_candidate_id = candidate.id
          AND openai.registered_app_id_sha256 = candidate.openai_package_lock->>'registered_app_id_sha256'
          AND openai.client_identity_sha256 = ${openaiDigests?.clientIdentity ?? null}
          AND openai.paired_run_hmac_sha256 = ${openaiDigests?.pairedRun ?? null}
          AND openai.exomem_identity_hmac_sha256 = ${openaiDigests?.exomemIdentity ?? null}
          AND openai.tenant_hmac_sha256 = ${openaiDigests?.tenant ?? null}
          AND openai.oauth_client_config_sha256 = ${openaiDigests?.oauthClientConfig ?? null}
          AND openai.oauth_client_config_sha256 IS NOT NULL
          AND openai.observed_at <= now() AND openai.observed_at > now() - interval '24 hours'
        ))
        AND EXISTS (
          SELECT 1 FROM exomem_oauth_clients AS claude_client
          WHERE claude_client.enabled
            AND claude_client.client_platform = 'claude'
            AND claude_client.oauth_client_config_sha256 = claude.oauth_client_config_sha256
            AND claude_client.redirect_uris_digest = digest(convert_to(claude_client.redirect_uris::text, 'utf8'), 'sha256')
            AND (claude_client.admission_mode = 'pinned' OR (
              claude_client.metadata_document_digest IS NOT NULL
              AND claude_client.metadata_fetched_at IS NOT NULL
              AND claude_client.metadata_ttl_seconds BETWEEN 300 AND 604800
              AND claude_client.metadata_expires_at > now()
              AND claude_client.cimd_host IS NOT NULL
            ))
        )
        AND (${!promoteOpenai} OR (
          EXISTS (
            SELECT 1 FROM exomem_oauth_clients AS openai_client
            WHERE openai_client.enabled
              AND openai_client.client_platform = 'openai'
              AND openai_client.oauth_client_config_sha256 = openai.oauth_client_config_sha256
              AND openai_client.redirect_uris_digest = digest(convert_to(openai_client.redirect_uris::text, 'utf8'), 'sha256')
              AND (openai_client.admission_mode = 'pinned' OR (
                openai_client.metadata_document_digest IS NOT NULL
                AND openai_client.metadata_fetched_at IS NOT NULL
                AND openai_client.metadata_ttl_seconds BETWEEN 300 AND 604800
                AND openai_client.metadata_expires_at > now()
                AND openai_client.cimd_host IS NOT NULL
              ))
          )
        ))
      ) SELECT candidate_state, claude_state, openai_state FROM exact_cells
    `;
      const states = rows[0];
      if (!states) return preconditionFailed();
      if (
        states.candidate_state === "live" &&
        states.claude_state === "live" &&
        (promoteOpenai ? states.openai_state === "live" : true)
      ) {
        return "already_live";
      }
      if (
        states.candidate_state !== "pending" ||
        states.claude_state !== "pending" ||
        (promoteOpenai && states.openai_state !== "pending")
      ) {
        return preconditionFailed();
      }
      await transaction`
      /* exomem:retire-live-hosted-cohort */
      UPDATE exomem_agent_contract_candidates
      SET state = 'retired', retired_at = now()
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND state = 'live'
    `;
      await transaction`
      /* exomem:retire-live-hosted-client-artifacts */
      UPDATE exomem_client_artifacts
      SET state = 'retired', retired_at = now()
      WHERE platform IN ('claude', 'openai') AND state = 'live'
    `;
      await transaction`
      /* exomem:promote-hosted-cohort */
      UPDATE exomem_agent_contract_candidates
      SET state = 'live', promoted_at = now()
      WHERE id = ${input.candidateId}::uuid AND state = 'pending'
    `;
      await transaction`
      /* exomem:promote-hosted-cohort-client-artifacts */
      UPDATE exomem_client_artifacts
      SET state = 'live', promoted_at = now()
      WHERE (id = ${input.claudeArtifactId}::uuid
             OR id = ${input.openaiArtifactId ?? null}::uuid)
        AND state = 'pending'
    `;
      await transaction`
      /* exomem:retire-promoted-hosted-cohort-assignments */
      UPDATE exomem_agent_contract_rollout_assignments
      SET state = 'retired', activated_at = NULL, ended_at = now(),
          version = version + 1, updated_at = now()
      WHERE candidate_id = ${input.candidateId}::uuid
        AND state IN ('preparing', 'active')
    `;
      await transaction`
      /* exomem:retire-promoted-hosted-cohort-stages */
      UPDATE exomem_staged_client_releases
      SET state = 'retired', evidenced_at = NULL, ended_at = now(),
          version = version + 1, updated_at = now()
      WHERE candidate_id = ${input.candidateId}::uuid
        AND state IN ('staged', 'evidenced')
    `;
      await revokeConflictingCandidateOAuthLineageInTransaction(transaction, input.candidateId);
      const { rows: cohortRows } = await transaction`
      /* exomem:assert-promoted-hosted-cohort */
      SELECT DISTINCT candidate_id::text AS id FROM exomem_hosted_alpha_platform_cohort
    `;
      if (cohortRows.length !== 1 || cohortRows[0]?.id !== input.candidateId)
        throw new Error("atomic Hosted cohort promotion produced a partial cohort");
      return "promoted";
    });
  } catch (error) {
    if (error instanceof PromotionRuntimePreconditionError) return "precondition_failed";
    throw error;
  }
}
