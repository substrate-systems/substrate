import { ExomemHostedError } from "./errors";

const MCP_PATH = "/api/exomem/mcp/v1";
const DIRECT_V1_HOST = "exomem-direct.substratesystems.io";
export const DIRECT_V1_RESOURCE = `https://${DIRECT_V1_HOST}${MCP_PATH}`;

export type HostedIngress = {
  profile: "legacy" | "direct-v1";
  resource: string;
};

type HostedIngressEnvironment = {
  EXOMEM_HOSTED_INGRESS_PROFILE?: string;
  EXOMEM_HOSTED_DIRECT_RESOURCE?: string;
};

function invalidIngress(): never {
  throw new ExomemHostedError({
    code: "HOSTED_INGRESS_INVALID",
    status: 500,
    message: "hosted Exomem ingress configuration is invalid",
  });
}

function isPinnedDirectResource(value: string | undefined): value is typeof DIRECT_V1_RESOURCE {
  if (value !== DIRECT_V1_RESOURCE) return false;
  try {
    const resource = new URL(value);
    return (
      resource.protocol === "https:" &&
      resource.hostname === DIRECT_V1_HOST &&
      resource.port === "" &&
      !resource.username &&
      !resource.password &&
      resource.pathname === MCP_PATH &&
      !resource.search &&
      !resource.hash &&
      resource.toString() === DIRECT_V1_RESOURCE
    );
  } catch {
    return false;
  }
}

export function resolveHostedIngress(
  environment: HostedIngressEnvironment,
  publicBaseUrl: string
): HostedIngress {
  const profile = environment.EXOMEM_HOSTED_INGRESS_PROFILE;
  if (profile === undefined || profile === "" || profile === "legacy") {
    return {
      profile: "legacy",
      resource: `${publicBaseUrl}${MCP_PATH}`,
    };
  }
  if (
    profile !== "direct-v1" ||
    !isPinnedDirectResource(environment.EXOMEM_HOSTED_DIRECT_RESOURCE)
  ) {
    return invalidIngress();
  }
  return { profile, resource: DIRECT_V1_RESOURCE };
}

export function hostedIngressFromEnv(publicBaseUrl: string): HostedIngress {
  return resolveHostedIngress(
    {
      EXOMEM_HOSTED_INGRESS_PROFILE: process.env.EXOMEM_HOSTED_INGRESS_PROFILE,
      EXOMEM_HOSTED_DIRECT_RESOURCE: process.env.EXOMEM_HOSTED_DIRECT_RESOURCE,
    },
    publicBaseUrl
  );
}
