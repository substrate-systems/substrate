import {
  PROVISIONER_PROTOCOL_V1,
  PROVISIONER_PROTOCOL_V2,
  type ProvisionerWireProtocol,
} from "./provisioner";

export function normalizeProvisionerWireProtocol(value: string | undefined): ProvisionerWireProtocol {
  return value?.trim().toLowerCase() === "true" ? PROVISIONER_PROTOCOL_V2 : PROVISIONER_PROTOCOL_V1;
}

export function provisionerWireProtocolFromEnv(): ProvisionerWireProtocol {
  return normalizeProvisionerWireProtocol(process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED);
}
