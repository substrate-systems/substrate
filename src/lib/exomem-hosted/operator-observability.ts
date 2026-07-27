import { ExomemHostedError, safeErrorResponse } from "./errors";

function emitOperatorEvent(input: {
  outcome: "succeeded" | "denied";
  requestId: string;
  errorCode?: string;
}) {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "operator.control",
      outcome: input.outcome,
      requestId: input.requestId,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    })
  );
}

export function emitOperatorControlSuccess(requestId: string): void {
  emitOperatorEvent({ outcome: "succeeded", requestId });
}

export function operatorControlErrorResponse(error: unknown, requestId: string) {
  emitOperatorEvent({
    outcome: "denied",
    requestId,
    errorCode: error instanceof ExomemHostedError ? error.code : "INTERNAL_ERROR",
  });
  return safeErrorResponse(error, requestId);
}
