import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { keyVariable, parseOptions } from './options';
import { streamProbe } from './probe';

const options = { providerId: 'openai', modelId: 'fake', prompt: 'Hello', tools: false };
const usage = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function fakeModel(callTool = false) {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          const toolStep = callTool && calls++ === 0;
          controller.enqueue({ type: 'stream-start', warnings: [] });
          if (toolStep) {
            controller.enqueue({ type: 'tool-call', toolCallId: 'echo-1', toolName: 'echo', input: '{"text":"provider probe"}' });
          } else {
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello!' });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
          }
          controller.enqueue({ type: 'finish', finishReason: { unified: toolStep ? 'tool-calls' : 'stop', raw: undefined }, usage });
          controller.close();
        },
      }),
    }),
  });
}

describe('provider playground (offline)', () => {
  test('parses model IDs containing slashes and tool mode', () => {
    expect(parseOptions(['openrouter/openai/gpt-4o-mini', '--tools'])).toMatchObject({
      providerId: 'openrouter', modelId: 'openai/gpt-4o-mini', tools: true,
    });
    expect(parseOptions(['deepseek/deepseek-chat', 'custom prompt'])?.prompt).toBe('custom prompt');
    expect(keyVariable('zhipu-coding')).toBe('ZHIPU_CODING_API_KEY');
    expect(parseOptions(['--help'])).toBeNull();
  });

  test('rejects typos before a key can reach the OpenAI fallback', () => {
    for (const args of [[], ['openai/'], ['gpt-4o'], ['typo/model'], ['openai/model', '--typo']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  test('streams text and reports usage without a network request', async () => {
    let output = '';
    const model = fakeModel();
    await streamProbe(options, { model }, (text) => { output += text; });
    expect(output).toContain('Hello!');
    expect(output).toContain('4 in / 2 out');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(512);
    expect(model.doStreamCalls[0]?.temperature).toBeUndefined();
  });

  test('executes echo and completes the follow-up model call', async () => {
    const model = fakeModel(true);
    let output = '';
    await streamProbe({ ...options, tools: true }, { model, omitMaxOutputTokens: true }, (text) => { output += text; });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBeUndefined();
    expect(output).toContain('[tool result: echo]');
    expect(output).toContain('Hello!');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('provider probe');
  });

  test('fails when the model ignores the requested tool', async () => {
    await expect(streamProbe({ ...options, tools: true }, { model: fakeModel() }, () => {})).rejects.toThrow('echo was not executed');
  });

  test('propagates provider errors without retrying', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => { throw new Error('fixture failure'); } });
    await expect(streamProbe(options, { model }, () => {})).rejects.toThrow('fixture failure');
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
