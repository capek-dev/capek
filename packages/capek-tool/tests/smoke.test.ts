import { describe, expect, test } from 'bun:test';
import { SHELL_DANGEROUS_COMMANDS } from '../src/index';
import type { ToolResult } from '../src/index';

describe('@capekai/tool', () => {
  test('resolves the tool contract', () => {
    expect(Array.isArray(SHELL_DANGEROUS_COMMANDS)).toBe(true);

    const result: ToolResult = {
      success: true,
      result: { captured: true },
      modelOutput: [{
        type: 'image',
        data: 'aGVsbG8=',
        mediaType: 'image/png',
      }],
    };
    expect(result.modelOutput?.[0].type).toBe('image');
  });
});
