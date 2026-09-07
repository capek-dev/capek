import { createSingleModelConfiguration, withRuntimeConfiguration } from '@capekai/core/configuration';
import { getModelWithMetadata } from '@capekai/core/execution';
import { withProviderOverrides } from '@capekai/core/providers';
import { help, keyVariable, parseOptions } from './options';
import { experimentalProviders } from './providers';
import { streamProbe } from './probe';

try {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.log(help);
  } else {
    const configuration = createSingleModelConfiguration(options);
    if (!experimentalProviders.has(options.providerId) && !configuration.getApiKey(options.providerId)?.trim()) {
      throw new Error(`Set ${keyVariable(options.providerId)} in this example's .env before running.`);
    }
    console.log(`${options.providerId}/${options.modelId} (${options.tools ? 'tool probe' : 'text probe'})`);
    await withRuntimeConfiguration(configuration, () => withProviderOverrides(experimentalProviders, async () => {
      const resolved = await getModelWithMetadata({
        ...options,
        systemPrompt: 'Be concise. Use the echo tool when requested.',
      });
      await streamProbe(options, resolved, (text) => process.stdout.write(text));
    }));
  }
} catch (error: unknown) {
  // Never dump SDK error objects: they may include request headers or bodies.
  let message = error instanceof Error ? error.message : 'Provider request failed';
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD/i.test(name)) message = message.replaceAll(value, '[redacted]');
  }
  console.error(`\nFailed: ${message}`);
  process.exitCode = 1;
}
