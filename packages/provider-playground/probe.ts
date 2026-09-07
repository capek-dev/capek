import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import type { getModelWithMetadata } from '@capekai/core/execution';

export interface ProbeOptions {
  modelId: string;
  providerId: string;
  prompt: string;
  tools: boolean;
}

type ResolvedModel = Awaited<ReturnType<typeof getModelWithMetadata>>;

export async function streamProbe(
  options: ProbeOptions,
  resolved: ResolvedModel,
  write: (text: string) => void,
): Promise<void> {
  let toolExecuted = false;
  let textReceived = false;
  const started = performance.now();
  const result = streamText({
    model: resolved.model,
    system: resolved.useProviderInstructions ? undefined : 'Be concise. Use the echo tool when requested.',
    prompt: options.prompt,
    providerOptions: resolved.providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
    maxOutputTokens: resolved.omitMaxOutputTokens ? undefined : 512,
    maxRetries: 0,
    // Handle fullStream errors below, not the SDK's default raw console.error.
    onError: () => {},
    abortSignal: AbortSignal.timeout(60_000),
    stopWhen: stepCountIs(options.tools ? 3 : 1),
    tools: options.tools ? {
      echo: tool({
        description: 'Return the provided text unchanged. No side effects.',
        inputSchema: jsonSchema<{ text: string }>({
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        }),
        execute: async ({ text }) => {
          if (typeof text !== 'string') throw new Error('echo requires a string');
          toolExecuted = true;
          textReceived = false;
          return { text };
        },
      }),
    } : undefined,
  });
  for await (const event of result.fullStream) {
    switch (event.type) {
      case 'text-delta':
        textReceived ||= event.text.length > 0;
        write(event.text);
        break;
      case 'tool-call':
        write(`\n[tool call: ${event.toolName}]\n`);
        break;
      case 'tool-result':
        write(`\n[tool result: ${event.toolName}]\n`);
        break;
      case 'error':
        throw event.error;
      case 'tool-error':
        throw new Error('Tool execution failed.');
      case 'abort':
        throw new Error('Request aborted or timed out.');
    }
  }
  const usage = await result.totalUsage;
  write(`\n\nTokens: ${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out. Duration: ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
  if (!textReceived) throw new Error('Provider returned no text.');
  if (options.tools && !toolExecuted) throw new Error('Tool probe failed: echo was not executed.');
}
