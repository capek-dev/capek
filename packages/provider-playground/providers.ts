import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ConnectableProvider } from '@capekai/core/providers';

export const adapterConfigurations = [
  { id: 'minimax-anthropic', protocol: 'anthropic', key: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.io/anthropic/v1' },
  { id: 'zhipu-compatible', protocol: 'openai-compatible', key: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'zhipu-coding-compatible', protocol: 'openai-compatible', key: 'ZHIPU_CODING_API_KEY', baseURL: 'https://api.z.ai/api/coding/paas/v4' },
] as const;

// Injection keeps transport tests offline without replacing global fetch or real keys.
export function createExperimentalProviders(
  environment: Record<string, string | undefined> = process.env,
  fetch?: NonNullable<Parameters<typeof createAnthropic>[0]>['fetch'],
): Map<string, ConnectableProvider> {
  return new Map(adapterConfigurations.map((config) => [config.id, {
    descriptor: { id: config.id, displayName: config.id, authType: 'api_key', connectable: false, kind: 'llm' },
    getStatus: () => ({ provider: config.id, connected: Boolean(environment[config.key]?.trim()) }),
    connect: async () => ({}),
    disconnect: async () => {},
    onTokensReceived: async () => {},
    createModel: async ({ modelId }) => {
      const apiKey = environment[config.key]?.trim();
      if (!apiKey) throw new Error(`Set ${config.key} in .env`);
      const settings = { apiKey, baseURL: config.baseURL, fetch };
      return {
        model: config.protocol === 'anthropic'
          ? createAnthropic(settings)(modelId)
          : createOpenAICompatible({ ...settings, name: config.id })(modelId),
      };
    },
  }]));
}

// Separate IDs preserve built-in adapters for side-by-side comparison.
export const experimentalProviders = createExperimentalProviders();

// Keep this aligned with the built-in cases in ../capek/src/core/model-utils.ts.
// Unknown IDs must not fall through to the default OpenAI endpoint.
export const builtinProviders = [
  'openai', 'deepseek', 'openrouter', 'minimax', 'zhipu', 'zhipu-coding',
];
