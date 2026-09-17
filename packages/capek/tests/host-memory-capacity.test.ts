import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executeMemoryTool } from '../src/memory';
import { getMemoryGuidance, MEMORY_GUIDANCE } from '../src/memory/registry';
import { getHostGuidance } from '../src/runtime/host-guidance';
import { withRuntimeHost, type RuntimeHost } from '../src/runtime/host';
import { createAgentMemoryToolPayload, createMemoryToolPayload } from '../src/plugins/memory-domain';

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.tmp-memory-capacity-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
// These tests only consume the optional memory policy, not other host services.
const host = (memoryCharLimit?: () => number): RuntimeHost => ({ memoryCharLimit } as RuntimeHost);

test('50k writes and usage switch dynamically without truncation; preferences stay 1500', async () => {
  const root = await directory();
  let limit = 50000;
  await withRuntimeHost(host(() => limit), async () => {
    const result = await executeMemoryTool({ action: 'add', target: 'memory', content: 'x'.repeat(49998) }, root, 'none');
    expect(result.result?.usage).toEqual({ chars: 50000, limit: 50000 });
    expect(getMemoryGuidance()).toContain('workspace=50000');
    expect((await executeMemoryTool({ action: 'add', target: 'memory', content: 'overflow' }, root, 'none')).success).toBe(false);
    expect((await executeMemoryTool({ action: 'replace', target: 'memory', oldText: 'xxx', content: 'y'.repeat(49999) }, root, 'none')).success).toBe(false);
    expect((await executeMemoryTool({ action: 'add', target: 'user', content: 'u'.repeat(1498) }, root, 'none')).success).toBe(true);
    expect((await executeMemoryTool({ action: 'add', target: 'user', content: 'overflow' }, root, 'none')).success).toBe(false);
    limit = 2500;
    expect(getMemoryGuidance()).toContain('workspace=2500');
    expect((await executeMemoryTool({ action: 'list', target: 'memory' }, root, 'none')).result?.usage).toEqual({ chars: 50000, limit: 2500 });
    expect((await readFile(join(root, 'MEMORY.md'), 'utf8')).length).toBe(50000);
    expect((await executeMemoryTool({ action: 'replace', target: 'memory', oldText: 'xxx', content: 'compact' }, root, 'none')).success).toBe(true);
  });
});

test('invalid policies fall back and concurrent host scopes remain independent', async () => {
  const root = await directory();
  for (const callback of [undefined, () => 0, () => -1, () => NaN, () => Infinity, () => 1.5, () => { throw new Error('bad policy'); }]) {
    await withRuntimeHost(host(callback), async () => {
      expect((await executeMemoryTool({ action: 'list', target: 'memory' }, root, 'none')).result?.usage.limit).toBe(2500);
    });
  }
  const limits = await Promise.all([50000, 2500].map(limit => withRuntimeHost(host(() => limit), async () => {
    await Promise.resolve();
    return (await executeMemoryTool({ action: 'list', target: 'memory' }, root, 'none')).result?.usage.limit;
  })));
  expect(limits).toEqual([50000, 2500]);
});

test('host guidance follows live capacity while explicit overrides and default export stay intact', () => {
  let limit = 50000;
  withRuntimeHost(host(() => limit), () => {
    expect(getHostGuidance().memory).toContain('workspace=50000');
    expect(MEMORY_GUIDANCE).toContain('workspace=2500');
    limit = 2500;
    expect(getHostGuidance().memory).toBe(MEMORY_GUIDANCE);
  });
  withRuntimeHost({ ...host(() => 50000), guidance: { memory: 'Custom guidance' } }, () => {
    expect(getHostGuidance().memory).toBe('Custom guidance');
  });
});

test('workspace and agent payloads execute with live capacity after creation', async () => {
  const root = await directory();
  const context = { workspaceId: 'workspace', sessionId: 'session', workspacePath: root, agentDir: join(root, 'agent'), ask: async () => false };
  // Payload creation must not capture the capacity of the ambient host.
  const payloads = [createMemoryToolPayload(), createAgentMemoryToolPayload()];
  let limit = 50000;
  await withRuntimeHost(host(() => limit), async () => {
    for (const payload of payloads) {
      const result = await payload.execute({ action: 'add', target: 'memory', content: 'x'.repeat(3000) }, context);
      expect(result.usage).toEqual({ chars: 3002, limit: 50000 });
    }
    limit = 2500;
    for (const payload of payloads) {
      const result = await payload.execute({ action: 'add', target: 'memory', content: 'extra' }, context);
      expect(result.error).toContain('3002/2500 chars');
      expect((await payload.execute({ action: 'list', target: 'memory' }, context)).usage).toEqual({ chars: 3002, limit: 2500 });
      expect((await payload.execute({ action: 'remove', target: 'memory', oldText: 'xxx' }, context)).usage).toEqual({ chars: 0, limit: 2500 });
    }
  });
});

test('both tool descriptions defer to live usage instead of freezing a numeric capacity', () => {
  for (const payload of [createMemoryToolPayload(), createAgentMemoryToolPayload()]) {
    expect(payload.description).toContain('use list to check the current limit');
    expect(payload.description).not.toContain('2500');
  }
});
