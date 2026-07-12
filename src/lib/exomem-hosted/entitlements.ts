/**
 * Provider-neutral Exomem entitlement evaluation.
 *
 * Request-time code supplies the internal source projection and lifecycle
 * state. This module deliberately has no Paddle, network or database import.
 */

export type ExomemLifecycleState = "provisioning" | "ready" | "deleted";
export type ExomemEffectiveState =
  | "provisioning"
  | "active"
  | "grace"
  | "suspended"
  | "cancelled"
  | "deleted";

export type ExomemSourceProjection =
  | { source: "complimentary"; state: "active" | "revoked" }
  | {
      source: "paddle";
      state: "active" | "trialing" | "past_due" | "paused" | "cancelled";
    };

export type ExomemCapability = "capture" | "recall" | "export";

export type ExomemResourceLimits = {
  storageBytes: number;
  uploadBytes: number;
  workerCount: number;
};

export type ExomemEntitlementBundle = {
  capabilities: readonly ExomemCapability[];
  resourceLimits: Readonly<ExomemResourceLimits>;
};

export const EXOMEM_ALPHA_BUNDLE: Readonly<ExomemEntitlementBundle> = Object.freeze({
  capabilities: Object.freeze(["capture", "recall", "export"]),
  resourceLimits: Object.freeze({
    storageBytes: 5 * 1024 * 1024 * 1024,
    uploadBytes: 100 * 1024 * 1024,
    workerCount: 0,
  }),
});

export type ExomemDecisionReason =
  | "allowed"
  | "provisioning"
  | "deleted"
  | "manually_suspended"
  | "complimentary_revoked"
  | "billing_grace"
  | "provider_paused"
  | "subscription_cancelled"
  | "checkout_available"
  | "portal_available"
  | "not_applicable"
  | "already_subscribed";

export type ExomemDecision = Readonly<{
  allowed: boolean;
  reason: ExomemDecisionReason;
}>;

export type EffectiveExomemEntitlement = Readonly<{
  effectiveState: ExomemEffectiveState;
  source: ExomemSourceProjection["source"];
  sourceState: ExomemSourceProjection["state"];
  capabilities: ExomemCapability[];
  resourceLimits: ExomemResourceLimits;
  decisions: {
    read: ExomemDecision;
    write: ExomemDecision;
    export: ExomemDecision;
    billing: {
      checkout: ExomemDecision;
      portal: ExomemDecision;
    };
  };
}>;

export type EvaluateExomemEntitlementInput = {
  lifecycleState: ExomemLifecycleState;
  sourceProjection: ExomemSourceProjection;
  manuallySuspended: boolean;
  bundle: ExomemEntitlementBundle;
};

const allow = (reason: ExomemDecisionReason = "allowed"): ExomemDecision => ({
  allowed: true,
  reason,
});
const deny = (reason: ExomemDecisionReason): ExomemDecision => ({
  allowed: false,
  reason,
});

type DataPolicy = {
  effectiveState: ExomemEffectiveState;
  read: ExomemDecision;
  write: ExomemDecision;
  export: ExomemDecision;
};

function dataPolicy(input: EvaluateExomemEntitlementInput): DataPolicy {
  if (input.lifecycleState === "deleted") {
    return {
      effectiveState: "deleted",
      read: deny("deleted"),
      write: deny("deleted"),
      export: deny("deleted"),
    };
  }
  if (input.lifecycleState === "provisioning") {
    return {
      effectiveState: "provisioning",
      read: deny("provisioning"),
      write: deny("provisioning"),
      export: deny("provisioning"),
    };
  }
  if (input.manuallySuspended) {
    return {
      effectiveState: "suspended",
      read: deny("manually_suspended"),
      write: deny("manually_suspended"),
      export: deny("manually_suspended"),
    };
  }

  const projection = input.sourceProjection;
  if (projection.source === "complimentary") {
    if (projection.state === "active") {
      return {
        effectiveState: "active",
        read: allow(),
        write: allow(),
        export: allow(),
      };
    }
    return {
      effectiveState: "suspended",
      read: deny("complimentary_revoked"),
      write: deny("complimentary_revoked"),
      export: deny("complimentary_revoked"),
    };
  }

  switch (projection.state) {
    case "active":
    case "trialing":
      return {
        effectiveState: "active",
        read: allow(),
        write: allow(),
        export: allow(),
      };
    case "past_due":
      return {
        effectiveState: "grace",
        read: allow(),
        write: deny("billing_grace"),
        export: allow(),
      };
    case "paused":
      return {
        effectiveState: "suspended",
        read: allow(),
        write: deny("provider_paused"),
        export: allow(),
      };
    case "cancelled":
      return {
        effectiveState: "cancelled",
        read: allow(),
        write: deny("subscription_cancelled"),
        export: allow(),
      };
  }
}

function billingPolicy(
  input: EvaluateExomemEntitlementInput
): EffectiveExomemEntitlement["decisions"]["billing"] {
  if (input.lifecycleState === "deleted") {
    return {
      checkout: deny("deleted"),
      portal: deny("deleted"),
    };
  }
  if (input.lifecycleState === "provisioning") {
    return {
      checkout: deny("provisioning"),
      portal: deny("provisioning"),
    };
  }
  if (input.sourceProjection.source === "complimentary") {
    return {
      checkout: allow("checkout_available"),
      portal: deny("not_applicable"),
    };
  }
  return {
    checkout:
      input.sourceProjection.state === "cancelled"
        ? allow("checkout_available")
        : deny("already_subscribed"),
    // Billing recovery remains reachable during data-path suspension.
    portal: allow("portal_available"),
  };
}

export function evaluateExomemEntitlement(
  input: EvaluateExomemEntitlementInput
): EffectiveExomemEntitlement {
  const policy = dataPolicy(input);
  const capabilities = input.bundle.capabilities.filter((capability) => {
    if (capability === "capture") return policy.write.allowed;
    if (capability === "recall") return policy.read.allowed;
    return policy.export.allowed;
  });

  return {
    effectiveState: policy.effectiveState,
    source: input.sourceProjection.source,
    sourceState: input.sourceProjection.state,
    capabilities,
    resourceLimits: { ...input.bundle.resourceLimits },
    decisions: {
      read: policy.read,
      write: policy.write,
      export: policy.export,
      billing: billingPolicy(input),
    },
  };
}
