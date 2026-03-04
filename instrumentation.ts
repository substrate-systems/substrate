import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');

    const sdkConfig: {
      spanProcessors: SpanProcessor[];
      logRecordProcessors: LogRecordProcessor[];
    } = {
      spanProcessors: [],
      logRecordProcessors: [],
    };

    if (process.env.NODE_ENV === 'development') {
      const { TidewaveSpanProcessor, TidewaveLogRecordProcessor } =
        await import('tidewave/next-js/instrumentation');

      sdkConfig.spanProcessors.push(new TidewaveSpanProcessor());
      sdkConfig.logRecordProcessors.push(new TidewaveLogRecordProcessor());
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();
  }
}
