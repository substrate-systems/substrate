import { ExomemCloudConfigurationError } from "./cloud-config";
import { ExomemHostedError, exomemErrors } from "./errors";
import { safeErrorResponse } from "./next-error-response";

function emitOperatorEvent(input: {
  outcome: "succeeded" | "denied";
  requestId: string;
  errorCode?: string;
  variables?: readonly string[];
}) {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "operator.control",
      outcome: input.outcome,
      requestId: input.requestId,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.variables ? { variables: input.variables } : {}),
    })
  );
}

export function emitOperatorControlSuccess(requestId: string): void {
  emitOperatorEvent({ outcome: "succeeded", requestId });
}

export function operatorControlErrorResponse(error: unknown, requestId: string) {
  // A missing or malformed setting gets its own code, and the log names the variables (never
  // their values), so the operator sees what to fix instead of an unnamed internal error.
  const variables = error instanceof ExomemCloudConfigurationError ? error.missing : undefined;
  const reported = variables ? exomemErrors.cloudConfigurationInvalid() : error;
  emitOperatorEvent({
    outcome: "denied",
    requestId,
    errorCode: reported instanceof ExomemHostedError ? reported.code : "INTERNAL_ERROR",
    variables,
  });
  return safeErrorResponse(reported, requestId);
}
