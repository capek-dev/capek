import { AsyncLocalStorage } from 'node:async_hooks';
import type { Preconfig } from '@capekai/types';
import { CONTEXT_SELECTION_LIMITS, type ContextSelectionInput } from './selection-input';

/**
 * Context assembler contract and runtime accessors.
 *
 * The runtime core depends on this contract only: `getContextAssembler()`
 * resolves the assembler seeded for the active agent scope and `build()` is
 * the single entry point for ordered context assembly. The ordered
 * implementation lives in the plugin layer; the legacy fixed builder stays a
 * migration adapter and is never imported by the runtime core.
 */

/** Assembly options. Optional task context is advisory input for host selection;
 * the default assembler does not add it to the system prompt. */
export interface ContextAssemblyData {
  preconfig: Preconfig;
  workspacePath?: string;
  workspaceId?: string;
  additionalPaths?: string[];
  selfDelegationAvailable?: boolean;
  selectionInput?: ContextSelectionInput;
  signal?: AbortSignal;
}

/** The required runtime service contract for context assembly. */
export interface ContextAssembler {
  readonly id: string;
  build(data: ContextAssemblyData): Promise<string>;
}

/** Malformed assembly options fail predictably with this error instead of
 * surfacing unsafe property access deep inside a section provider. */
export class ContextAssemblyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Validates the typed assembly options contract. Returns the data unchanged
 * so callers can pass the validated value onward without casts. */
export function validateContextAssemblyData(data: unknown): ContextAssemblyData {
  if (typeof data !== 'object' || data === null) {
    throw new ContextAssemblyDataError('context assembly data must be an object');
  }
  const candidate = data as Partial<ContextAssemblyData>;
  const preconfig = candidate.preconfig;
  if (typeof preconfig !== 'object' || preconfig === null) {
    throw new ContextAssemblyDataError('context assembly data preconfig must be an object');
  }
  if (typeof (preconfig as { id?: unknown }).id !== 'string') {
    throw new ContextAssemblyDataError('context assembly data preconfig must declare a string id');
  }
  const systemPrompt = (preconfig as { systemPrompt?: unknown }).systemPrompt;
  if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
    throw new ContextAssemblyDataError(
      'context assembly data preconfig systemPrompt must be a string when present',
    );
  }
  for (const key of ['workspacePath', 'workspaceId'] as const) {
    const value = candidate[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ContextAssemblyDataError(
        `context assembly data ${key} must be a string when present`,
      );
    }
  }
  const additionalPaths = candidate.additionalPaths;
  if (
    additionalPaths !== undefined
    && (!Array.isArray(additionalPaths) || additionalPaths.some((entry) => typeof entry !== 'string'))
  ) {
    throw new ContextAssemblyDataError(
      'context assembly data additionalPaths must be an array of strings when present',
    );
  }
  const selfDelegationAvailable = candidate.selfDelegationAvailable;
  if (selfDelegationAvailable !== undefined && typeof selfDelegationAvailable !== 'boolean') {
    throw new ContextAssemblyDataError(
      'context assembly data selfDelegationAvailable must be a boolean when present',
    );
  }
  if (candidate.selectionInput !== undefined) validateSelectionInput(candidate.selectionInput);
  if (candidate.signal !== undefined && !(candidate.signal instanceof AbortSignal)) {
    throw new ContextAssemblyDataError('context assembly signal must be an AbortSignal');
  }
  return candidate as ContextAssemblyData;
}

function validateSelectionInput(value: unknown): void {
  const invalid = (): never => { throw new ContextAssemblyDataError('invalid context selection input'); };
  const record = (input: unknown): Record<string, unknown> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
    return input as Record<string, unknown>;
  };
  const text = (input: unknown, limit: number): Record<string, unknown> => {
    const item = record(input);
    if (typeof item.messageId !== 'string' || typeof item.text !== 'string'
      || item.text.length > limit || typeof item.truncated !== 'boolean') invalid();
    return item;
  };
  const input = record(value);
  if (typeof input.sessionId !== 'string' || typeof input.continuation !== 'boolean'
    || !Array.isArray(input.recentMessages)) invalid();
  const messages = input.recentMessages as unknown[];
  if (messages.length > CONTEXT_SELECTION_LIMITS.recentMessages) invalid();
  let chars = 0;
  for (const message of messages) {
    const item = text(message, CONTEXT_SELECTION_LIMITS.recentChars);
    if (item.role !== 'user' && item.role !== 'assistant') invalid();
    chars += (item.text as string).length;
  }
  if (chars > CONTEXT_SELECTION_LIMITS.recentChars) invalid();
  if (input.request !== undefined) text(input.request, CONTEXT_SELECTION_LIMITS.requestChars);
  if (input.checkpoint !== undefined) text(input.checkpoint, CONTEXT_SELECTION_LIMITS.checkpointChars);
}

/** Stop waiting even if a host selector ignores its signal. Late rejection is handled. */
export async function assembleContext(assembler: ContextAssembler, data: ContextAssemblyData): Promise<string> {
  validateContextAssemblyData(data);
  const signal = data.signal;
  signal?.throwIfAborted();
  if (!signal) return assembler.build(data);
  return new Promise<string>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return assembler.build(data);
    }).then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => { cleanup(); reject(error); });
  });
}

const scopedAssembler = new AsyncLocalStorage<ContextAssembler>();

/** Fallback used when no composed scope has seeded an assembler. The plugin
 * layer installs the fixed legacy builder adapter here, so consumers that
 * run outside `enterAgentScope` (the current Jean2 server path) keep the
 * exact pre-C3 behavior until they adopt the composed entry. */
let defaultAssembler: ContextAssembler | undefined;

export function setDefaultContextAssembler(assembler: ContextAssembler): void {
  defaultAssembler = assembler;
}

/** Resolves the assembler seeded for the active agent scope, falling back to
 * the default assembler for consumers that run outside a composed scope. */
export function getContextAssembler(): ContextAssembler {
  const assembler = scopedAssembler.getStore() ?? defaultAssembler;
  if (assembler === undefined) {
    throw new Error(
      'no ContextAssembler is active and no default assembler is installed',
    );
  }
  return assembler;
}

/** Seeds the active agent scope's assembler for the callback duration. */
export function withContextAssembler<T>(assembler: ContextAssembler, callback: () => T): T {
  return scopedAssembler.run(assembler, callback);
}
