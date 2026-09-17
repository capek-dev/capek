import type { MessageWithParts } from '@capekai/types';

export const CONTEXT_SELECTION_LIMITS = {
  requestChars: 8000,
  recentChars: 12000,
  recentMessages: 12,
  checkpointChars: 4000,
} as const;

export interface ContextRequest {
  readonly messageId: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ContextSelectionMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly truncated: boolean;
}

/** A text-only projection for host selection, not a replacement for model history. */
export interface ContextSelectionInput {
  readonly sessionId: string;
  readonly request?: ContextRequest;
  readonly recentMessages: readonly ContextSelectionMessage[];
  readonly checkpoint?: ContextRequest;
  readonly continuation: boolean;
}

function projectText(entry: MessageWithParts, limit: number): ContextRequest {
  let text = '';
  let truncated = false;
  for (const part of entry.parts) {
    if (part.type !== 'text' || !part.text) continue;
    const separator = text ? '\n' : '';
    const available = limit - text.length;
    const next = separator + part.text;
    text += next.slice(0, available);
    if (next.length > available) truncated = true;
  }
  return { messageId: entry.message.id, text, truncated };
}

/** Capture before compaction removes the original user message from effective history. */
export function captureContextRequest(messages: readonly MessageWithParts[]): ContextRequest | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    // Compaction control messages use the user role but are not user requests.
    if (entry.message.role === 'user' && !entry.parts.some(part => part.type === 'compaction')) {
      return projectText(entry, CONTEXT_SELECTION_LIMITS.requestChars);
    }
  }
  return undefined;
}

export function buildContextSelectionInput(
  sessionId: string,
  messages: readonly MessageWithParts[],
  continuation: boolean,
  request: ContextRequest | undefined,
): ContextSelectionInput {
  const recentMessages: ContextSelectionMessage[] = [];
  let remaining: number = CONTEXT_SELECTION_LIMITS.recentChars;
  let checkpoint: MessageWithParts | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const { message } = messages[index];
    if (message.role === 'assistant' && message.summary === true && message.mode === 'compaction') {
      checkpoint = messages[index];
      break;
    }
  }
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const entry = messages[index];
    if (entry === checkpoint || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) continue;
    // Match model-history exclusions before discarded attempts consume the budget.
    if (entry.message.role === 'assistant'
      && (entry.message.mode === 'retry_failed' || entry.message.mode === 'compact_failed')) continue;
    const projected = projectText(entry, remaining);
    if (!projected.text) continue;
    recentMessages.unshift({ ...projected, role: entry.message.role });
    remaining -= projected.text.length;
    if (recentMessages.length === CONTEXT_SELECTION_LIMITS.recentMessages) break;
  }
  return {
    sessionId,
    ...(request ? { request: { ...request, text: request.text.slice(0, CONTEXT_SELECTION_LIMITS.requestChars),
      truncated: request.truncated || request.text.length > CONTEXT_SELECTION_LIMITS.requestChars } } : {}),
    recentMessages,
    ...(checkpoint ? { checkpoint: projectText(checkpoint, CONTEXT_SELECTION_LIMITS.checkpointChars) } : {}),
    continuation,
  };
}
