import { readFileSync } from 'node:fs';

export { OcClient, type OcClientOptions, type OcSession } from './opencode.ts';
export {
  asRaw,
  extractPermissionAsk,
  extractQuestionAsk,
  extractTextDelta,
  extractToolUpdate,
  isSessionError,
  isTurnEnd,
  partSnapshotType,
  statusName,
  TURN_IDLE_STATUSES,
  type PermissionAsk,
  type QuestionAsk,
  type QuestionInfo,
  type QuestionOption,
  type RawEvent,
  type ToolUpdate,
} from './oc-events.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(service: string) {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(extra ? { extra } : {}) };
    (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(entry));
  }

  return {
    info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  };
}

export class SecretFileError extends Error {
  constructor(public readonly envKey: string, reason: string) {
    super(`${envKey}: ${reason}`);
    this.name = 'SecretFileError';
  }
}

function stripTrailingNewline(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

export function readRequiredSecretFile(envKey: string, env: Record<string, string | undefined> = Bun.env): string {
  const path = env[envKey]?.trim();
  if (!path) {
    throw new SecretFileError(envKey, 'secret file env var is not set');
  }

  let value: string;
  try {
    value = stripTrailingNewline(readFileSync(path, 'utf8'));
  } catch {
    throw new SecretFileError(envKey, 'secret file is unreadable');
  }

  if (!value) {
    throw new SecretFileError(envKey, 'secret file is empty');
  }

  return value;
}

export function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function splitMessage(content: string, maxLength: number): string[] {
  if (!content) return [];
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;
    const beforeSplit = remaining.slice(0, splitIndex);
    const codeBlockStarts = (beforeSplit.match(/```/g) || []).length;
    const inCodeBlock = codeBlockStarts % 2 === 1;

    if (inCodeBlock) {
      const newlineIndex = remaining.lastIndexOf('\n', splitIndex);
      if (newlineIndex > maxLength / 2) splitIndex = newlineIndex;
    } else {
      const doubleNewline = remaining.lastIndexOf('\n\n', splitIndex);
      const singleNewline = remaining.lastIndexOf('\n', splitIndex);
      if (doubleNewline > maxLength / 2) splitIndex = doubleNewline + 2;
      else if (singleNewline > maxLength / 2) splitIndex = singleNewline + 1;
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    const chunkCodeBlocks = (chunk.match(/```/g) || []).length;
    if (chunkCodeBlocks % 2 === 1) {
      chunk += '\n```';
      const match = chunk.match(/```(\w+)?/);
      const lang = match?.[1] || '';
      remaining = '```' + lang + '\n' + remaining;
    }

    chunks.push(chunk.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

type SessionTask = {
  run: () => Promise<void>;
  onQueued?: () => Promise<void>;
};

type SessionState = {
  processing: boolean;
  queue: SessionTask[];
};

export class ConversationQueue {
  private states = new Map<string, SessionState>();

  isProcessing(sessionKey: string): boolean {
    return this.states.get(sessionKey)?.processing ?? false;
  }

  queuedCount(sessionKey: string): number {
    return this.states.get(sessionKey)?.queue.length ?? 0;
  }

  clear(sessionKey: string): number {
    const state = this.states.get(sessionKey);
    if (!state) return 0;

    const dropped = state.queue.length;
    state.queue.length = 0;

    if (!state.processing) {
      this.states.delete(sessionKey);
    }

    return dropped;
  }

  async runOrQueue(sessionKey: string, task: SessionTask): Promise<'started' | 'queued'> {
    const state = this.states.get(sessionKey) ?? { processing: false, queue: [] };
    this.states.set(sessionKey, state);

    if (state.processing) {
      state.queue.push(task);
      try {
        await task.onQueued?.();
      } catch {
      }
      return 'queued';
    }

    state.processing = true;
    try {
      await task.run();
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }

    return 'started';
  }

  private async drain(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state || state.processing) return;

    const next = state.queue.shift();
    if (!next) {
      this.states.delete(sessionKey);
      return;
    }

    state.processing = true;
    try {
      await next.run();
    } catch {
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }
  }
}
