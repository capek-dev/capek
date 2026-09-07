import { describe, expect, test } from 'bun:test';
import { createSingleModelConfiguration, withRuntimeConfiguration } from '@capekai/core/configuration';
import { getModelWithMetadata } from '@capekai/core/execution';
import { withProviderOverrides } from '@capekai/core/providers';
import { adapterConfigurations, createExperimentalProviders } from './providers';
import { keyVariable, parseOptions } from './options';
import { streamProbe } from './probe';

function mockFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

function compatibleStream(tool: boolean): Response {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const events = tool ? [
    chunk({ role: 'assistant', reasoning_content: 'Use echo.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"provider probe"}' } }] }),
    chunk({}, 'tool_calls'),
  ] : [chunk({ role: 'assistant', content: 'provider probe' }), chunk({}, 'stop')];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicStream(tool: boolean): Response {
  const events: object[] = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } },
  ];
  if (tool) {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Use echo.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'echo', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"provider probe"}' } },
      { type: 'content_block_stop', index: 1 },
    );
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'provider probe' } },
      { type: 'content_block_stop', index: 0 },
    );
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  );
  return new Response(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('experimental adapters, actual SDK transport (offline)', () => {
  for (const config of adapterConfigurations) {
    test(`${config.id}: routing, credentials, reasoning and tool round trip`, async () => {
      const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
      const providers = createExperimentalProviders({ [config.key]: 'fixture-key' }, mockFetch(async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        if (requests.length > 2) throw new Error('Unexpected extra call');
        return config.protocol === 'anthropic'
          ? anthropicStream(requests.length === 1)
          : compatibleStream(requests.length === 1);
      }));
      const options = parseOptions([`${config.id}/fixture`, '--tools'])!;
      expect(keyVariable(config.id)).toBe(config.key);
      let output = '';
      await withRuntimeConfiguration(createSingleModelConfiguration(options), () => withProviderOverrides(providers, async () => {
        const model = await getModelWithMetadata(options);
        await streamProbe(options, model, (text) => { output += text; });
      }));
      expect(output).toContain('[tool result: echo]');
      expect(output).toContain('provider probe');
      expect(requests).toHaveLength(2);
      const first = requests[0]!;
      expect(first.url).toBe(`${config.baseURL}/${config.protocol === 'anthropic' ? 'messages' : 'chat/completions'}`);
      expect(first.headers.get(config.protocol === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(config.protocol === 'anthropic' ? 'fixture-key' : 'Bearer fixture-key');
      expect(first.body.model).toBe('fixture');
      expect(first.body.stream).toBe(true);
      expect(first.body.max_tokens).toBe(512);
      expect(first.body).not.toHaveProperty('temperature');
      expect(first.body.tools).toBeArray();
      const history = requests[1]!.body.messages as { role: string; content: unknown; reasoning_content?: string; tool_calls?: unknown[] }[];
      const assistant = history.find((message) => message.role === 'assistant')!;
      if (config.protocol === 'anthropic') {
        expect(assistant.content).toContainEqual({ type: 'thinking', thinking: 'Use echo.', signature: 'fixture-signature' });
        expect(JSON.stringify(history)).toContain('tool_result');
      } else {
        expect(assistant.reasoning_content).toBe('Use echo.');
        expect(assistant.tool_calls).toHaveLength(1);
        expect(history.find((message) => message.role === 'tool')?.content).toContain('provider probe');
      }
    });

    test(`${config.id}: text-only stream`, async () => {
      let calls = 0;
      const providers = createExperimentalProviders({ [config.key]: 'fixture-key' }, mockFetch(async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('tools');
        return config.protocol === 'anthropic' ? anthropicStream(false) : compatibleStream(false);
      }));
      let output = '';
      await withProviderOverrides(providers, async () => {
        const options = parseOptions([`${config.id}/fixture`])!;
        await streamProbe(options, await getModelWithMetadata(options), (text) => { output += text; });
      });
      expect(calls).toBe(1);
      expect(output).toContain('provider probe');
    });

    test(`${config.id}: malformed stream fails`, async () => {
      const providers = createExperimentalProviders({ [config.key]: 'fixture-key' }, mockFetch(async () =>
        new Response('event: message_start\ndata: {not-json}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      ));
      await withProviderOverrides(providers, async () => {
        const options = parseOptions([`${config.id}/fixture`])!;
        await expect(streamProbe(options, await getModelWithMetadata(options), () => {})).rejects.toThrow();
      });
    });

    test(`${config.id}: missing keys fail before transport`, async () => {
      const providers = createExperimentalProviders({ [config.key]: ' ' }, mockFetch(async () => { throw new Error('Must not fetch'); }));
      expect(providers.get(config.id)!.getStatus().connected).toBe(false);
      await withProviderOverrides(providers, async () => {
        await expect(getModelWithMetadata({ providerId: config.id, modelId: 'fixture' })).rejects.toThrow(`Set ${config.key}`);
      });
    });

    test(`${config.id}: HTTP errors fail without retrying`, async () => {
      let calls = 0;
      const providers = createExperimentalProviders({ [config.key]: 'fixture-key' }, mockFetch(async () => {
        calls++;
        return Response.json({ error: { type: 'authentication_error', message: 'Invalid fixture key' } }, { status: 401 });
      }));
      await withProviderOverrides(providers, async () => {
        const options = parseOptions([`${config.id}/fixture`])!;
        const model = await getModelWithMetadata(options);
        await expect(streamProbe(options, model, () => {})).rejects.toThrow();
      });
      expect(calls).toBe(1);
    });
  }
});
