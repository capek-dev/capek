import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ProtocolProvider = 'minimax' | 'zhipu' | 'zhipu-coding';

export function createProtocolModel(
  providerId: ProtocolProvider,
  modelId: string,
  apiKey: string,
  fetch?: NonNullable<Parameters<typeof createAnthropic>[0]>['fetch'],
): LanguageModel {
  if (providerId === 'minimax') {
    return createAnthropic({ apiKey, baseURL: 'https://api.minimax.io/anthropic/v1', fetch })(modelId);
  }
  return createOpenAICompatible({
    name: providerId,
    apiKey,
    baseURL: providerId === 'zhipu'
      ? 'https://open.bigmodel.cn/api/paas/v4'
      : 'https://api.z.ai/api/coding/paas/v4',
    fetch,
  })(modelId);
}
