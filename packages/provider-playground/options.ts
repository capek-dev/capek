import { parseArgs } from 'node:util';
import { resolveModelSpecifier } from '@capekai/core/configuration';
import { adapterConfigurations, builtinProviders, experimentalProviders } from './providers';
import type { ProbeOptions } from './probe';

export const help = `Usage: bun run index.ts <provider/model> [prompt] [--tools]

Examples:
  bun run index.ts openai/gpt-4o-mini
  bun run index.ts deepseek/deepseek-chat "Say hello in Czech"
  bun run index.ts openrouter/openai/gpt-4o-mini --tools

Built-in providers: ${builtinProviders.join(', ')}
Experimental adapters (reuse original keys):
${adapterConfigurations.map(({ id, key }) => `  ${id}: ${key}`).join('\n')}
Built-in keys: <PROVIDER>_API_KEY in .env (hyphens become underscores).
--tools tests a harmless echo tool and its follow-up response.
Real calls cost money. Requests time out after 60 seconds; no retries.
`;

export function parseOptions(args: string[]): ProbeOptions | null {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, tools: { type: 'boolean' } },
  });
  if (values.help) return null;
  const [specifier, prompt] = positionals;
  if (!specifier || positionals.length > 2 || !/^[^/\s]+\/\S+$/.test(specifier)) {
    throw new Error('Expected provider/model and an optional quoted prompt. Use --help.');
  }
  const selection = resolveModelSpecifier(specifier);
  if (!builtinProviders.includes(selection.providerId) && !experimentalProviders.has(selection.providerId)) {
    throw new Error('Unknown provider. Add its adapter to providers.ts before testing it.');
  }
  return {
    ...selection,
    tools: values.tools ?? false,
    prompt: prompt ?? (values.tools
      ? 'Call echo with text "provider probe", then report the exact returned text.'
      : 'Say hello in one short sentence.'),
  };
}

export function keyVariable(providerId: string): string {
  return adapterConfigurations.find(({ id }) => id === providerId)?.key
    ?? `${providerId.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}
