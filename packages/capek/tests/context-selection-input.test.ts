import { describe, expect, test } from 'bun:test';
import type { MessageWithParts, Part, Preconfig } from '@capekai/types';
import { CONTEXT_SELECTION_LIMITS, type ContextSelectionInput } from '@capekai/core/composition';
import { assembleContext, validateContextAssemblyData } from '../src/context/assembler';
import { buildContextSelectionInput, captureContextRequest } from '../src/context/selection-input';

const preconfig = { id: 'test' } as Preconfig;
function entry(id: string, role: 'user' | 'assistant', text: string): MessageWithParts {
  const base = { id, sessionId: 'session', createdAt: 1 };
  return {
    message: role === 'user' ? { ...base, role } : {
      ...base, role, status: 'completed', modelId: 'test', providerId: 'test',
      tokens: { prompt: 0, completion: 0 }, cost: 0,
    },
    parts: [{ id: `${id}-text`, messageId: id, createdAt: 1, type: 'text', text }],
  };
}

describe('context selection projection', () => {
  test('projects only visible text, with the latest user request identity', () => {
    const user = entry('request', 'user', 'Fix the dialog');
    const hidden: Part[] = [
      { id: 'r', messageId: 'request', createdAt: 1, type: 'reasoning', text: 'private reasoning' },
      { id: 'i', messageId: 'request', createdAt: 1, type: 'image', url: 'secret image' },
      { id: 'f', messageId: 'request', createdAt: 1, type: 'file', url: 'secret file', mimeType: 'text/plain' },
      { id: 't', messageId: 'request', createdAt: 1, type: 'tool', callId: 'call', name: 'read', state: { status: 'pending', input: { secret: 'tool arguments' } } },
    ];
    user.parts.push(...hidden);
    const messages = [entry('old', 'user', 'Previous task'), user, entry('answer', 'assistant', 'Working')];
    const selection = buildContextSelectionInput('session', messages, false, captureContextRequest(messages));
    expect(selection.request).toEqual({ messageId: 'request', text: 'Fix the dialog', truncated: false });
    expect(selection.recentMessages.map(item => item.text)).toEqual(['Previous task', 'Fix the dialog', 'Working']);
    expect(JSON.stringify(selection)).not.toMatch(/private reasoning|secret image|secret file|tool arguments/);
  });

  test('preserves original request independently of post-compaction history', () => {
    const request = captureContextRequest([entry('original', 'user', 'Original task')]);
    const checkpoint = entry('checkpoint', 'assistant', 'Work done; continue testing');
    if (checkpoint.message.role === 'assistant') {
      checkpoint.message.summary = true;
      checkpoint.message.mode = 'compaction';
    }
    const selection = buildContextSelectionInput('session', [checkpoint], true, request);
    expect(selection.request).toEqual(request);
    expect(selection.checkpoint?.text).toBe('Work done; continue testing');
    expect(selection.recentMessages).toEqual([]);
    expect(selection.continuation).toBe(true);
    expect(captureContextRequest([checkpoint])).toBeUndefined();
  });

  test('bounds request, checkpoint, aggregate recent text and message count', () => {
    const messages = Array.from({ length: 20 }, (_, i) => entry(String(i), 'user', 'x'.repeat(2000)));
    const request = captureContextRequest([entry('large', 'user', 'x'.repeat(9000))]);
    const selection = buildContextSelectionInput('session', messages, false, request);
    expect(selection.request?.text).toHaveLength(CONTEXT_SELECTION_LIMITS.requestChars);
    expect(selection.request?.truncated).toBe(true);
    expect(selection.recentMessages.reduce((sum, item) => sum + item.text.length, 0)).toBe(CONTEXT_SELECTION_LIMITS.recentChars);
    const small = buildContextSelectionInput('session', messages.map((_, i) => entry(String(i), 'user', 'x')), false, undefined);
    expect(small.recentMessages).toHaveLength(CONTEXT_SELECTION_LIMITS.recentMessages);
    expect(small.recentMessages[0].messageId).toBe('8');
    const checkpoint = entry('checkpoint', 'assistant', 'c'.repeat(5000));
    if (checkpoint.message.role === 'assistant') Object.assign(checkpoint.message, { summary: true, mode: 'compaction' });
    expect(buildContextSelectionInput('session', [checkpoint], true, undefined).checkpoint).toMatchObject({
      text: 'c'.repeat(CONTEXT_SELECTION_LIMITS.checkpointChars), truncated: true,
    });
  });

  test('an attachment-only request does not reuse the previous task', () => {
    const selection = captureContextRequest([entry('old', 'user', 'Old task'), entry('new', 'user', '')]);
    expect(selection).toEqual({ messageId: 'new', text: '', truncated: false });
  });

  test.each(['retry_failed', 'compact_failed'] as const)('excludes %s attempts before allocating the recent budget', mode => {
    const user = entry('request', 'user', 'Fix the dialog');
    const answer = entry('answer', 'assistant', 'Keep this response');
    const failed = entry('failed', 'assistant', 'x'.repeat(CONTEXT_SELECTION_LIMITS.recentChars));
    if (failed.message.role === 'assistant') {
      failed.message.mode = mode;
      failed.message.status = 'error';
    }
    const messages = [user, answer, failed];
    const selection = buildContextSelectionInput('session', messages, false, captureContextRequest(messages));
    expect(selection.recentMessages.map(item => item.messageId)).toEqual(['request', 'answer']);
    expect(selection.recentMessages.every(item => !item.truncated)).toBe(true);
  });

  test('skips compaction triggers without losing attachment-only requests or checkpoints', () => {
    const user = entry('request', 'user', 'Fix the dialog');
    const trigger = entry('trigger', 'user', '');
    trigger.parts = [{ id: 'compaction', messageId: 'trigger', createdAt: 1, type: 'compaction', auto: true, overflow: false }];
    const checkpoint = entry('checkpoint', 'assistant', 'Continue testing the dialog');
    if (checkpoint.message.role === 'assistant') {
      checkpoint.message.summary = true;
      checkpoint.message.mode = 'compaction';
    }
    expect(captureContextRequest([user, trigger, checkpoint])).toEqual(captureContextRequest([user]));

    const history = [trigger, checkpoint];
    const selection = buildContextSelectionInput('session', history, true, captureContextRequest(history));
    expect(selection.request).toBeUndefined();
    expect(selection.checkpoint?.text).toBe('Continue testing the dialog');
    expect(selection.recentMessages).toEqual([]);

    const attachment = entry('attachment', 'user', '');
    attachment.parts = [{ id: 'image', messageId: 'attachment', createdAt: 1, type: 'image', url: 'image.png' }];
    expect(captureContextRequest([user, attachment, trigger])).toEqual({
      messageId: 'attachment', text: '', truncated: false,
    });
    expect(captureContextRequest([trigger])).toBeUndefined();
  });

  test('concurrent projections do not share mutable request state', async () => {
    const request = captureContextRequest([entry('original', 'user', 'Original task')]);
    const [a, b] = await Promise.all(['a', 'b'].map(async session =>
      buildContextSelectionInput(session, [entry(session, 'user', session)], false, request)));
    expect(a.sessionId).toBe('a');
    expect(b.sessionId).toBe('b');
    expect(a.request).not.toBe(b.request);
    expect(a.recentMessages).not.toBe(b.recentMessages);
  });
});

describe('assembly contract and cancellation', () => {
  const selectionInput: ContextSelectionInput = { sessionId: 's', recentMessages: [], continuation: false };
  test('keeps legacy data valid and passes new data through unchanged', () => {
    expect(validateContextAssemblyData({ preconfig })).toEqual({ preconfig });
    const data = { preconfig, selectionInput, signal: new AbortController().signal };
    expect(validateContextAssemblyData(data)).toBe(data);
  });

  test('rejects malformed and oversized advisory input', () => {
    for (const input of [null, [], {}, { ...selectionInput, continuation: 'yes' },
      { ...selectionInput, recentMessages: [null] },
      { ...selectionInput, recentMessages: [{ messageId: 'm', role: 'tool', text: '', truncated: false }] },
      { ...selectionInput, request: { messageId: 'r', text: 'x'.repeat(8001), truncated: false } },
      { ...selectionInput, checkpoint: { messageId: 'r', text: 'x', truncated: 'no' } },
    ]) expect(() => validateContextAssemblyData({ preconfig, selectionInput: input })).toThrow('invalid context selection input');
    expect(() => validateContextAssemblyData({ preconfig, signal: {} })).toThrow('AbortSignal');
  });

  test('does not invoke a selector after abort', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(assembleContext({ id: 'test', build: async () => { calls++; return ''; } }, {
      preconfig, signal: controller.signal,
    })).rejects.toThrow('cancelled');
    expect(calls).toBe(0);
  });

  test('stops waiting for a noncooperative selector and handles its late rejection', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string>();
    const result = assembleContext({ id: 'test', build: async data => {
      expect(data.signal).toBe(controller.signal);
      started.resolve();
      return pending.promise;
    } }, { preconfig, signal: controller.signal });
    await started.promise;
    controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');
    pending.reject(new Error('late selector failure'));
    await Promise.resolve();
  });
});
